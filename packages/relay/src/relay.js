// relay.js — медиа-ретранслятор для звонков БЕЗ STUN.
// ──────────────────────────────────────────────────────────────────────────
// Почему без STUN: оба собеседника подключаются к relay ИСХОДЯЩИМИ TLS-
// соединениями (stealth-туннель, неотличимый от HTTPS). Это проходит любой NAT
// и файрвол без пробивания портов и без STUN/ICE, а DPI видит обычный HTTPS.
//
// Что делает relay: спаривает два «плеча» звонка по callId и пересылает кадры
// между ними. Кадры уже зашифрованы E2E ключом звонка (mediaKey) — relay видит
// ТОЛЬКО ШИФРТЕКСТ и не может ни слушать, ни смотреть разговор.
// ──────────────────────────────────────────────────────────────────────────
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { frameKey, authToken, encodeFrame, makeFrameDecoder } from '../../transport/src/stealth.js';

const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'transport', 'certs');

export function createRelay({ psk = 'prizrak-relay', port = 0, host = '0.0.0.0' } = {}) {
  const key = frameKey(psk);
  const AUTH = authToken(psk);
  const calls = new Map(); // callId → Set<socket>

  // Страница-обманка для активного зондирования цензором (выглядит как обычный сайт).
  const DECOY = 'HTTP/1.1 200 OK\r\nServer: nginx\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: 61\r\n\r\n' +
    '<!doctype html><html><body><h1>It works</h1></body></html>';

  const server = tls.createServer(
    { key: readFileSync(join(CERT_DIR, 'key.pem')), cert: readFileSync(join(CERT_DIR, 'cert.pem')), minVersion: 'TLSv1.2' },
    (socket) => {
      let callId = null, authed = false, pre = Buffer.alloc(0);
      const kill = () => { try { socket.destroy(); } catch {} };
      const decode = makeFrameDecoder(key, (payload) => {
        if (callId === null) {
          // Первый кадр — управляющий: { callId }
          let id = null; try { id = JSON.parse(payload.toString()).callId; } catch { kill(); return; }
          if (!id) { kill(); return; }
          callId = id;
          if (!calls.has(callId)) calls.set(callId, new Set());
          calls.get(callId).add(socket);
          return;
        }
        // Остальные кадры — E2E-медиа: пересылаем другому плечу(ам) этого звонка.
        const peers = calls.get(callId);
        if (peers) for (const s of peers) if (s !== socket && !s.destroyed) { try { s.write(encodeFrame(key, payload)); } catch {} }
      });
      // ВАЖНО: любая ошибка разбора кадра (мусор/скан/зонд/чужой ключ) НЕ должна
      // ронять процесс — просто закрываем этот сокет.
      const safeDecode = (chunk) => { try { decode(chunk); } catch { kill(); } };

      socket.on('data', (chunk) => {
        if (authed) { safeDecode(chunk); return; }
        pre = Buffer.concat([pre, chunk]);
        if (pre.length < 16) return;                         // ждём минимум для проверки токена
        if (!pre.subarray(0, 16).equals(AUTH)) { try { socket.end(DECOY); } catch {} kill(); return; } // зонд → обманка
        authed = true;
        const rest = pre.subarray(16); pre = Buffer.alloc(0);
        if (rest.length) safeDecode(rest);
      });
      socket.on('error', () => {});
      socket.on('close', () => { if (callId && calls.has(callId)) { const s = calls.get(callId); s.delete(socket); if (!s.size) calls.delete(callId); } });
    },
  );
  server.on('error', () => {}); // не роняем процесс на ошибках сервера (напр. EADDRINUSE)
  server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch {} });

  return new Promise((resolve, reject) => {
    server.once('error', reject); // ошибка биндинга → отклоняем промис (server.js поймает)
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const p = server.address().port;
      console.log(`[relay] stealth-медиаретранслятор слушает :${p} (все интерфейсы)`);
      resolve({ server, port: p, calls });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createRelay({ psk: process.env.PRIZRAK_RELAY_PSK || 'prizrak-relay', port: Number(process.env.PRIZRAK_RELAY_PORT || 8810) });
}
