// Мобильный движок звонка: транспорт (stealth-туннель к relay) + SRTP + нативный
// звук (Opus). Формат медиа-кадров 1:1 совместим с десктопом (packChunk/packConfig
// поверх WebCodecs), поэтому телефон ↔ десктоп созваниваются напрямую.
import {NativeModules, NativeEventEmitter, Platform} from 'react-native';
import {connectStealth} from './stealth-rn';
import {protectPacket, unprotectPacket, JitterBuffer} from './srtp';
import {randomBytes, hexToBytes} from '../lib/crypto/index.js';

const {PrizrakAudio, PrizrakVideo} = NativeModules;
const audioEvents = PrizrakAudio ? new NativeEventEmitter(PrizrakAudio) : null;
const videoEvents = PrizrakVideo ? new NativeEventEmitter(PrizrakVideo) : null;

// ── Упаковка кадров (тот же формат, что desktop renderer app.js) ────────────
const _te = new TextEncoder();
const _td = new TextDecoder();

function b64ToU8(b) {
  const bin = global.atob(b);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function u8ToB64(u) {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return global.btoa(s);
}

function packChunk(kind, isKey, timestamp, data) {
  const out = new Uint8Array(10 + data.length);
  out[0] = kind === 'v' ? 3 : 1;
  out[1] = isKey ? 1 : 0;
  new DataView(out.buffer).setFloat64(2, timestamp || 0, true);
  out.set(data, 10);
  return out;
}
function packConfig(kind, cfg) {
  const json = _te.encode(JSON.stringify(cfg));
  const out = new Uint8Array(1 + json.length);
  out[0] = kind === 'v' ? 2 : 0;
  out.set(json, 1);
  return out;
}

export class MobileCall {
  constructor({callId, mediaKey, relay, video}) {
    this.callId = callId;
    this.mediaKey = mediaKey instanceof Uint8Array ? mediaKey : hexToBytes(mediaKey);
    this.relay = relay;
    this.video = !!video;
    this.conn = null;
    this.idx = 0;
    const s = randomBytes(4);
    this.ssrc = new DataView(s.buffer, s.byteOffset).getUint32(0);
    this._audioSub = null;
    this._videoSub = null;
    this._videoCfgSub = null;
    this._sentAudioCfg = false;
    this._sentVideoCfg = false;
    this._vidx = 0;
    this._remoteVideo = {w: 640, h: 480}; // размеры входящего видео (из config)
    // Джиттер собирает медиа-payload'ы в порядке; далее разбираем по типу.
    this.jitter = new JitterBuffer(payload => this._onMediaPayload(payload));
  }

  async connect() {
    this.conn = await connectStealth({
      host: this.relay.host,
      port: this.relay.port,
      servername: 'cdn.example-static.net',
      psk: this.relay.psk || 'prizrak-relay',
      onFrame: payload => {
        try {
          this.jitter.push(unprotectPacket(this.mediaKey, payload));
        } catch {}
      },
    });
    // Присоединиться к звонку по callId (первый кадр — управляющий).
    this.conn.sendFrame(_te.encode(JSON.stringify({callId: this.callId})));
    return this;
  }

  // Запустить захват микрофона (и камеры для видеозвонка).
  async startMedia() {
    if (!PrizrakAudio) throw new Error('Нативный аудиомодуль недоступен');
    await PrizrakAudio.start();
    this._audioSub = audioEvents.addListener('PrizrakOpusFrame', b64 => {
      try {
        const opus = b64ToU8(b64);
        if (!this._sentAudioCfg) {
          this._sendMedia(
            packConfig('a', {codec: 'opus', sampleRate: 48000, numberOfChannels: 1}),
          );
          this._sentAudioCfg = true;
        }
        const ts = (this.idx * 20000) >>> 0; // микросекунды (как timestamp WebCodecs)
        this._sendMedia(packChunk('a', true, ts, opus));
      } catch {}
    });
    if (this.video && PrizrakVideo) await this.startVideo();
  }

  async startVideo() {
    if (!PrizrakVideo || !videoEvents) return;
    // Размеры кадра сообщает нативный модуль (config), шлём packConfig('v') собеседнику.
    this._videoCfgSub = videoEvents.addListener('PrizrakVideoConfig', dim => {
      try {
        const [w, h] = String(dim).split('x').map(Number);
        this._localVideo = {w, h};
        this._sendMedia(packConfig('v', {codec: 'vp8', codedWidth: w, codedHeight: h}));
        this._sentVideoCfg = true;
      } catch {}
    });
    this._videoSub = videoEvents.addListener('PrizrakVideoFrame', s => {
      try {
        const key = s.charAt(0) === 'K';
        const vp8 = b64ToU8(s.slice(1));
        if (!this._sentVideoCfg && this._localVideo) {
          this._sendMedia(
            packConfig('v', {codec: 'vp8', codedWidth: this._localVideo.w, codedHeight: this._localVideo.h}),
          );
          this._sentVideoCfg = true;
        }
        const ts = (this._vidx++ * 66000) >>> 0;
        this._sendMedia(packChunk('v', key, ts, vp8));
      } catch {}
    });
    try {
      await PrizrakVideo.startCapture('front');
    } catch (e) {
      // видео не поднялось — звонок продолжается как аудио
    }
  }

  _sendMedia(bytes) {
    if (!this.conn) return;
    const idx = this.idx++;
    const frame = protectPacket(this.mediaKey, {
      idx,
      timestamp: (idx * 20) >>> 0,
      ssrc: this.ssrc,
      payload: bytes,
    });
    this.conn.sendFrame(frame);
  }

  // Разбор входящего медиа-payload'а (packChunk/packConfig от собеседника).
  _onMediaPayload(payload) {
    const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (!p.length) return;
    const type = p[0];
    if (type === 1) {
      // аудио-чанк: Opus-кадр с байта 10 → нативное воспроизведение
      const data = p.subarray(10);
      if (PrizrakAudio) PrizrakAudio.playFrame(u8ToB64(data));
    } else if (type === 0) {
      // аудио-конфиг (opus) — на телефоне декодер фиксированный (48к моно), игнор
    } else if (type === 3) {
      // видео-чанк VP8: key = p[1], данные с байта 10 → нативный декодер → remote surface
      if (PrizrakVideo) {
        const key = p[1] === 1;
        const data = p.subarray(10);
        PrizrakVideo.decodeFrame(u8ToB64(data), key, this._remoteVideo.w, this._remoteVideo.h);
      }
    } else if (type === 2) {
      // видео-конфиг: {codec:'vp8', codedWidth, codedHeight}
      try {
        const cfg = JSON.parse(_td.decode(p.subarray(1)));
        if (cfg.codedWidth) this._remoteVideo = {w: cfg.codedWidth, h: cfg.codedHeight};
      } catch {}
    }
  }

  setMuted(m) {
    if (PrizrakAudio) PrizrakAudio.setMuted(!!m);
  }

  async switchCamera() {
    try {
      PrizrakVideo && (await PrizrakVideo.switchCamera());
    } catch {}
  }

  async hangup() {
    try {
      this._audioSub && this._audioSub.remove();
      this._videoSub && this._videoSub.remove();
      this._videoCfgSub && this._videoCfgSub.remove();
    } catch {}
    this._audioSub = this._videoSub = this._videoCfgSub = null;
    try {
      PrizrakAudio && (await PrizrakAudio.stop());
    } catch {}
    try {
      PrizrakVideo && (await PrizrakVideo.stopCapture());
    } catch {}
    try {
      this.jitter.flush();
    } catch {}
    try {
      this.conn && this.conn.close();
    } catch {}
    this.conn = null;
  }
}

export const CALLS_SUPPORTED = !!PrizrakAudio && Platform.OS === 'android';
export const VIDEO_SUPPORTED = !!PrizrakVideo && Platform.OS === 'android';
