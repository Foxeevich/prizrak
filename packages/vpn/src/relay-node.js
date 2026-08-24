// relay-node.js — промежуточный узел (реле/приманка) в РФ.
//
// Это ПЕРВЫЙ прыжок. Клиент из РФ приходит сюда (на российский адрес — обычный
// паттерн для ТСПУ), а реле слепо форвардит на зарубежный выход. Реле:
//   • обслуживает сайт-личину зондам (GET → настоящий сайт);
//   • поднимает сессию A с клиентом («Тень»);
//   • по LINK дозванивается до выхода, поднимает сессию B и прокидывает
//     внутреннее рукопожатие C ВСЛЕПУЮ;
//   • дальше полнодуплексно перекладывает непрозрачные кадры C: A↔B.
//
// Что реле ЗНАЕТ: IP клиента и адрес выхода. Чего НЕ знает: назначение и
// содержимое (ключей сессии C у него нет). Поэтому реле безопасно ставить в РФ:
// в его логах нет ни сайтов назначения, ни расшифрованного трафика.

import net from 'node:net';
import { nodeHandshake, clientHandshake, clientComplete } from './shadow.js';
import { makeSite } from './site.js';
import { attachBreath, looksHttp } from './wire.js';
import { packCtrl, readCtrl, OP } from './estafeta.js';
import { serveSiteRaw } from './http-site.js';
import { verifyOrder } from './order.js';

const dec = new TextDecoder();

/**
 * @param {object} p
 * @param {object} p.keys — {privateKey, publicKey} реле (hex X25519).
 * @param {Array}  p.exits — разрешённые выходы [{id, host, port, pub}]. Реле
 *   дозванивается ТОЛЬКО до них (защита от превращения в открытый прокси).
 * @param {object} p.site — сайт-личина.
 * @param {function} p.log — логгер (msg) => void.
 */
