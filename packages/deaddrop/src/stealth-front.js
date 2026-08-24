// stealth-front.js — Фаза 6d: стелс-фронт для узла-тайника.
// Заворачивает HTTP узла в тот же стелс-туннель, что и звонки homeserver'а (packages/transport):
//   • наружу — настоящий TLS 1.3, для DPI неотличим от обычного HTTPS-сайта;
//   • право на туннель клиент доказывает СКРЫТЫМ токеном (PSK) уже внутри TLS;
//   • probe-resistance: стук без токена (активное зондирование) → правдоподобная страница-обманка.
// Один фрейм = один HTTP-запрос (сырые байты); ответ узла возвращается фреймом. Узел при этом
// слушает обычный HTTP только на localhost, а наружу торчит лишь стелс-порт.
import net from 'node:net';
import { createStealthServer, connectStealth } from '../../transport/src/stealth.js';

// ── Фронт: принимает стелс-фреймы, проксирует на локальный HTTP-порт узла ──────
export function createStealthFront({ psk, target = { host: '127.0.0.1', port: 8820 }, onProbe } = {}) {
  return createStealthServer({
    psk,
    onProbe,
    onFrame: (payload, reply) => {
      // payload — сырой HTTP/1.1 запрос. Открываем свежее соединение к узлу и проксируем.
      const sock = net.connect(target.port, target.host, () => sock.write(payload));
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => reply(Buffer.concat(chunks)));
      sock.on('error', () => { try { reply(Buffer.from('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')); } catch {} });
    },
  });
}

// ── Клиент: fetch-подобный доступ к узлу ПОВЕРХ стелс-туннеля ──────────────────
// Узел всегда отвечает с Content-Length (без chunked), а мы шлём Connection: close,
// поэтому ответ парсится детерминированно.
function buildRequest(method, path, headers, body) {
  const h = ['Host: ' + (headers.host || 'cdn'), 'Connection: close'];
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== 'host') h.push(k + ': ' + v);
  const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
  if (method !== 'GET' && method !== 'HEAD') h.push('Content-Length: ' + bodyBuf.length);
  const head = `${method} ${path} HTTP/1.1\r\n` + h.join('\r\n') + '\r\n\r\n';
  return Buffer.concat([Buffer.from(head), bodyBuf]);
}
function parseResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) return { status: 0, headers: {}, body: Buffer.alloc(0) };
  const head = buf.subarray(0, sep).toString();
  const lines = head.split('\r\n');
  const status = Number((lines[0].split(' ')[1]) || 0);
  const headers = {};
  for (let i = 1; i < lines.length; i++) { const idx = lines[i].indexOf(':'); if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim(); }
  const body = buf.subarray(sep + 4);
  return { status, headers, body };
}

/**
 * stealthFetch(base, {psk, servername}) → fetch-подобная функция (url, opts) для узла за стелс-фронтом.
 * url — полный (берём path), либо путь. Возвращает { ok, status, json(), arrayBuffer(), text() }.
 */
export function stealthFetch(base, { psk, servername = 'cdn' } = {}) {
  const u = new URL(base);
  return async (url, opts = {}) => {
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    const method = (opts.method || 'GET').toUpperCase();
    const raw = buildRequest(method, path, opts.headers || {}, opts.body);
    const respBytes = await new Promise((resolve, reject) => {
      let done = false;
      connectStealth({ host: u.hostname, port: Number(u.port), servername, psk, onFrame: (resp) => { if (!done) { done = true; resolve(resp); } } })
        .then((conn) => { conn.sendFrame(raw); setTimeout(() => { if (!done) { done = true; try { conn.close(); } catch {}; reject(new Error('timeout')); } }, 8000); })
        .catch(reject);
    });
    const { status, body } = parseResponse(respBytes);
    return {
      ok: status >= 200 && status < 300, status,
      async json() { return JSON.parse(body.toString() || '{}'); },
      async text() { return body.toString(); },
      async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); },
    };
  };
}
