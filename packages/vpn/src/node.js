// node.js — выходной узел Prizrak VPN.
//
// Снаружи это обычный HTTPS-сайт: клиент приходит по TLS на 443, стучится
// скрытым токеном ВНУТРИ шифрованного канала (stealth-транспорт Призрака).
// Кто пришёл без токена — цензор с активным зондированием — получает
// страницу-обманку и уходит ни с чем.
//
// Внутри туннеля — мультиплексор: десятки TCP-соединений в одном TLS-канале.
// Узел открывает их наружу и качает байты туда-обратно, считая трафик по
// билетам (для наград оператору).
//
// Чего узел НЕ знает: кто вы (в билете только непрозрачный id) и что вы
// передаёте по HTTPS-сайтам (это ещё один слой TLS внутри нашего).
import net from 'node:net';
import { createStealthServer } from '../../transport/src/stealth.js';
import { T, packFrame, unpackFrame, asJson } from './protocol.js';
import { verifyTicket, ticketId } from './ticket.js';

const MAX_STREAMS = 256;        // на одно подключение
const DIAL_TIMEOUT = 12000;
const IDLE_MS = 5 * 60 * 1000;  // поток без байтов дольше — закрываем

// Не выпускаем в локальную сеть: узел не должен становиться сканером чужой LAN.
function isPrivateHost(h) {
  const s = String(h || '');
  if (/^(localhost|::1|0\.0\.0\.0)$/i.test(s)) return true;
  if (/^127\./.test(s) || /^10\./.test(s) || /^192\.168\./.test(s) || /^169\.254\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^(f[cd][0-9a-f]{2}:|fe80:)/i.test(s)) return true;
  return false;
}

/**
 * Запустить выходной узел.
 *  psk           — секрет туннеля (публичный параметр узла, как UUID у VLESS)
 *  trustedIssuers— чьи билеты принимаем (hex Ed25519). Пусто = пускать всех (открытый узел)
 *  onUsage       — колбэк учёта: {ticket, up, down} для наград оператору
 *  allowPrivate  — пускать в локальную сеть (только для тестов)
 */
export function startVpnNode({ port = 443, host = '0.0.0.0', psk, trustedIssuers = [], onUsage, allowPrivate = false } = {}) {
  if (!psk) throw new Error('нужен psk узла');
  const stats = { conns: 0, streams: 0, up: 0, down: 0, since: Date.now() };
  const usage = new Map(); // ticketId → {up, down}

  const bump = (tid, up, down) => {
    if (!tid) return;
    const u = usage.get(tid) || { up: 0, down: 0 };
    u.up += up; u.down += down; usage.set(tid, u);
    stats.up += up; stats.down += down;
  };

  const server = createStealthServer({
    psk,
    onProbe: () => {},                       // зонд цензора — молча отдали обманку
    onFrame: (payload, reply) => {
      // Состояние подключения держим на самом reply (одно подключение = один reply).
      let st = server._conns.get(reply);
      if (!st) { st = { authed: false, tid: null, streams: new Map() }; server._conns.set(reply, st); stats.conns++; }

      let f;
      try { f = unpackFrame(payload); } catch { return; }

      // ── Авторизация билетом ──
      if (f.type === T.HELLO) {
        const body = asJson(f.body) || {};
        if (!trustedIssuers.length) { st.authed = true; st.tid = 'open'; return reply(packFrame(T.HELLO_OK, 0, { open: true })); }
        const v = verifyTicket(body.ticket, trustedIssuers);
        if (!v.ok) return reply(packFrame(T.HELLO_FAIL, 0, { error: v.error }));
        st.authed = true;
        st.tid = ticketId(v.ticket);
        st.limitBytes = Number(v.ticket.bytes) || 0;
        return reply(packFrame(T.HELLO_OK, 0, { tier: v.ticket.tier, exp: v.ticket.exp, bytes: st.limitBytes }));
      }
      if (!st.authed) return reply(packFrame(T.HELLO_FAIL, 0, { error: 'сначала HELLO с билетом' }));

      // ── Открыть поток наружу ──
      if (f.type === T.OPEN) {
        const req = asJson(f.body) || {};
        const id = f.streamId;
        if (st.streams.size >= MAX_STREAMS) return reply(packFrame(T.OPEN_FAIL, id, { error: 'слишком много потоков' }));
        if (!allowPrivate && isPrivateHost(req.host)) return reply(packFrame(T.OPEN_FAIL, id, { error: 'локальные адреса запрещены' }));
        const sock = net.connect({ host: req.host, port: Number(req.port) || 443 });
        sock.setTimeout(IDLE_MS);
        const dialT = setTimeout(() => { try { sock.destroy(); } catch {} }, DIAL_TIMEOUT);
        st.streams.set(id, sock); stats.streams++;
        sock.on('connect', () => { clearTimeout(dialT); reply(packFrame(T.OPEN_OK, id, {})); });
        sock.on('data', (chunk) => { bump(st.tid, 0, chunk.length); reply(packFrame(T.DATA, id, new Uint8Array(chunk))); });
        const done = (err) => {
          clearTimeout(dialT);
          if (!st.streams.has(id)) return;
          st.streams.delete(id);
          reply(packFrame(err ? T.OPEN_FAIL : T.CLOSE, id, err ? { error: String(err.message || err) } : {}));
        };
        sock.on('error', done);
        sock.on('timeout', () => { try { sock.destroy(); } catch {} });
        sock.on('close', () => done(null));
        return;
      }

      // ── Байты в открытый поток ──
      if (f.type === T.DATA) {
        const sock = st.streams.get(f.streamId);
        if (!sock) return;
        bump(st.tid, f.body.length, 0);
        try { sock.write(Buffer.from(f.body)); } catch {}
        return;
      }
      if (f.type === T.CLOSE) {
        const sock = st.streams.get(f.streamId);
        if (sock) { st.streams.delete(f.streamId); try { sock.end(); } catch {} }
        return;
      }
      if (f.type === T.PING) return reply(packFrame(T.PONG, 0, {}));
    },
  });
  server._conns = new Map();

  // Отчёт по трафику (для наград оператору) — раз в минуту, если задан колбэк.
  let timer = null;
  if (onUsage) {
    timer = setInterval(() => {
      for (const [tid, u] of usage) { if (u.up || u.down) { onUsage({ ticket: tid, up: u.up, down: u.down }); usage.set(tid, { up: 0, down: 0 }); } }
    }, 60000);
    timer.unref?.();
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({
      port: server.address().port,
      server,
      stats: () => ({ ...stats, uptimeMs: Date.now() - stats.since }),
      close: () => { if (timer) clearInterval(timer); try { server.close(); } catch {} },
    }));
  });
}
