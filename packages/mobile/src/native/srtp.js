// srtp.js — SRTP-подобная защита медиапакетов + jitter-буфер.
// Каждый 20мс-кадр Opus идёт отдельным пакетом (низкая задержка), защищён AEAD
// на ключе звонка. Всё это едет ВНУТРИ stealth-туннеля — DPI видит обычный HTTPS.
//
// Пакет на проводе:  [ HEADER(12) ][ AEAD_ciphertext ]
//   HEADER = idx(uint32) | timestamp(uint32) | ssrc(uint32)   (в открытом виде,
//   аутентифицируется как AAD — нужно для переупорядочивания).
//   nonce  = ssrc(4) | idx(4) | 0x00000000   (уникален на пакет).
import { chacha20poly1305 } from '@noble/ciphers/chacha';

const HEADER = 12;
function nonceFor(ssrc, idx) {
  const n = new Uint8Array(12); const v = new DataView(n.buffer);
  v.setUint32(0, ssrc >>> 0); v.setUint32(4, idx >>> 0); return n;
}

export function protectPacket(key, { idx, timestamp = 0, ssrc, payload }) {
  const header = new Uint8Array(HEADER); const dv = new DataView(header.buffer);
  dv.setUint32(0, idx >>> 0); dv.setUint32(4, timestamp >>> 0); dv.setUint32(8, ssrc >>> 0);
  const ct = chacha20poly1305(key, nonceFor(ssrc, idx), header).encrypt(payload);
  const out = new Uint8Array(HEADER + ct.length); out.set(header, 0); out.set(ct, HEADER);
  return Buffer.from(out);
}

export function unprotectPacket(key, packet) {
  if (packet.length < HEADER) throw new Error('короткий пакет');
  const header = packet.subarray(0, HEADER); const dv = new DataView(header.buffer, header.byteOffset, HEADER);
  const idx = dv.getUint32(0), timestamp = dv.getUint32(4), ssrc = dv.getUint32(8);
  const payload = chacha20poly1305(key, nonceFor(ssrc, idx), header).decrypt(packet.subarray(HEADER));
  return { idx, timestamp, ssrc, payload };
}

/**
 * Простой jitter-буфер: переупорядочивает пакеты по idx, отбрасывает опоздавшие
 * и дубликаты, отдаёт payload'ы В ПОРЯДКЕ. depth — макс. глубина ожидания дырки.
 */
export class JitterBuffer {
  constructor(onOrdered, { depth = 8 } = {}) {
    this.onOrdered = onOrdered; this.depth = depth;
    this.buf = new Map(); this.lastEmitted = -1;
  }
  push(pkt) {
    const { idx } = pkt;
    if (idx <= this.lastEmitted) return;              // опоздал/дубликат
    this.buf.set(idx, pkt);
    if (this.buf.size > this.depth) {                 // буфер переполнен — прыгаем через дырку
      const min = Math.min(...this.buf.keys());
      this.lastEmitted = min - 1;
    }
    this._drain();
  }
  _drain() {
    let next = this.lastEmitted + 1;
    while (this.buf.has(next)) {
      const p = this.buf.get(next); this.buf.delete(next); this.lastEmitted = next; next++;
      try { this.onOrdered(p.payload, p); } catch {}
    }
  }
  flush() { for (const idx of [...this.buf.keys()].sort((a, b) => a - b)) { const p = this.buf.get(idx); this.buf.delete(idx); this.lastEmitted = idx; try { this.onOrdered(p.payload, p); } catch {} } }
}
