// hardening.js — Фаза 6 (базовая закалка): защита от анализа трафика и спама/DoS.
//   • padTo/unpad — паддинг полезной нагрузки до фиксированных «вёдер», чтобы длина сообщения
//     не утекала цензору по размеру блоба (все мелкие сообщения выглядят одинаково).
//   • powSolve/powVerify — лёгкий proof-of-work как admission-токен: чтобы положить блоб, нужно
//     найти nonce с H(msgId‖nonce), у которого ≥ bits старших нулевых бит. Флудить дорого.
//   • jitter — случайная задержка (антикорреляция во времени для poll/send).
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes, hexToBytes } from '@noble/hashes/utils';

// ── Паддинг до вёдер ──────────────────────────────────────────────────────────
// Формат: [4 байта реальной длины][данные][нули до границы ведра]. Вёдра растут ступенями,
// чтобы одинаково выглядели и мелкие текстовые сообщения, и средние.
const BUCKETS = [256, 512, 1024, 4096, 16384, 65536, 262144, 1048576];
export function bucketFor(n) {
  for (const b of BUCKETS) if (n <= b) return b;
  return Math.ceil(n / 1048576) * 1048576; // крупные — кратно 1 МБ
}
export function padTo(payload) {
  const p = payload instanceof Uint8Array ? payload : utf8ToBytes(String(payload));
  const total = bucketFor(p.length + 4);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, p.length);
  out.set(p, 4);
  return out; // хвост — нули (внутри шифра, снаружи не видно, но длина = ведро)
}
export function unpad(buf) {
  if (!buf || buf.length < 4) return buf || new Uint8Array(0);
  const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
  if (len > buf.length - 4) return buf.subarray(4); // защита от битого
  return buf.subarray(4, 4 + len);
}

// ── Proof-of-work admission ───────────────────────────────────────────────────
function leadingZeroBits(bytes) {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    let x = b, c = 0; while ((x & 0x80) === 0) { c++; x <<= 1; }
    return n + c;
  }
  return n;
}
const powHash = (msgId, nonce) => sha256(utf8ToBytes('prizrak/dd/pow/v1:' + msgId + ':' + nonce));
export function powVerify(msgId, nonce, bits) {
  if (!bits || bits <= 0) return true;
  if (typeof nonce !== 'string' && typeof nonce !== 'number') return false;
  return leadingZeroBits(powHash(String(msgId), String(nonce))) >= bits;
}
// Решить PoW (перебор nonce). start/max для тестируемости и предела.
export function powSolve(msgId, bits, { start = 0, max = 1e7 } = {}) {
  if (!bits || bits <= 0) return '0';
  for (let i = start; i < start + max; i++) if (leadingZeroBits(powHash(String(msgId), String(i))) >= bits) return String(i);
  throw new Error('pow: не найден nonce за ' + max + ' попыток');
}

// ── Джиттер (антикорреляция во времени) ───────────────────────────────────────
// Возвращает случайную задержку в [min, max] мс. Для poll/send, чтобы сгладить тайминги.
export function jitterMs(min = 0, max = 500, rnd = Math.random) { return Math.floor(min + rnd() * (max - min)); }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
