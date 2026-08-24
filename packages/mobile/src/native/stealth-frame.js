// Чистый фрейминг stealth-туннеля (без node:tls/fs) — для React Native.
// 1:1 совместим с packages/transport/src/stealth.js (тот же формат кадра и ключ),
// чтобы мобильный клиент говорил с тем же relay, что и десктоп.
import {randomBytes} from '@noble/hashes/utils';
import {chacha20poly1305} from '@noble/ciphers/chacha';
import {hkdf} from '@noble/hashes/hkdf';
import {sha256} from '@noble/hashes/sha256';

export function frameKey(psk) {
  return hkdf(
    sha256,
    new TextEncoder().encode(psk),
    new Uint8Array(32),
    new TextEncoder().encode('prizrak/stealth-frame'),
    32,
  );
}

// Скрытый auth-токен (16 байт), которым клиент доказывает право на туннель.
export function authToken(psk) {
  return sha256(new TextEncoder().encode('prizrak/auth/' + psk)).slice(0, 16);
}

const MAX_FRAME = 16 * 1024 * 1024;

export function encodeFrame(key, payload) {
  const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const pad = randomBytes(1 + (randomBytes(1)[0] % 64));
  const inner = new Uint8Array(4 + p.length + pad.length);
  new DataView(inner.buffer).setUint32(0, p.length);
  inner.set(p, 4);
  inner.set(pad, 4 + p.length);

  const nonce = randomBytes(12);
  const ct = chacha20poly1305(key, nonce).encrypt(inner);
  const body = new Uint8Array(nonce.length + ct.length);
  body.set(nonce, 0);
  body.set(ct, nonce.length);

  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

// Декодер потока кадров. Работает на Uint8Array-чанках (не зависит от Buffer).
export function makeFrameDecoder(key, onPayload) {
  let buf = new Uint8Array(0);
  const concat = (a, b) => {
    const o = new Uint8Array(a.length + b.length);
    o.set(a, 0);
    o.set(b, a.length);
    return o;
  };
  return chunk => {
    const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    buf = concat(buf, c);
    while (buf.length >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
      if (len > MAX_FRAME) throw new Error('кадр слишком большой (' + len + ')');
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len).slice(); // копия: subarray делит буфер
      const nonce = body.subarray(0, 12);
      const ct = body.subarray(12);
      const inner = chacha20poly1305(key, nonce).decrypt(ct);
      const plen = new DataView(inner.buffer, inner.byteOffset).getUint32(0);
      onPayload(inner.subarray(4, 4 + plen));
    }
  };
}