export function createRelay({ keys, bankPub = null, exits = [], site = makeSite(), log = () => {}, reportExit = () => {} } = {}) {
  if (!keys || !keys.privateKey) throw new Error('нужны ключи узла');
  const seen = new Map();
  const stats = { conns: 0, tunnels: 0, probes: 0, up: 0, denied: 0 };
  const exitByKey = new Map(exits.map((e) => [`${e.host}:${e.port}`, e]));

  const server = net.createServer((socket) => handle(socket));

  function handle(socket) {
    stats.conns++;
    const rip = socket.remoteAddress || '?';
    log('← соединение ' + rip);
    let phase = 'hs';
    let sessA = null;
    let exitConn = null;      // канал к выходу (сессия B)

    const wire = attachBreath(socket, { onFrame: (f) => onFrame(f).catch(() => {}), onClose: cleanup });
    socket.once('data', (buf) => {
      if (buf.length && looksHttp(buf[0])) { stats.probes++; log('  HTTP-проба ' + rip + ' → отдал сайт'); serveSiteRaw(socket, site); wire.close(); }
    });

    async function onFrame(frame) {
      if (phase === 'hs') {
        const r = nodeHandshake(keys.privateKey, frame, { seen });
        if (!r.ok) { log('  A-рукопожатие не наше (' + rip + ') → сайт'); serveSiteRaw(socket, site); wire.close(); return; }   // не наш — отдаём сайт
        sessA = r.session; wire.send(r.reply); phase = 'up'; stats.tunnels++; stats.up++;
        log('  A-рукопожатие OK (' + rip + '), туннель поднят');
        return;
      }
      let ctrl; try { ctrl = readCtrl(sessA.open(frame)); } catch { return; }
      const { op, body } = ctrl;

      if (op === OP.LINK) {
        const j = safeJson(body);
        if (!j || !j.exit) { wire.send(sessA.seal(packCtrl(OP.LINK_FAIL, { reason: 'нет выхода' }))); return; }
        // Оплата: если задан ключ Банка — пускаем только по валидному ордеру.
        let exit;
        if (bankPub) {
          const v = verifyOrder(j.order, bankPub, { expectPub: keys.publicKey, role: 'relay' });
          if (!v.ok) { stats.denied++; log('  ОРДЕР ОТКЛОНЁН: ' + v.reason); wire.send(sessA.seal(packCtrl(OP.LINK_FAIL, { reason: 'ордер: ' + v.reason }))); return; }
          exit = { host: j.order.exit.host, port: j.order.exit.port, pub: j.order.exit.pub };
          log('  ордер принят, выход ' + exit.host + ':' + exit.port);
        } else {
          exit = exitByKey.get(`${j.exit.host}:${j.exit.port}`) || exits[0];
        }
        if (!exit || !exit.pub) { wire.send(sessA.seal(packCtrl(OP.LINK_FAIL, { reason: 'выход не разрешён' }))); return; }
        try {
          exitConn = await dialExit(exit, Uint8Array.from(j.hs), j.order, (innerCt) => {
            // кадр C от выхода → клиенту (через A), реле не читает содержимое
            try { wire.send(sessA.seal(packCtrl(OP.DATA, innerCt))); } catch {}
          }, () => { try { wire.send(sessA.seal(packCtrl(OP.CLOSE, {}))); } catch {} });
          wire.send(sessA.seal(packCtrl(OP.LINK_OK, { hs: [...exitConn.innerReply] })));
          log('  выход подключён → LINK_OK клиенту');
          try { if (j.order && j.order.exit) reportExit(j.order.exit.id, true); } catch {}
        } catch (e) {
          log('выход недоступен: ' + e.message);
          wire.send(sessA.seal(packCtrl(OP.LINK_FAIL, { reason: 'выход недоступен' })));
          try { if (j.order && j.order.exit) reportExit(j.order.exit.id, false); } catch {}
        }
        return;
      }
      if (op === OP.DATA) {                 // кадр C от клиента → выходу, вслепую
        if (exitConn) exitConn.forward(body);
        return;
      }
      if (op === OP.CLOSE) cleanup();
    }

    function cleanup() { try { exitConn && exitConn.close(); } catch {} }
  }

  /**
   * Дозвониться до выхода: поднять сессию B (реле как «Тень»-клиент), прокинуть
   * внутреннее рукопожатие C и вернуть канал полнодуплексного форварда.
   */
  function dialExit(exit, innerHs, order, onInner, onClose) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: exit.host, port: exit.port });
      let phase = 'hs';
      let sessB = null;
      const c = clientHandshake(exit.pub);
      let settled = false;
      const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error('таймаут выхода')); socket.destroy(); } }, 12000);

      const wire = attachBreath(socket, {
        onFrame: (f) => {
          if (phase === 'hs') {
            try { sessB = clientComplete(c.state, f); } catch { return; }
            phase = 'link';
            // Прокидываем C-рукопожатие + ордер (выход тоже проверит оплату).
            wire.send(sessB.seal(packCtrl(OP.LINK, { hs: [...innerHs], order })));
            return;
          }
          let ctrl; try { ctrl = readCtrl(sessB.open(f)); } catch { return; }
          if (ctrl.op === OP.LINK_OK && !settled) {
            settled = true; clearTimeout(to);
            const j = safeJson(ctrl.body);
            resolve({
              innerReply: Uint8Array.from(j.hs),
              forward: (innerCt) => { try { wire.send(sessB.seal(packCtrl(OP.DATA, innerCt))); } catch {} },
              close: () => wire.close(),
            });
            return;
          }
          if (ctrl.op === OP.DATA) onInner(ctrl.body);       // кадр C от выхода
          if (ctrl.op === OP.CLOSE) onClose && onClose();
        },
        onClose: () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('выход закрыл соединение')); } onClose && onClose(); },
      });
      socket.on('connect', () => wire.send(c.message));       // рукопожатие B
      socket.on('error', (e) => { if (!settled) { settled = true; clearTimeout(to); reject(e); } });
    });
  }

  return { server, stats, exits, listen: (port, host, cb) => server.listen(port, host, cb), close: (cb) => server.close(cb) };
}

function safeJson(u8) { try { return JSON.parse(dec.decode(u8)); } catch { return null; } }
