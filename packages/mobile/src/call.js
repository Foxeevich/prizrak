// Менеджер звонка на мобилке: сигналинг (через E2E-канал клиента) + управление
// медиа-движком (MobileCall). Один активный звонок за раз.
import {randomBytes, bytesToHex} from './lib/crypto/index.js';
import {MobileCall, CALLS_SUPPORTED} from './native/call-rn';

function parseRelay(url) {
  const s = String(url || '').replace(/^stealth:\/\//, '');
  const [host, port] = s.split(':');
  return {host: host || '127.0.0.1', port: Number(port || 8810), psk: 'prizrak-relay'};
}

export {CALLS_SUPPORTED};

export class CallManager {
  constructor(client, onState) {
    this.client = client;
    this.onState = onState; // ({phase, peer, media, muted})
    this.reset();
  }
  reset() {
    this.phase = 'idle'; // idle|outgoing|incoming|active
    this.peer = null;
    this.callId = null;
    this.media = 'audio';
    this.mediaKey = null;
    this.offer = null;
    this.call = null;
    this.muted = false;
  }
  _emit() {
    this.onState &&
      this.onState({
        phase: this.phase,
        peer: this.peer,
        media: this.media,
        muted: this.muted,
      });
  }

  // Исходящий звонок. ВАЖНО: сначала шлём offer (собеседник звенит), транспорт к
  // relay поднимаем в фоне — иначе недоступный relay блокировал бы весь звонок.
  async place(peer, video = false) {
    if (!CALLS_SUPPORTED) throw new Error('Звонки не поддерживаются на этом устройстве');
    if (this.phase !== 'idle') return;
    await this.client.ensureRelay();
    if (!this.client.relayUrl) throw new Error('Сервер не сообщил relay для звонков');
    this.peer = peer;
    this.media = video ? 'video' : 'audio';
    this.callId = bytesToHex(randomBytes(8));
    this.mediaKey = randomBytes(32);
    this.phase = 'outgoing';
    this._emit();
    // 1) Сигнал — сразу, чтобы у собеседника зазвонило.
    try {
      await this.client.callOffer(peer, {
        callId: this.callId,
        mediaKey: bytesToHex(this.mediaKey),
        media: this.media,
      });
    } catch (e) {
      this.end();
      throw e;
    }
    // 2) Транспорт — в фоне (не блокирует звонок; ошибку покажем как статус).
    this.call = new MobileCall({
      callId: this.callId,
      mediaKey: this.mediaKey,
      relay: parseRelay(this.client.relayUrl),
      video,
    });
    this._connectPromise = this._connectWithTimeout(this.call);
    this._connectPromise.catch(() => {});
  }

  _connectWithTimeout(call, ms = 12000) {
    return Promise.race([
      call.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('relay недоступен (таймаут)')), ms)),
    ]);
  }

  // Пришёл сигнал звонка (из onEvent клиента).
  handleSignal(ev) {
    const c = ev && ev.call;
    if (!c) return;
    if (c.event === 'offer') {
      if (this.phase !== 'idle') {
        // заняты — сразу отбой
        this.client.hangupCall(ev.from, c.callId).catch(() => {});
        return;
      }
      this.peer = ev.from;
      this.callId = c.callId;
      this.media = c.media === 'video' ? 'video' : 'audio';
      this.offer = c;
      this.phase = 'incoming';
      this._emit();
    } else if (c.event === 'answer') {
      if (this.phase === 'outgoing' && c.callId === this.callId) {
        this._goActive();
      }
    } else if (c.event === 'hangup') {
      if (c.callId === this.callId) this.end(true);
    }
  }

  // Принять входящий. Сразу отвечаем answer + переходим в active, транспорт/медиа
  // поднимаем в фоне (не блокируем UI).
  async accept() {
    if (this.phase !== 'incoming' || !this.offer) return;
    this.call = new MobileCall({
      callId: this.callId,
      mediaKey: this.offer.mediaKey,
      relay: parseRelay(this.offer.relayUrl),
      video: this.media === 'video',
    });
    await this.client.callAnswer(this.peer, this.callId).catch(() => {});
    this._connectPromise = this._connectWithTimeout(this.call);
    this._goActive();
  }

  async _goActive() {
    this.phase = 'active';
    this._emit();
    try {
      await (this._connectPromise || this.call.connect()); // дождаться транспорта
      await this.call.startMedia();
    } catch (e) {
      this.onState &&
        this.onState({
          phase: this.phase,
          peer: this.peer,
          media: this.media,
          muted: this.muted,
          error: e.message || String(e),
        });
    }
  }

  decline() {
    if (this.peer && this.callId) this.client.hangupCall(this.peer, this.callId).catch(() => {});
    this.end();
  }

  setMuted(m) {
    this.muted = !!m;
    this.call && this.call.setMuted(this.muted);
    this._emit();
  }

  switchCamera() {
    this.call && this.call.switchCamera && this.call.switchCamera();
  }

  // Завершить звонок. remote=true — инициатор завершения собеседник (не шлём hangup).
  end(remote = false) {
    if (!remote && this.peer && this.callId && this.phase !== 'idle') {
      this.client.hangupCall(this.peer, this.callId).catch(() => {});
    }
    try {
      this.call && this.call.hangup();
    } catch {}
    this.reset();
    this._emit();
  }
}
