// socks.js — локальный прокси клиента Призрака (SOCKS5 + HTTP на одном порту).
//
// Слушает 127.0.0.1 внутри устройства. На каждое соединение приложения поднимает
// двухпрыжковую цепочку relay→exit (client-tunnel.js) и качает байты туда-обратно.
// Браузер/система направляются на этот прокси — и весь их трафик идёт через
// Призрак. Наружу устройства прокси НЕ выходит: по сети идёт только наш протокол.
//
// ВАЖНО: порт понимает ДВА протокола, определяя их по первому байту соединения:
//   • 0x05  → SOCKS5 (Firefox/приложения с поддержкой SOCKS, tun2socks).
//   • ASCII → HTTP-прокси (CONNECT для HTTPS + absolute-URI для HTTP).
// Это ключево для Windows/macOS: СИСТЕМНЫЙ прокси там — HTTP, а не SOCKS. Раньше
// на 10808 был только SOCKS5, и системный HTTP-прокси не работал ни с чем.
//
// Это «прокси-режим» маскировки: работает без нативного tun. Полный перехват
// ВСЕГО трафика ОС — отдельный нативный шаг (utun/Wintun/VpnService).

import net from 'node:net';
import { openTunnel } from './client-tunnel.js';

/**
 * @param {object} p
 * @param {object} p.order  подписанный ордер Банка {relay,exit,...}
 * @param {object} p.relay  {host,port,pub} — прямой режим без Банка
 * @param {object} p.exit   {host,port,pub}
 * @param {string} p.host   адрес прослушивания (по умолчанию 127.0.0.1)
 * @param {number} p.port   порт прокси (по умолчанию 1080)
 * @param {function} p.log
 */
