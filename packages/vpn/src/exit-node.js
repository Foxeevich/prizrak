// exit-node.js — выходной узел «Призрак-Транспорта» (конец цепочки).
//
// Принимает сессию (от реле по сессии B, либо напрямую), внутри поднимает
// сквозную сессию C с КЛИЕНТОМ и только он видит назначение. По C приходит
// мини-CONNECT: первый кадр {host,port}, дальше — байты к назначению; ответы
// назначения возвращаются тем же C.
//
// ВНИМАНИЕ: выходной узел светит СВОИМ IP в логах посещаемых сайтов. Ставить
// только туда, где это осознанно (заграничный VPS оператора). Реле (в РФ) —
// отдельный, безопасный: см. relay-node.js.

import net from 'node:net';
import { nodeHandshake } from './shadow.js';
import { makeSite } from './site.js';
import { attachBreath, looksHttp } from './wire.js';
import { packCtrl, readCtrl, OP } from './estafeta.js';
import { serveSiteRaw } from './http-site.js';
import { verifyOrder } from './order.js';

const dec = new TextDecoder();

/** Не выпускаем в приватные сети — узел не должен сканировать чужой LAN. */
function isPrivateHost(h) {
  const s = String(h || '');
  if (/^(localhost|::1|0\.0\.0\.0)$/i.test(s)) return true;
  if (/^127\./.test(s) || /^10\./.test(s) || /^192\.168\./.test(s) || /^169\.254\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^(f[cd][0-9a-f]{2}:|fe80:)/i.test(s)) return true;
  return false;
}

/**
 * @param {object} p
 * @param {object} p.keys — {privateKey, publicKey} узла (hex X25519).
 * @param {object} p.site — сайт-личина.
 * @param {boolean} p.allowPrivate — разрешить приватные адреса (только тесты).
 * @param {function} p.onUsage — учёт трафика {bytes} (для наград).
 */
export function createExit({ keys, bankPub = null, site = makeSite(), allowPrivate = false, onUsage, log = () => {} } = {}) {
  if (!keys || !keys.privateKey) throw new Error('нужны ключи узла');
  const seen = new Map();
  const stats = { conns: 0, sessions: 0, bytes: 0, denied: 0 };

  const server = net.createServer((socket) => handle(socket));

  function handle(socket) {
    stats.conns++;
    const rip = socket.remoteAddress || '?';
    log('← соединение ' + rip);
    let phase = 'hs';           // hs → up
    let sessB = null;           // сессия с тем, кто пришёл (реле или клиент)
    let sessC = null;           // сквозная с клиентом
    let dest = null;            // сокет к назначению
    let userId = null;          // из ордера (order.sub) — чей это трафик
    let used = 0;               // байт за это соединение (для учёта на пользователя)

    const wire = attachBreath(socket, { onFrame: (f) => onFrame(f).catch(() => {}), onClose: cleanup });
    socket.once('data', (buf) => { if (buf.length && looksHttp(buf[0])) { serveSiteRaw(socket, site); wire.close(); } });

    async function onFrame(frame) {
      if (phase === 'hs') {
        const r = nodeHandshake(keys.privateKey, frame, { seen });
        if (!r.ok) { log('  B-рукопожатие не наше (' + rip + ') → сайт'); serveSiteRaw(socket, site); wire.close(); return; }
        sessB = r.session; wire.send(r.reply); phase = 'up'; stats.sessions++;
        log('  B-сессия установлена (' + rip + ')');
        return;
      }
      const { op, body } = readCtrl(sessB.open(frame));
      if (op === OP.LINK) {                     // внутреннее рукопожатие C (от клиента, через реле)
        const j = JSON.parse(dec.decode(body));
        // Оплата: выход тоже проверяет ордер Банка (не про свой узел / просрочен → отказ).
        if (bankPub) {
          const v = verifyOrder(j.order, bankPub, { expectPub: keys.publicKey, role: 'exit' });
          if (!v.ok) { stats.denied++; log('  ОРДЕР ОТКЛОНЁН: ' + v.reason); wire.send(sessB.seal(packCtrl(OP.LINK_FAIL, { reason: v.reason }))); return; }
          userId = j.order && j.order.sub ? String(j.order.sub) : null;   // чей трафик
        }
        const inner = nodeHandshake(keys.privateKey, Uint8Array.from(j.hs), { seen });
        if (!inner.ok) { log('  внутреннее рукопожатие C неуспешно'); wire.send(sessB.seal(packCtrl(OP.LINK_FAIL, {}))); return; }
        sessC = inner.session;
        wire.send(sessB.seal(packCtrl(OP.LINK_OK, { hs: [...inner.reply] })));
        log('  сессия C с клиентом установлена → LINK_OK');
        return;
      }
      if (op === OP.DATA) {                      // кадр C: расшифровать может только клиент↔выход
        if (!sessC) return;
        const appBytes = sessC.open(body);
        onApp(appBytes);
        return;
      }
      if (op === OP.CLOSE) cleanup();
    }

    // Данные приложения из сессии C: первый кадр — CONNECT, дальше — байты.
    let connected = false, pending = [];
    function onApp(bytes) {
      if (!connected) {
        let req; try { req = JSON.parse(dec.decode(bytes)); } catch { return; }
        if (!req || !req.host || !req.port) return;
        if (!allowPrivate && isPrivateHost(req.host)) { sendC(enc('{"error":"private blocked"}')); return; }
        log('  CONNECT → ' + req.host + ':' + req.port);
        dest = net.connect({ host: req.host, port: req.port });
        dest.on('connect', () => { connected = true; log('  назначение подключено ' + req.host + ':' + req.port); for (const b of pending) dest.write(b); pending = []; });
        dest.on('data', (d) => { stats.bytes += d.length; used += d.length; sendC(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)); });
        dest.on('close', () => { try { wire.send(sessB.seal(packCtrl(OP.CLOSE, {}))); } catch {} });
        dest.on('error', (e) => { log('  ошибка назначения ' + req.host + ':' + req.port + ' → ' + e.message); });
      } else {
        stats.bytes += bytes.length; used += bytes.length;
        try { dest.write(Buffer.from(bytes)); } catch {}
      }
    }
    function sendC(bytes) { if (sessC && sessB) try { wire.send(sessB.seal(packCtrl(OP.DATA, sessC.seal(bytes)))); } catch {} }

    function cleanup() {
      try { dest && dest.destroy(); } catch {}
      // Отчёт по трафику пользователя (раз на соединение) — Банк копит на подписке.
      if (userId && used > 0) { try { onUsage && onUsage({ userId, bytes: used }); } catch {} used = 0; }
    }
  }

  return { server, stats, listen: (port, host, cb) => server.listen(port, host, cb), close: (cb) => server.close(cb) };
}

const enc = (s) => new TextEncoder().encode(s);
