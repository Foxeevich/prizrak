// call.js — клиентская сторона звонка (аудио/видео) БЕЗ STUN.
// Медиа идёт SRTP-подобными пакетами (20мс Opus-кадры) с низкой задержкой,
// защищёнными AEAD на ключе звонка, ВНУТРИ stealth-туннеля к relay.
import { connectStealth } from '../../transport/src/stealth.js';
import { protectPacket, unprotectPacket, JitterBuffer } from '../../transport/src/srtp.js';
import { randomBytes } from '../../crypto/src/index.js';

export function parseRelay(relayUrl) {
  const s = String(relayUrl).replace(/^stealth:\/\//, '');
  const [host, port] = s.split(':');
  return { host: host || '127.0.0.1', port: Number(port || 8810) };
}

// Управляющий подканал (совместимо с мобилкой Packet.java): CTRL=7, подтипы PLI/NACK/REPORT/CAND.
const CTRL = 7, CTRL_PLI = 1, CTRL_NACK = 2, CTRL_REPORT = 3, CTRL_CAND = 4;

export class Call {
  constructor({ callId, mediaKey, relay, onMedia, onRaw, onCtrl }) {
    this.callId = callId; this.mediaKey = mediaKey; this.relay = relay;
    this.onMedia = onMedia; this.onRaw = onRaw; this.onCtrl = onCtrl;
    this.conn = null; this.idx = 0; this.rawIn = 0; this.badIn = 0; // диагностика приёма
    const s = randomBytes(4); this.ssrc = new DataView(s.buffer, s.byteOffset).getUint32(0);
    // Управляющие пакеты — на ОТДЕЛЬНОМ ssrc/idx (как у мобилки), иначе их idx сталкивались бы
    // с медиа-idx в джиттере и рвали/задерживали видео. Перехватываем их ДО джиттера.
    this.ctrlSsrc = (this.ssrc + 1) >>> 0; this.ctrlIdx = 0;
    this.jitter = new JitterBuffer((payload) => this.onMedia && this.onMedia(payload));
  }

  async connect() {
    this.conn = await connectStealth({
      host: this.relay.host, port: this.relay.port, servername: 'cdn.example-static.net',
      psk: this.relay.psk || 'prizrak-relay',
      // onRaw считает КАЖДЫЙ кадр, пришедший с relay (до расшифровки/джиттера) — это
      // отличает «пакеты вообще не доходят» (relay/файрвол) от «доходят, но не
      // расшифровываются/не собираются» (ключ/джиттер).
      onFrame: (payload) => {
        this.rawIn++; try { this.onRaw && this.onRaw(); } catch {}
        try {
          const pkt = unprotectPacket(this.mediaKey, payload);
          // CTRL (PLI/NACK/REPORT/CAND) — не в джиттер (иначе idx-коллизия с медиа), а в обработчик.
          if (pkt.payload && pkt.payload.length && pkt.payload[0] === CTRL) { try { this.onCtrl && this.onCtrl(pkt.payload); } catch {} return; }
          this.jitter.push(pkt);
        } catch { this.badIn++; /* чужой/битый пакет */ }
      },
    });
    this.conn.sendFrame(Buffer.from(JSON.stringify({ callId: this.callId }))); // присоединиться к звонку
    return this;
  }

  /** Отправить 20мс-кадр медиа (Opus). SRTP-защита + отправка через relay. */
  sendMedia(payload) {
    if (!this.conn) throw new Error('звонок не подключён');
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const idx = this.idx++;
    const frame = protectPacket(this.mediaKey, { idx, timestamp: (idx * 20) >>> 0, ssrc: this.ssrc, payload: bytes });
    this.conn.sendFrame(frame);
  }

  /** Управляющий пакет (отдельные ssrc/idx). */
  sendCtrl(payload) {
    if (!this.conn) return;
    const idx = this.ctrlIdx++;
    const frame = protectPacket(this.mediaKey, { idx, timestamp: idx >>> 0, ssrc: this.ctrlSsrc, payload });
    try { this.conn.sendFrame(frame); } catch {}
  }
  /** Запросить у собеседника ключевой кадр (PLI) — напр., пока не получили опорный кадр. */
  requestKeyframe() { this.sendCtrl(new Uint8Array([CTRL, CTRL_PLI])); }

  hangup() { try { this.jitter.flush(); } catch {} try { this.conn?.close(); } catch {} this.conn = null; }
}