export function createSocks({ order, relay, exit, host = '127.0.0.1', port = 1080, log = () => {}, _openTunnel = openTunnel } = {}) {
  // Ордер Банка (реле+выход внутри). В прямом режиме без Банка принимаем relay+exit.
  const ord = order || { relay, exit };
  const dial = _openTunnel;                 // подменяется в тестах
  const stats = { active: 0, total: 0, failed: 0 };

  const server = net.createServer((client) => {
    client.on('error', () => {});
    // Смотрим первый байт: 0x05 → SOCKS5, иначе → HTTP-прокси.
    client.once('data', (first) => {
      if (!first || !first.length) { client.destroy(); return; }
      if (first[0] === 0x05) handleSocks5(client, first);
      else handleHttp(client, first);
    });
  });

  // ── Общая часть: поднять туннель к dest и склеить с сокетом приложения ──────
  async function pipeThrough(client, dest, firstPayload /* Buffer|null: байты, ушедшие ДО туннеля */) {
    stats.total++;
    const tun = await dial({ order: ord, dest });
    stats.active++;
    tun.onData((bytes) => { try { client.write(Buffer.from(bytes)); } catch {} });
    tun.onClose(() => { stats.active = Math.max(0, stats.active - 1); try { client.end(); } catch {} });
    client.on('data', (d) => tun.write(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
    client.on('close', () => tun.close());
    client.on('error', () => tun.close());
    if (firstPayload && firstPayload.length) tun.write(new Uint8Array(firstPayload.buffer, firstPayload.byteOffset, firstPayload.byteLength));
    return tun;
  }

  // ── SOCKS5 ──────────────────────────────────────────────────────────────────
  function handleSocks5(client, greeting) {
    if (greeting[0] !== 0x05) { client.destroy(); return; }
    client.write(Buffer.from([0x05, 0x00])); // версия 5, метод 0 (без авторизации)
    client.once('data', async (req) => {
      if (!req || req[0] !== 0x05 || req[1] !== 0x01) { socksReply(client, 0x07); return; } // только CONNECT
      const atyp = req[3];
      let dhost, off;
      if (atyp === 0x01) { dhost = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`; off = 8; }
      else if (atyp === 0x03) { const len = req[4]; dhost = req.slice(5, 5 + len).toString('utf8'); off = 5 + len; }
      else if (atyp === 0x04) { dhost = ipv6(req.slice(4, 20)); off = 20; }
      else { socksReply(client, 0x08); return; } // тип адреса не поддержан
      const dport = req.readUInt16BE(off);
      try {
        await pipeThrough(client, { host: dhost, port: dport }, null);
        socksReply(client, 0x00); // успех
      } catch (e) {
        stats.failed++; log('туннель не поднялся: ' + e.message);
        socksReply(client, 0x05); // отказ соединения
      }
    });
  }

  function socksReply(client, code) {
    try { client.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch {}
    if (code !== 0x00) try { client.destroy(); } catch {}
  }

  // ── HTTP-прокси (CONNECT + absolute-URI) ─────────────────────────────────────
  function handleHttp(client, firstChunk) {
    let buf = firstChunk;
    const onMore = (d) => { buf = Buffer.concat([buf, d]); tryParse(); };
    let parsing = false;

    const tryParse = () => {
      if (parsing) return;
      const headEnd = buf.indexOf('\r\n\r\n');
      const lineEnd = buf.indexOf('\r\n');
      if (lineEnd < 0) { if (buf.length > 65536) client.destroy(); return; } // ждём первую строку
      const firstLine = buf.slice(0, lineEnd).toString('latin1');
      const m = /^([A-Z]+)\s+(\S+)\s+HTTP\/(\d\.\d)$/.exec(firstLine);
      if (!m) { parsing = true; client.off('data', onMore); httpFail(client, 400, 'Bad Request'); return; }
      const method = m[1], target = m[2];

      if (method === 'CONNECT') {
        // target = host:port. Нужна только первая строка; ждём конец заголовков.
        if (headEnd < 0) { if (buf.length > 65536) { parsing = true; client.off('data', onMore); httpFail(client, 400, 'Bad Request'); } return; }
        parsing = true; client.off('data', onMore);
        const [dhost, dportStr] = splitHostPort(target, 443);
        const leftover = buf.slice(headEnd + 4); // байты после CONNECT-заголовков — уже часть TLS
        (async () => {
          try {
            await pipeThrough(client, { host: dhost, port: dportStr }, leftover.length ? leftover : null);
            client.write(Buffer.from('HTTP/1.1 200 Connection Established\r\nProxy-agent: Prizrak\r\n\r\n', 'latin1'));
          } catch (e) { stats.failed++; log('CONNECT не поднялся: ' + e.message); httpFail(client, 502, 'Bad Gateway'); }
        })();
        return;
      }

      // Обычный HTTP с absolute-URI: GET http://host[:port]/path HTTP/1.1
      if (headEnd < 0) { if (buf.length > 262144) { parsing = true; client.off('data', onMore); httpFail(client, 400, 'Bad Request'); } return; } // ждём все заголовки
      const um = /^https?:\/\/([^\/]+)(\/[^\s]*)?$/i.exec(target);
      if (!um) { parsing = true; client.off('data', onMore); httpFail(client, 400, 'Bad Request'); return; }
      parsing = true; client.off('data', onMore);
      const [dhost, dport] = splitHostPort(um[1], 80);
      const path = um[2] || '/';
      // Переписываем строку в origin-form (проксируем как обычный сервер).
      const rest = buf.slice(lineEnd); // включает \r\n и все заголовки + возможное тело
      const rewritten = Buffer.concat([Buffer.from(`${method} ${path} HTTP/${m[3]}`, 'latin1'), rest]);
      (async () => {
        try { await pipeThrough(client, { host: dhost, port: dport }, rewritten); }
        catch (e) { stats.failed++; log('HTTP не поднялся: ' + e.message); httpFail(client, 502, 'Bad Gateway'); }
      })();
    };

    client.on('data', onMore);
    tryParse();
  }

  function httpFail(client, code, text) {
    try { client.write(Buffer.from(`HTTP/1.1 ${code} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, 'latin1')); } catch {}
    try { client.end(); } catch {}
  }

  return {
    server, stats,
    listen: (cb) => server.listen(port, host, cb),
    close: (cb) => server.close(cb),
    address: () => `${host}:${port}`,
  };
}

function splitHostPort(s, defPort) {
  s = String(s || '');
  if (s[0] === '[') { const i = s.indexOf(']'); const h = s.slice(1, i); const p = s.slice(i + 2); return [h, p ? parseInt(p, 10) : defPort]; } // [ipv6]:port
  const i = s.lastIndexOf(':');
  if (i > 0 && s.indexOf(':') === i) { return [s.slice(0, i), parseInt(s.slice(i + 1), 10) || defPort]; } // host:port
  return [s, defPort];
}

function ipv6(buf) {
  const p = []; for (let i = 0; i < 16; i += 2) p.push(buf.readUInt16BE(i).toString(16)); return p.join(':');
}
