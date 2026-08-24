// stealth.js
// ──────────────────────────────────────────────────────────────────────────
// Stealth-транспорт Prizrak: несёт медиа/данные звонка ВНУТРИ обычного TLS,
// так что для DPI это неотличимо от посещения HTTPS-сайта.
//
// Идеи заимствованы у VLESS+Reality (лучшее, что сейчас работает против ТСПУ):
//   1. Настоящий TLS 1.3 наружу — никакой самопальной обфускации, которую
//      можно зафингерпринтить. На проводе — валидные TLS-записи (type 0x17).
//   2. Probe-resistance: клиент доказывает право на туннель СКРЫТЫМ токеном
//      уже ВНУТРИ шифрованного канала. Кто постучался без токена (активное
//      зондирование цензора) — получает настоящую веб-страницу-обманку и всё.
//   3. Никаких STUN/DTLS-сигнатур: сигналинг и медиа идут единым потоком,
//      магических байтов на проводе нет.
//
// ⚠️  Прототип: демонстрирует ПРИНЦИП. Для прода нужен настоящий Reality-режим
//     (реальный SNI живого сайта, uTLS-фингерпринт браузера, XTLS-Vision против
//     TLS-in-TLS). См. docs/ARCHITECTURE.md, раздел про транспорт.
// ──────────────────────────────────────────────────────────────────────────
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from '@noble/hashes/utils';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

const __dir = dirname(fileURLToPath(import.meta.url));
const CERT_DIR = join(__dir, '..', 'certs');

// Секрет туннеля (в проде — X25519 + shortId как в Reality). Здесь — общий PSK.
export function frameKey(psk) {
  return hkdf(sha256, new TextEncoder().encode(psk), new Uint8Array(32),
    new TextEncoder().encode('prizrak/stealth-frame'), 32);
}
// Скрытый auth-токен, которым клиент доказывает право на туннель ВНУТРИ TLS.
export function authToken(psk) {
  return Buffer.from(sha256(new TextEncoder().encode('prizrak/auth/' + psk)).slice(0, 16));
}

// ── Обфусцированный фрейминг ────────────────────────────────────────────────
// [4 байта длины][AEAD(nonce||ct)] — со случайным паддингом, чтобы скрыть
// характерную длину аудиопакетов (защита от статистического DPI по размерам).
// ВАЖНО: длина — 32-битная. Видео-keyframe часто >64 КБ, а 16-битная длина
// (макс 65535) переполнялась → рассинхрон потока → relay рвал сокет. Теперь до 4 ГБ.
const MAX_FRAME = 16 * 1024 * 1024; // защитный предел: не буферим мусор от зондов
export function encodeFrame(key, payload) {
  const pad = randomBytes(1 + (randomBytes(1)[0] % 64)); // 1..64 байт мусора
  const inner = new Uint8Array(4 + payload.length + pad.length);
  new DataView(inner.buffer).setUint32(0, payload.length);
  inner.set(payload, 4);
  inner.set(pad, 4 + payload.length);

  const nonce = randomBytes(12);
  const ct = chacha20poly1305(key, nonce).encrypt(inner);
  const body = new Uint8Array(nonce.length + ct.length);
  body.set(nonce, 0); body.set(ct, nonce.length);

  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return Buffer.from(out);
}

export function makeFrameDecoder(key, onPayload) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME) throw new Error('кадр слишком большой (' + len + ')'); // зонд/мусор → выше по стеку закроют сокет
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      const nonce = body.subarray(0, 12);
      const ct = body.subarray(12);
      const inner = chacha20poly1305(key, nonce).decrypt(ct);
      const plen = new DataView(inner.buffer, inner.byteOffset).getUint32(0);
      onPayload(Buffer.from(inner.subarray(4, 4 + plen)));
    }
  };
}

// Правдоподобная страница-обманка для активного зондирования цензором.
const DECOY_PAGE =
  'HTTP/1.1 200 OK\r\nServer: nginx\r\nContent-Type: text/html; charset=utf-8\r\n' +
  'Cache-Control: max-age=600\r\nContent-Length: 122\r\n\r\n' +
  '<!doctype html><html><head><title>Static CDN</title></head>' +
  '<body><h1>It works</h1><p>Edge node online.</p></body></html>';

// ── Сервер stealth-туннеля ──────────────────────────────────────────────────
export function createStealthServer({ psk, onFrame, onProbe }) {
  const key = frameKey(psk);
  const AUTH = sha256(new TextEncoder().encode('prizrak/auth/' + psk)).slice(0, 16);
  const options = {
    key: readFileSync(join(CERT_DIR, 'key.pem')),
    cert: readFileSync(join(CERT_DIR, 'cert.pem')),
    minVersion: 'TLSv1.2',
  };
  const server = tls.createServer(options, (socket) => {
    // ctx — состояние ЭТОГО подключения (одно на сокет). Раньше reply-функция
    // создавалась заново на каждый кадр, и вызывающий код не мог опознать
    // подключение — состояние терялось между кадрами.
    const ctx = { socket };
    const reply = (resp) => { try { socket.write(encodeFrame(key, resp)); } catch {} };
    socket.on('close', () => { try { ctx.onClose && ctx.onClose(); } catch {} });
    const decode = makeFrameDecoder(key, (payload) => onFrame && onFrame(payload, reply, ctx));

    socket.once('data', (first) => {
      // Первый чанк должен начинаться с зашифрованного auth-токена внутри TLS.
      // Нет токена → это зонд: отдаём обманку и закрываемся (probe-resistance).
      if (first.length < 16 || !first.subarray(0, 16).equals(Buffer.from(AUTH))) {
        onProbe && onProbe();
        socket.write(DECOY_PAGE);
        socket.end();
        return;
      }
      ctx.authed = true;
      const rest = first.subarray(16);
      const safeDecode = (c) => { try { decode(c); } catch { socket.destroy(); } }; // мусор/зонд не роняет процесс
      if (rest.length) safeDecode(rest);
      socket.on('data', safeDecode);
    });
    socket.on('error', () => {});
  });
  return server;
}

// ── Клиент stealth-туннеля ──────────────────────────────────────────────────
export function connectStealth({ host, port, servername, psk, onFrame }) {
  const key = frameKey(psk);
  const AUTH = sha256(new TextEncoder().encode('prizrak/auth/' + psk)).slice(0, 16);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host, port,
      servername,                 // SNI: в проде — домен живого сайта прикрытия
      rejectUnauthorized: false,  // демо: самоподписанный сертификат
    }, () => {
      socket.write(Buffer.from(AUTH)); // скрытый токен внутри уже поднятого TLS
      const decode = makeFrameDecoder(key, (payload) => onFrame && onFrame(payload));
      // Мусор в потоке (напр. клиент с неверным PSK получил страницу-обманку) не должен ронять
      // процесс: молча закрываем сокет.
      socket.on('data', (c) => { try { decode(c); } catch { socket.destroy(); } });
      resolve({
        sendFrame: (payload) => socket.write(encodeFrame(key, payload)),
        close: () => socket.end(),
        socket,
      });
    });
    socket.on('error', reject);
  });
}
