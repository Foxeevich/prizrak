// client.js — клиент Prizrak (v1.2).
// Личность (OpenPGP+prekeys) → регистрация/логин → E2E-сессии → чаты, группы,
// каналы, вложения/голосовые, кошелёк 👻, звонки без STUN, real-time (WebSocket).
import {
  createIdentity, createDeviceIdentity, publishPreKeys, verifyPreKeyBundle, startSession, acceptSession,
  serializeMessage, deserializeMessage,
  encryptBlob, decryptBlob, bytesToHex, hexToBytes, randomBytes, RatchetSession, fingerprintOf,
  pgpEncrypt, pgpDecrypt,
  deriveKeyFromPassword, sealJSON, openJSON,
  generateMnemonic, normalizeMnemonic, isValidMnemonic,
} from '../../crypto/src/index.js';
import { Call, parseRelay } from './call.js';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from '@noble/hashes/utils';

const DEFAULT_BANK = 'https://prizrak.paymoney.online';
// C2: стабильные порты для клиента. 443 первым (там маскировка под TLS), затем 8801,
// затем «почтовые» порты, которые в мире практически не блокируют.
export const CLIENT_PORTS = [443, 8801, 80, 993, 995, 587, 465, 143, 110, 25];

// Разобрать адрес сервера: вернуть { scheme?, host, port? }. Принимает
// «host», «host:port», «http(s)://host[:port]».
function parseServerInput(input) {
  let s = String(input || '').trim().replace(/\/+$/, '');
  let scheme = null;
  const m = s.match(/^(https?):\/\/(.+)$/i); if (m) { scheme = m[1].toLowerCase(); s = m[2]; }
  const hm = s.match(/^([^/:]+)(?::(\d+))?/);
  return { scheme, host: hm ? hm[1] : s, port: hm && hm[2] ? Number(hm[2]) : null };
}
function candidateUrls({ scheme, host, port }) {
  if (port) return [`${scheme || (port === 443 ? 'https' : 'http')}://${host}:${port}`];
  return CLIENT_PORTS.map((p) => `${p === 443 ? 'https' : 'http'}://${host}:${p}`);
}
async function probeConfig(url, timeoutMs = 3500) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url + '/_prizrak/client/v1/config', { signal: ctrl.signal });
    clearTimeout(t); return r.ok;
  } catch { return false; }
}

export class PrizrakClient {
  // C2: по «голому» адресу (без порта) найти рабочий порт — опрашиваем кандидатов
  // ПАРАЛЛЕЛЬНО и берём первый рабочий по приоритету. Явный порт — используем как есть.
  static async resolveBaseUrl(input) {
    const parsed = parseServerInput(input);
    const urls = candidateUrls(parsed);
    if (urls.length === 1) return urls[0];
    const oks = await Promise.all(urls.map(async (u) => (await probeConfig(u)) ? u : null));
    return oks.find(Boolean) || urls[0];
  }

  constructor({ name, userId, baseUrl, bankBase, deviceId }) {
    Object.assign(this, { name, userId, baseUrl });
    this.bankBase = bankBase || DEFAULT_BANK; // Банк Призраков (централизованный реестр валюты)
    this.deviceId = deviceId || null;         // MD1: id устройства (задаётся хостом; иначе одно-девайсный режим)
    this.identity = null; this.preKeys = null; this.token = null; this.isAdmin = false;
    this.deviceIdentity = null; this.devicePreKeys = null; // MD1: per-device ключи (подписаны PGP-корнем)
    this.sessions = new Map(); this.pendingHandshake = new Map();
    this.ws = null; this.relayUrl = null; this.cursor = 0; this.verified = {}; this.channelKeys = {};
    this._peerIdk = {};      // peerId → identityKey собеседника, под который построена сессия
  }

  async init() {
    this.identity = await createIdentity(this.name, this.userId);
    this.preKeys = await publishPreKeys(this.identity, 20);
    return this;
  }
  get fingerprint() { return this.identity.fingerprint; }

  // ── Сохранение/восстановление состояния (запоминание входа) ───────────────
  serializeState() {
    const idk = this.identity.identityKey, ps = this.preKeys.privateState;
    const sessions = {}; for (const [peer, r] of this.sessions) sessions[peer] = r.serialize();
    return {
      v: 1, name: this.name, userId: this.userId, baseUrl: this.baseUrl, bankBase: this.bankBase,
      token: this.token, isAdmin: this.isAdmin, relayUrl: this.relayUrl, cursor: this.cursor, verified: this.verified, channelKeys: this.channelKeys, peerIdk: this._peerIdk,
      pendingHandshake: Object.fromEntries(this.pendingHandshake),
      pgp: this.identity.pgp, fingerprint: this.identity.fingerprint,
      identityKey: { priv: bytesToHex(idk.priv), pub: bytesToHex(idk.pub) },
      publicBundle: this.preKeys.publicBundle,
      privateState: {
        signedPreKey: { priv: bytesToHex(ps.signedPreKey.priv), pub: bytesToHex(ps.signedPreKey.pub) },
        oneTimePreKeys: ps.oneTimePreKeys.map((o) => ({ id: o.id, priv: bytesToHex(o.priv), pub: bytesToHex(o.pub) })),
      },
      // MD2: ключи ЭТОГО устройства должны переживать перезапуск (иначе на рестарте
      // сменится device-ключ, и сообщения, зашифрованные на прежний, не расшифруются).
      deviceId: this.deviceId || null,
      device: (this.deviceIdentity && this.devicePreKeys) ? {
        identityKey: { priv: bytesToHex(this.deviceIdentity.identityKey.priv), pub: bytesToHex(this.deviceIdentity.identityKey.pub) },
        publicBundle: this.devicePreKeys.publicBundle,
        privateState: {
          signedPreKey: { priv: bytesToHex(this.devicePreKeys.privateState.signedPreKey.priv), pub: bytesToHex(this.devicePreKeys.privateState.signedPreKey.pub) },
          oneTimePreKeys: this.devicePreKeys.privateState.oneTimePreKeys.map((o) => ({ id: o.id, priv: bytesToHex(o.priv), pub: bytesToHex(o.pub) })),
        },
      } : null,
      sessions,
    };
  }
  // Развернуть сохранённые device-ключи (общие с account-PGP) — для fromState/adopt.
  static _deserDevice(dev, pgp, name, userId) {
    return {
      deviceIdentity: { name, userId, pgp, identityKey: { priv: hexToBytes(dev.identityKey.priv), pub: hexToBytes(dev.identityKey.pub) } },
      devicePreKeys: {
        publicBundle: dev.publicBundle,
        privateState: {
          signedPreKey: { priv: hexToBytes(dev.privateState.signedPreKey.priv), pub: hexToBytes(dev.privateState.signedPreKey.pub) },
          oneTimePreKeys: dev.privateState.oneTimePreKeys.map((o) => ({ id: o.id, priv: hexToBytes(o.priv), pub: hexToBytes(o.pub) })),
        },
      },
    };
  }
  static fromState(state) {
    const c = new PrizrakClient({ name: state.name, userId: state.userId, baseUrl: state.baseUrl, bankBase: state.bankBase });
    c.token = state.token; c.isAdmin = state.isAdmin; c.relayUrl = state.relayUrl; c.cursor = state.cursor || 0; c.verified = state.verified || {}; c.channelKeys = state.channelKeys || {}; c._peerIdk = state.peerIdk || {};
    c.identity = {
      name: state.name, userId: state.userId, pgp: state.pgp, fingerprint: state.fingerprint,
      identityKey: { priv: hexToBytes(state.identityKey.priv), pub: hexToBytes(state.identityKey.pub) },
    };
    c.preKeys = {
      publicBundle: state.publicBundle,
      privateState: {
        signedPreKey: { priv: hexToBytes(state.privateState.signedPreKey.priv), pub: hexToBytes(state.privateState.signedPreKey.pub) },
        oneTimePreKeys: state.privateState.oneTimePreKeys.map((o) => ({ id: o.id, priv: hexToBytes(o.priv), pub: hexToBytes(o.pub) })),
      },
    };
    if (state.deviceId) c.deviceId = state.deviceId;
    if (state.device) { const d = PrizrakClient._deserDevice(state.device, state.pgp, state.name, state.userId); c.deviceIdentity = d.deviceIdentity; c.devicePreKeys = d.devicePreKeys; }
    for (const [peer, s] of Object.entries(state.sessions || {})) c.sessions.set(peer, RatchetSession.fromJSON(s));
    for (const [peer, h] of Object.entries(state.pendingHandshake || {})) c.pendingHandshake.set(peer, h);
    return c;
  }
  /**
   * Явный релогин (ввод пароля) создаёт СВЕЖИЙ клиент с пустыми ратчет-сессиями —
   * и тогда все прежние сообщения собеседников превращаются в «нет сессии»
   * (их нельзя расшифровать: forward secrecy). Если это тот же аккаунт на той же
   * машине, перенимаем сохранённые сессии из локального состояния, чтобы история
   * осталась читаемой и не сыпались предупреждения. Чужое состояние игнорируем.
   */
  adoptSessionsFrom(state) {
    if (!state || state.userId !== this.userId) return false;
    try {
      for (const [peer, s] of Object.entries(state.sessions || {})) if (!this.sessions.has(peer)) this.sessions.set(peer, RatchetSession.fromJSON(s));
      for (const [peer, h] of Object.entries(state.pendingHandshake || {})) if (!this.pendingHandshake.has(peer)) this.pendingHandshake.set(peer, h);
      this._peerIdk = { ...(state.peerIdk || {}), ...(this._peerIdk || {}) };
      this.verified = { ...(state.verified || {}), ...(this.verified || {}) };
      this.channelKeys = { ...(state.channelKeys || {}), ...(this.channelKeys || {}) };
      // MD2: сохранить СТАБИЛЬНЫЕ ключи устройства при релогине (иначе device-ключ сменится).
      if (state.device && !this.deviceIdentity) { const d = PrizrakClient._deserDevice(state.device, this.identity.pgp, this.name, this.userId); this.deviceIdentity = d.deviceIdentity; this.devicePreKeys = d.devicePreKeys; if (!this.deviceId && state.deviceId) this.deviceId = state.deviceId; }
      // Продолжаем читать входящие с прежнего места — не перечитываем весь бэклог заново.
      if ((state.cursor || 0) > (this.cursor || 0)) this.cursor = state.cursor;
      return true;
    } catch { return false; }
  }

  _headers() { const h = { 'content-type': 'application/json' }; if (this.token) h.authorization = `Bearer ${this.token}`; return h; }
  async _post(path, payload, auth = true) {
    const res = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers: auth ? this._headers() : { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${path}: ${res.status}`);
    return data;
  }
  async _get(path) {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this._headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${path}: ${res.status}`);
    return data;
  }

  // ── Аккаунт ────────────────────────────────────────────────────────────────
  async serverConfig() { const c = await this._get('/_prizrak/client/v1/config'); this.relayUrl = c.relayUrl; return c; }
  // ── Резервная копия личности (шифруется паролем, хранится на сервере) ──────
  // Гарантирует, что вход на новом устройстве/после переустановки восстановит
  // ТЕ ЖЕ приватные ключи, совпадающие с опубликованным bundle. Без этого
  // повторный вход генерировал новые ключи → входящие не расшифровывались.
  _exportSecret() {
    const idk = this.identity.identityKey, ps = this.preKeys.privateState;
    return {
      pgp: this.identity.pgp, fingerprint: this.identity.fingerprint,
      identityKey: { priv: bytesToHex(idk.priv), pub: bytesToHex(idk.pub) },
      publicBundle: this.preKeys.publicBundle,
      privateState: {
        signedPreKey: { priv: bytesToHex(ps.signedPreKey.priv), pub: bytesToHex(ps.signedPreKey.pub) },
        oneTimePreKeys: ps.oneTimePreKeys.map((o) => ({ id: o.id, priv: bytesToHex(o.priv), pub: bytesToHex(o.pub) })),
      },
    };
  }
  _importSecret(sec) {
    this.identity = {
      name: this.name, userId: this.userId, pgp: sec.pgp, fingerprint: sec.fingerprint,
      identityKey: { priv: hexToBytes(sec.identityKey.priv), pub: hexToBytes(sec.identityKey.pub) },
    };
    this.preKeys = {
      publicBundle: sec.publicBundle,
      privateState: {
        signedPreKey: { priv: hexToBytes(sec.privateState.signedPreKey.priv), pub: hexToBytes(sec.privateState.signedPreKey.pub) },
        oneTimePreKeys: sec.privateState.oneTimePreKeys.map((o) => ({ id: o.id, priv: hexToBytes(o.priv), pub: hexToBytes(o.pub) })),
      },
    };
  }
  _makeBackup(password) { return sealJSON(deriveKeyFromPassword(password, this.userId), this._exportSecret()); }
  _openBackup(password, blob) { return openJSON(deriveKeyFromPassword(password, this.userId), blob); }

  async register(password, { inviteCode } = {}) {
    const keyBackup = this._makeBackup(password);
    const d = await this._post('/_prizrak/client/v1/register', { userId: this.userId, password, inviteCode, publicBundle: this.preKeys.publicBundle, keyBackup }, false);
    this.token = d.token; this.isAdmin = d.isAdmin;
    return d;
  }
  async login(password) {
    // Отправляем и текущие (свежесгенерированные) ключи: если у сервера ещё нет
    // резервной копии (легаси-аккаунт), он примет их как авторитетные (re-key).
    const keyBackup = this._makeBackup(password);
    const d = await this._post('/_prizrak/client/v1/login', { userId: this.userId, password, publicBundle: this.preKeys.publicBundle, keyBackup }, false);
    this.token = d.token; this.isAdmin = d.isAdmin;
    // Если бэкап уже есть — восстановить ИСХОДНУЮ личность (совпадёт с bundle).
    if (d.keyBackup) {
      try { this._importSecret(this._openBackup(password, d.keyBackup)); }
      catch { /* другой пароль/битый бэкап — оставляем текущие ключи */ }
    }
    return d;
  }

  // ── Экспорт/импорт копии аккаунта в файл (офлайн-восстановление) ───────────
  // Файл содержит userId (открыто, для деривации ключа) и запечатанную паролем
  // личность (те же приватные ключи). Хранить в безопасном месте — это доступ к аккаунту.
  exportBackupBlob(filePassword) {
    return { v: 1, kind: 'prizrak-account-backup', userId: this.userId, baseUrl: this.baseUrl,
      fingerprint: this.identity.fingerprint,
      blob: sealJSON(deriveKeyFromPassword(filePassword, this.userId), this._exportSecret()) };
  }
  static openBackupBlob(filePassword, file) {
    if (!file || !file.userId || !file.blob) throw new Error('Некорректный файл копии аккаунта');
    return openJSON(deriveKeyFromPassword(filePassword, file.userId), file.blob); // → секрет личности (бросит при неверном пароле)
  }
  // Восстановить личность из файла и войти на сервер (пароль аккаунта — для авторизации).
  async loginWithSecret(accountPassword, secret) {
    this._importSecret(secret);          // ставим ключи из файла ДО логина
    return this.login(accountPassword);  // login запушит нашу личность как keyBackup, если у сервера её нет
  }

  // ── B3: фраза восстановления (сид-фраза) ──────────────────────────────────
  // Аутентификатор фразы для сервера (сервер хранит его как второй «пароль»,
  // солёным хэшем — по фразе восстановление и сброс пароля). Сама фраза не уходит.
  _seedAuth(mnemonic) { return bytesToHex(sha256(new TextEncoder().encode('prizrak-seedauth|' + this.userId + '|' + normalizeMnemonic(mnemonic)))); }
  // Включить восстановление по фразе: генерируем фразу, запечатываем ею копию личности,
  // кладём копию + аутентификатор фразы на сервер. Возвращаем фразу для показа пользователю.
  async enableSeedRecovery() {
    const mnemonic = generateMnemonic();
    const seedBackup = sealJSON(deriveKeyFromPassword(mnemonic, this.userId), this._exportSecret());
    await this._post('/_prizrak/client/v1/seed-backup', { seedBackup, seedAuth: this._seedAuth(mnemonic) });
    return mnemonic;
  }
  // Восстановиться по фразе: сервер по аутентификатору фразы отдаёт копию личности и
  // ставит новый пароль, мы расшифровываем копию фразой и входим.
  async recoverBySeed(mnemonic, newPassword) {
    if (!isValidMnemonic(mnemonic)) throw new Error('Неверная фраза восстановления');
    const d = await this._post('/_prizrak/client/v1/recover-seed', { userId: this.userId, seedAuth: this._seedAuth(mnemonic), newPassword }, false);
    const secret = openJSON(deriveKeyFromPassword(mnemonic, this.userId), d.seedBackup);
    this._importSecret(secret);
    this.token = d.token; this.isAdmin = d.isAdmin;
    return d;
  }

  // ── MD1: устройства (реестр per-device ключей под общим PGP-корнем) ─────────
  // Собрать и опубликовать bundle текущего устройства (свежий X25519 + prekeys,
  // подписанные корневым PGP). Вызывается после логина/регистрации.
  async publishDevice() {
    if (!this.deviceId) return null; // одно-девайсный режим — реестр не трогаем
    if (!this.deviceIdentity) {
      this.deviceIdentity = createDeviceIdentity(this.identity);
      this.devicePreKeys = await publishPreKeys(this.deviceIdentity, 20);
    }
    const bundle = { ...this.devicePreKeys.publicBundle, deviceId: this.deviceId };
    try { await this._post('/_prizrak/client/v1/devices/publish', { deviceId: this.deviceId, bundle, name: this.name }); } catch {}
    return bundle;
  }
  // Список устройств пользователя, у которых bundle прошёл проверку подписи (PGP-корень).
  // MD5: кэшируем на короткий TTL, чтобы fan-out на группу не дёргал реестр на каждое
  // сообщение. Свежесть: при появлении нового устройства (пришло сообщение с новым
  // fromDevice) или отзыве — кэш сбрасывается. maxAgeMs:0 форсит свежий запрос.
  async deviceList(userId, { maxAgeMs = 20000 } = {}) {
    this._devCache ||= new Map();
    const c = this._devCache.get(userId);
    if (c && (Date.now() - c.at) < maxAgeMs) return c.devs;
    let devices = [];
    try { devices = (await this._get(`/_prizrak/client/v1/devices?userId=${encodeURIComponent(userId)}`)).devices || []; } catch { devices = []; }
    const okList = [];
    for (const d of devices) {
      if (!d || !d.bundle) continue;
      try { await verifyPreKeyBundle(d.bundle); okList.push({ deviceId: d.deviceId, bundle: d.bundle }); } catch { /* битая подпись — игнор */ }
    }
    this._devCache.set(userId, { devs: okList, at: Date.now() });
    return okList;
  }
  // Сбросить кэш устройств пользователя, если увидели неизвестное ранее устройство.
  _maybeRefreshDev(userId, deviceId) {
    if (!deviceId || !this._devCache) return;
    const c = this._devCache.get(userId);
    if (c && !c.devs.some((d) => d.deviceId === deviceId)) this._devCache.delete(userId);
  }
  async revokeDevice(deviceId) { const r = await this._post('/_prizrak/client/v1/devices/revoke', { deviceId }); this._devCache?.delete(this.userId); return r; }
  // MD6: свои устройства с метаданными (имя, когда добавлено, это ли устройство).
  async myDevices() {
    let devices = [];
    try { devices = (await this._get(`/_prizrak/client/v1/devices?userId=${encodeURIComponent(this.userId)}`)).devices || []; } catch { devices = []; }
    return devices.map((d) => ({ deviceId: d.deviceId, name: d.name || '', addedAt: d.addedAt || 0, updatedAt: d.updatedAt || 0, current: d.deviceId === this.deviceId }));
  }

  // ── E2E-сессии (MD2: per-устройство) ────────────────────────────────────────
  async fetchBundle(peerId) { return this._get(`/_prizrak/client/v1/bundle?userId=${encodeURIComponent(peerId)}`); }
  _addr(userId, deviceId) { return deviceId ? `${userId}|${deviceId}` : userId; }
  // Цели отправки: устройства получателя (по реестру) или один легаси-адрес (без
  // устройства) для старых собеседников без реестра — обратная совместимость.
  async _targetsFor(userId) {
    let devs = [];
    try { devs = await this.deviceList(userId); } catch { devs = []; }
    if (devs.length) return devs.map((d) => ({ deviceId: d.deviceId, bundle: d.bundle }));
    return [{ deviceId: null, bundle: null }];
  }
  // Гарантировать ратчет-сессию к адресу (userId|deviceId). Для device-адреса
  // инициатор — ЛИЧНОСТЬ УСТРОЙСТВА (deviceIdentity), для легаси — аккаунт-личность.
  async _ensureAddrSession(userId, deviceId, bundle) {
    const addr = this._addr(userId, deviceId);
    let b = bundle;
    if (!b) { try { b = await this.fetchBundle(userId); } catch { /* оффлайн — работаем со старой сессией */ } }
    if (!b) return; // нет bundle и нет сети — оставим что есть (или пропустим на отправке)
    if (this.sessions.has(addr)) {
      const known = this._peerIdk[addr];
      if (known === undefined || known === b.identityKey) { this._peerIdk[addr] = b.identityKey; return; }
      // ключ устройства/собеседника сменился → пересобрать сессию (ниже)
    }
    const myIdentity = deviceId ? (this.deviceIdentity || this.identity) : this.identity;
    const { ratchet, handshake } = await startSession(myIdentity, b);
    this.sessions.set(addr, ratchet); this.pendingHandshake.set(addr, handshake); this._peerIdk[addr] = b.identityKey;
  }
  _encryptForAddr(addr, plaintext) {
    const payload = serializeMessage(this.sessions.get(addr).encrypt(plaintext));
    const env = { type: 'message', payload };
    // handshake прикладываем к КАЖДОМУ сообщению, пока адрес не «подтвердил» сессию.
    if (this.pendingHandshake.has(addr)) env.handshake = this.pendingHandshake.get(addr);
    return env;
  }
  // Собрать конверты для всех устройств получателя (fan-out). Возвращает массив env.
  async _envelopesFor(peerId, obj, outerType) {
    const msgId = obj.msgId || bytesToHex(randomBytes(8)); obj.msgId = msgId;
    const plaintext = JSON.stringify(obj);
    const targets = await this._targetsFor(peerId);
    const envs = [];
    for (const t of targets) {
      try {
        await this._ensureAddrSession(peerId, t.deviceId, t.bundle);
        const addr = this._addr(peerId, t.deviceId);
        if (!this.sessions.has(addr)) continue; // оффлайн/нет bundle — пропускаем это устройство
        const env = this._encryptForAddr(addr, plaintext);
        env.type = outerType; env.msgId = msgId; env.to = peerId;
        if (t.deviceId) env.toDevice = t.deviceId;
        if (this.deviceId) env.fromDevice = this.deviceId;
        envs.push(env);
      } catch { /* одно устройство недоступно — не валим отправку остальным */ }
    }
    return { msgId, envs };
  }
  async _sendWrapped(peerId, obj, outerType = 'message') {
    const { msgId, envs } = await this._envelopesFor(peerId, obj, outerType);
    let delivered = false, queued = false;
    for (const env of envs) {
      try { const resp = await this._post('/_prizrak/client/v1/send', env); delivered = delivered || !!(resp && resp.delivered); queued = queued || !!(resp && resp.queued); } catch {}
    }
    return { msgId, delivered, queued };
  }

  // ── Квитанции доставки/прочтения ──────────────────────────────────────────
  async sendReceipt(to, msgIds, status) { try { return await this._post('/_prizrak/client/v1/receipt', { to, msgIds, status }); } catch { return null; } }
  async markRead(peerId, msgIds) { if (peerId && msgIds && msgIds.length) return this.sendReceipt(peerId, msgIds, 'read'); }
  // При получении личного сообщения — авто-квитанция «доставлено в приложение».
  _maybeAck(d) {
    if (!d || d.error || d.roomId || !d.msgId || !d.from || d.from === this.userId) return;
    if (d.kind === 'text') this.sendReceipt(d.from, [d.msgId], 'received');
    else if (d.kind === 'attachment' && d.attachment && d.attachment.voice) this.sendReceipt(d.from, [d.msgId], 'received'); // голосовые — сразу (мелкие)
    // Не-голосовые ФАЙЛЫ квитанцию НЕ шлём автоматически: приложение подтвердит
    // доставку/прочтение только когда файл реально ляжет на наш сервер (см. ensureMedia).
  }
  // Запустить перенос блоба на сервер получателя (фон) + опрос прогресса отправки.
  async federateMedia(mediaId, toDomain) { return this._post('/_prizrak/client/v1/media/federate', { mediaId, toDomain }); }
  async pushStatus(mediaId) { return this._get(`/_prizrak/client/v1/media/push-status?mediaId=${encodeURIComponent(mediaId)}`); }
  // Статус наличия/приёма блоба на НАШЕМ сервере: { present, received, total }.
  async mediaHead(att) { const q = `id=${encodeURIComponent(att.mediaId)}${this._mediaOriginQ(att)}`; try { return await this._get(`/_prizrak/client/v1/media/head?${q}`); } catch { return { present: false }; } }
  // Убедиться, что блоб есть на НАШЕМ сервере (подтянуть с origin, если ещё нет).
  async ensureMedia(att, { delayMs = 1000 } = {}) {
    if (!att || !att.mediaId) return false;
    // Ждём терпеливо — большой файл на медленном канале переносится долго. Масштабируем
    // число попыток от размера (грубо ~100 КБ/с в худшем случае), от 1 мин до 1 часа.
    const tries = Math.min(3600, Math.max(60, att.size ? Math.ceil(att.size / (100 * 1024)) : 60));
    const q = `id=${encodeURIComponent(att.mediaId)}${this._mediaOriginQ(att)}`;
    for (let i = 0; i < tries; i++) {
      try { const r = await this._get(`/_prizrak/client/v1/media/head?${q}`); if (r && r.present) return true; } catch {}
      await new Promise((res) => setTimeout(res, delayMs));
    }
    return false;
  }

  // ── Личные сообщения ─────────────────────────────────────────────────────
  /**
   * Отправить текст. `preview` — карточка ссылки, СОБРАННАЯ ОТПРАВИТЕЛЕМ
   * (см. link-preview.js): едет внутри шифртекста, получатель никуда не ходит.
   */
  async send(peerId, text, preview = null) {
    const payload = { t: 'text', body: text }; if (preview) payload.preview = preview;
    const r = await this._sendWrapped(peerId, payload);
    try { await this._selfSync(peerId, { ...payload, msgId: r.msgId }); } catch {}
    return r;
  }

  // MD3/MD4: разослать служебный объект на СВОИ ДРУГИЕ устройства (self-broadcast).
  async _selfBroadcast(obj) {
    if (!this.deviceId) return; // одно-девайсный режим — синкать некому
    let devs = [];
    try { devs = await this.deviceList(this.userId); } catch { return; }
    const others = devs.filter((d) => d.deviceId && d.deviceId !== this.deviceId);
    if (!others.length) return;
    const plaintext = JSON.stringify(obj);
    for (const d of others) {
      try {
        await this._ensureAddrSession(this.userId, d.deviceId, d.bundle);
        const addr = this._addr(this.userId, d.deviceId);
        if (!this.sessions.has(addr)) continue;
        const env = this._encryptForAddr(addr, plaintext);
        env.type = 'message'; env.msgId = obj.msgId || bytesToHex(randomBytes(8));
        env.to = this.userId; env.toDevice = d.deviceId; env.fromDevice = this.deviceId;
        await this._post('/_prizrak/client/v1/send', env);
      } catch { /* одно из своих устройств недоступно — не критично */ }
    }
  }
  // MD3: копия своего исходящего → на свои устройства (показать как «моё»).
  async _selfSync(peerId, inner) { return this._selfBroadcast({ t: 'sync-sent', to: peerId, inner }); }
  // MD4: пометка «чат прочитан» → на свои устройства (обнулить непрочитанные).
  async markReadSync(convId) { return this._selfBroadcast({ t: 'sync-read', peer: convId }); }
  // Локальный псевдоним контакта («жена», «сын») — приватный, синхронизируется
  // ТОЛЬКО между устройствами владельца (self-broadcast), собеседник его не видит.
  async setContactAlias(peer, name) { return this._selfBroadcast({ t: 'alias', peer, name: name || '' }); }

  // ── Реакции в личных чатах ────────────────────────────────────────────────
  // Реакция едет тем же E2E-каналом, что и сообщения (служебный тип 'reaction').
  // Сервер её не читает — только пересылает шифртекст. Поэтому доработок сервера
  // не нужно, а офлайн-реакции доставляются из очереди как обычные сообщения.
  async reactDirect(peerId, targetMsgId, emoji, on) { return this._sendWrapped(peerId, { t: 'reaction', target: targetMsgId, emoji, on: !!on }); }
  // Платная реакция в личке = донат призраков собеседнику + пометка платной реакции.
  async reactPaidDirect(peerId, targetMsgId, amount) {
    const amt = Math.floor(Number(amount)); if (!(amt > 0)) throw new Error('bad amount');
    const g = await this.sendGhosts(peerId, amt);
    try { await this._sendWrapped(peerId, { t: 'reaction', target: targetMsgId, paid: amt }); } catch {}
    return g;
  }

  // Удаление сообщения (для всех), назначение ролей, передача владельца.
  async deleteMessage(msgId, peer) { return this._post('/_prizrak/client/v1/messages/delete', { msgId, peer }); }
  async deleteMedia(mediaId) { return this._post('/_prizrak/client/v1/media/delete', { mediaId }); }
  async setRoomRole(roomId, userId, role) { return this._post('/_prizrak/client/v1/rooms/role', { roomId, userId, role }); }
  async transferRoom(roomId, newOwner) { return this._post('/_prizrak/client/v1/rooms/transfer', { roomId, newOwner }); }
  async kickMember(roomId, userId) { return this._post('/_prizrak/client/v1/rooms/kick', { roomId, userId }); }
  async banMember(roomId, userId) {
    const res = await this._post('/_prizrak/client/v1/rooms/ban', { roomId, userId });
    if (res.type === 'channel') { try { await this.rotateChannel(roomId); } catch {} } // сменить ключ → забаненный не читает будущее
    return res;
  }
  async unbanMember(roomId, userId) { return this._post('/_prizrak/client/v1/rooms/unban', { roomId, userId }); }
  async setRoomReadOnly(roomId, readOnly) { return this._post('/_prizrak/client/v1/rooms/readonly', { roomId, readOnly }); }

  // ── Комнаты ────────────────────────────────────────────────────────────────
  async createGroup(name) { return this._post('/_prizrak/client/v1/rooms/create', { type: 'group', name }); }
  async createChannel(name) {
    const room = await this._post('/_prizrak/client/v1/rooms/create', { type: 'channel', name });
    const key = randomBytes(32); const epoch = room.keyEpoch || 1;
    (this.channelKeys[room.id] ||= {})[epoch] = bytesToHex(key);
    // Ключ канала кладём на домашний сервер канала — любой подписчик заберёт его сам,
    // даже когда владелец офлайн. Плюс wrapped-грант себе (совместимость).
    try { await this._setChannelSecret(room.id, epoch, bytesToHex(key)); } catch {}
    try { const wrapped = await this._wrapKey(this.identity.pgp.publicKey, key); await this._post('/_prizrak/client/v1/rooms/channel/grant', { roomId: room.id, grants: [{ userId: this.userId, epoch, wrapped }] }); } catch {}
    return room;
  }
  async _setChannelSecret(roomId, epoch, keyHex) { return this._post('/_prizrak/client/v1/rooms/channel/set-secret', { roomId, secrets: { [epoch]: keyHex } }); }
  async listRooms() { return (await this._get('/_prizrak/client/v1/rooms')).rooms; }
  /** Список личных собеседников (восстановление чатов на новом устройстве).
   *  Сервер отдаёт только метаданные (peer, lastAt, count) — содержимое E2E. */
  async listChats() { return (await this._get('/_prizrak/client/v1/chats')).chats; }
  async getRoom(roomId) { return this._get(`/_prizrak/client/v1/rooms/get?roomId=${encodeURIComponent(roomId)}`); }
  async presence(userId) { return this._get(`/_prizrak/client/v1/presence?userId=${encodeURIComponent(userId)}`); }
  async invite(roomId, userId) {
    const res = await this._post('/_prizrak/client/v1/rooms/invite', { roomId, userId });
    if (res.type === 'channel') { // выдать новому участнику все эпохи ключа → он увидит историю
      await this.ensureChannelKeys(roomId);
      let bundle = null; try { bundle = await this.fetchBundle(userId); } catch { bundle = null; }
      const pub = bundle && bundle.pgpPublicKey;
      const grants = [];
      if (pub) {
        for (const [epoch, hex] of Object.entries(this.channelKeys[roomId] || {})) {
          try { grants.push({ userId, epoch: Number(epoch), wrapped: await this._wrapKey(pub, hexToBytes(hex)) }); } catch { /* пропускаем сбойную эпоху */ }
        }
      }
      if (grants.length) { try { await this._post('/_prizrak/client/v1/rooms/channel/grant', { roomId, grants }); } catch {} }
      // Не роняем инвайт, если ключ выдать не удалось: пользователь уже добавлен,
      // а ключ ему до-раздастся при следующем открытии канала владельцем (resync).
      res._keysGranted = grants.length;
    }
    return res;
  }
  /**
   * До-раздать ключ ТЕКУЩЕЙ эпохи всем участникам, у кого его может не быть
   * (например, инвайт не смог зашифровать на их ключ). Идемпотентно и терпимо
   * к сбоям. Запускает только владелец/админ канала. Без ротации эпохи.
   */
  async resyncChannelKeys(roomId) {
    let room; try { room = await this.getRoom(roomId); } catch { return { ok: false, reason: 'no-room', granted: 0 }; }
    if (!room || room.type !== 'channel') return { ok: false, reason: 'not-channel', granted: 0 };
    const iManage = room.owner === this.userId || (room.admins || []).includes(this.userId);
    if (!iManage) return { ok: false, reason: 'no-rights', granted: 0 };
    await this.ensureChannelKeys(roomId);
    const epoch = room.keyEpoch || 1;
    const hex = this.channelKeys[roomId]?.[epoch];
    if (!hex) {
      // У самого нет ключа текущей эпохи — перевыпускаем канал (rotateChannel сам
      // раздаёт свежий ключ всем участникам). Так «Раздать ключи заново» сработает
      // даже если владелец потерял ключ.
      const r = await this.rotateChannel(roomId);
      return { ok: true, rotated: true, granted: r.granted || 0 };
    }
    try { await this._setChannelSecret(roomId, epoch, hex); } catch {} // ключ на сервер канала (основной механизм)
    const n = await this._grantEpochToAll(roomId, room, epoch, hex);
    return { ok: true, rotated: false, granted: n };
  }

  // ── Каналы: общий ключ + история ──────────────────────────────────────────
  async _wrapKey(pgpPub, keyBytes) { return pgpEncrypt(pgpPub, bytesToHex(keyBytes)); }
  async _unwrapKey(armored) { return hexToBytes(await pgpDecrypt(this.identity.pgp.privateKey, armored)); }
  async ensureChannelKeys(roomId) {
    this.channelKeys[roomId] ||= {};
    // 1) Серверный общий ключ канала — надёжно, без владельца-онлайн (основной путь).
    try {
      const { secrets } = await this._get(`/_prizrak/client/v1/rooms/channel/secret?roomId=${encodeURIComponent(roomId)}`);
      for (const [epoch, hex] of Object.entries(secrets || {})) if (hex && !this.channelKeys[roomId][epoch]) this.channelKeys[roomId][epoch] = hex;
    } catch {}
    // 2) Старые wrapped-гранты на свой pgp-ключ (совместимость со старыми каналами).
    try {
      const { keys } = await this._get(`/_prizrak/client/v1/rooms/channel/keys?roomId=${encodeURIComponent(roomId)}`);
      for (const [epoch, wrapped] of Object.entries(keys || {})) if (!this.channelKeys[roomId][epoch]) { try { this.channelKeys[roomId][epoch] = bytesToHex(await this._unwrapKey(wrapped)); } catch {} }
    } catch {}
    return this.channelKeys[roomId];
  }
  async postChannel(roomId, text, preview = null) {
    await this.ensureChannelKeys(roomId);
    const room = await this.getRoom(roomId); let epoch = room.keyEpoch || 1;
    let hex = this.channelKeys[roomId]?.[epoch];
    if (!hex) {
      // Ключа текущей эпохи нет (например, он был выдан на прежнюю личность и больше
      // не расшифровывается). Владелец/админ может перевыпустить ключ канала —
      // сгенерировать новую эпоху и раздать участникам — и постить уже свежим ключом.
      const iManage = room.owner === this.userId || (room.admins || []).includes(this.userId);
      if (!iManage) throw new Error('Нет ключа этого канала — попросите администратора выдать доступ заново');
      const r = await this.rotateChannel(roomId);
      epoch = r.epoch; hex = this.channelKeys[roomId]?.[epoch];
      if (!hex) throw new Error('Не удалось перевыпустить ключ канала');
    }
    // Ключ канала — на домашний сервер канала: любой подписчик заберёт его сам,
    // даже когда владелец офлайн. (+ старая раздача wrapped-грантами для совместимости.)
    try { await this._setChannelSecret(roomId, epoch, hex); } catch {}
    try { await this._grantEpochToAll(roomId, room, epoch, hex); } catch {}
    const msgId = bytesToHex(randomBytes(8));
    const chInner = { t: 'text', body: text, msgId }; if (preview) chInner.preview = preview;
    const pt = new TextEncoder().encode(JSON.stringify(chInner));
    const { nonce, ciphertext } = encryptBlob(pt, hexToBytes(hex));
    await this._post('/_prizrak/client/v1/rooms/channel/post', { roomId, msgId, epoch, ct: bytesToHex(ciphertext), nonce: bytesToHex(nonce) });
    return { roomId, msgId };
  }
  /** Раздать ключ эпохи всем участникам (терпимо к сбоям). Общий помощник. */
  async _grantEpochToAll(roomId, room, epoch, hex) {
    const key = hexToBytes(hex);
    const members = [...new Set([room.owner, ...(room.admins || []), ...(room.subscribers || []), ...(room.members || [])])].filter((u) => u && u !== this.userId && !(room.banned || []).includes(u));
    const grants = [];
    for (const u of members) {
      try { const b = await this.fetchBundle(u); if (b?.pgpPublicKey) grants.push({ userId: u, epoch, wrapped: await this._wrapKey(b.pgpPublicKey, key) }); } catch { /* участник недоступен — пропускаем */ }
    }
    if (grants.length) await this._post('/_prizrak/client/v1/rooms/channel/grant', { roomId, grants });
    return grants.length;
  }
  _decryptChannelPost(roomId, p) {
    const hex = this.channelKeys[roomId]?.[p.epoch];
    if (!hex) return { from: p.from, roomId, seq: p.seq, error: 'нет ключа эпохи' };
    try { const o = JSON.parse(new TextDecoder().decode(decryptBlob(hexToBytes(hex), hexToBytes(p.nonce), hexToBytes(p.ct)))); return { kind: 'text', from: p.from, roomId, seq: p.seq, msgId: o.msgId, text: o.body, preview: o.preview || null }; }
    catch { return { from: p.from, roomId, seq: p.seq, error: 'не расшифровать' }; }
  }
  async getChannelHistory(roomId, since = 0) {
    await this.ensureChannelKeys(roomId);
    const { posts } = await this._get(`/_prizrak/client/v1/rooms/channel/history?roomId=${encodeURIComponent(roomId)}&since=${since}`);
    const out = posts.map((p) => this._decryptChannelPost(roomId, p));
    // Если каких-то постов не расшифровать (нет ключа эпохи) — просим владельца выдать ключ.
    if (out.some((d) => d.error === 'нет ключа эпохи')) this.requestChannelKeys(roomId).catch(() => {});
    return out;
  }
  /** Попросить владельца/админов канала выдать нам ключ (если поста не расшифровать). */
  async requestChannelKeys(roomId) {
    const now = Date.now(); this._keyReq ||= {};
    if (this._keyReq[roomId] && now - this._keyReq[roomId] < 8000) return;
    this._keyReq[roomId] = now;
    try { await this._post('/_prizrak/client/v1/rooms/channel/request-keys', { roomId }); } catch {}
  }
  /**
   * Приём поста канала с самолечением ключа: если эпохи-ключа ещё нет — просим
   * владельца выдать и повторяем расшифровку пару раз, прежде чем показать ошибку.
   */
  async _handleChannelPost(roomId, post, onEvent, tries = 0) {
    try { await this.ensureChannelKeys(roomId); } catch {}
    const d = this._decryptChannelPost(roomId, post);
    if (d.error === 'нет ключа эпохи' && tries < 3) {
      if (tries === 0) this.requestChannelKeys(roomId).catch(() => {});
      setTimeout(() => this._handleChannelPost(roomId, post, onEvent, tries + 1), 1500);
      return;
    }
    onEvent(d);
  }
  // ── Реакции на посты канала ────────────────────────────────────────────────
  /** Настройки реакций канала (владелец/админ). */
  async setRoomReactions(roomId, opts) { return this._post('/_prizrak/client/v1/rooms/reactions/settings', { roomId, ...opts }); }
  /** Переключить бесплатную реакцию. Возвращает сводку {counts, mine, paid, myPaid}. */
  async reactChannel(roomId, msgId, emoji) { return this._post('/_prizrak/client/v1/rooms/channel/react', { roomId, msgId, emoji }); }
  /**
   * Платная реакция: сначала переводим 👻 автору через Банк Призраков,
   * затем фиксируем реакцию на сервере канала. ownerId — кому летят призраки.
   */
  async reactPaidChannel(roomId, msgId, amount, ownerId) {
    const amt = Math.floor(Number(amount)); if (!(amt > 0)) throw new Error('Некорректная сумма');
    if (ownerId && ownerId !== this.userId) await this.sendGhosts(ownerId, amt); // донат автору (банк)
    return this._post('/_prizrak/client/v1/rooms/channel/react-paid', { roomId, msgId, amount: amt });
  }
  /** Сводка реакций по всем постам канала (для текущего пользователя). */
  async channelReactions(roomId) { const d = await this._get(`/_prizrak/client/v1/rooms/channel/reactions?roomId=${encodeURIComponent(roomId)}`); return d.reactions || {}; }
  async rotateChannel(roomId) {
    const { epoch } = await this._post('/_prizrak/client/v1/rooms/channel/rotate', { roomId });
    const key = randomBytes(32); (this.channelKeys[roomId] ||= {})[epoch] = bytesToHex(key);
    try { await this._setChannelSecret(roomId, epoch, bytesToHex(key)); } catch {} // новый ключ — на сервер канала
    const room = await this.getRoom(roomId);
    const members = [...new Set([room.owner, ...room.admins, ...room.subscribers, ...room.members])].filter((u) => !(room.banned || []).includes(u));
    const grants = [];
    for (const u of members) {
      try { const pub = u === this.userId ? this.identity.pgp.publicKey : (await this.fetchBundle(u)).pgpPublicKey; grants.push({ userId: u, epoch, wrapped: await this._wrapKey(pub, key) }); }
      catch { /* участник недоступен (офлайн/чужой сервер) — получит ключ позже, при следующем invite/ensure */ }
    }
    if (grants.length) await this._post('/_prizrak/client/v1/rooms/channel/grant', { roomId, grants });
    return { epoch, granted: grants.filter((g) => g.userId !== this.userId).length };
  }
  async join(roomId) { return this._post('/_prizrak/client/v1/rooms/join', { roomId }); }
  async leave(roomId) { return this._post('/_prizrak/client/v1/rooms/leave', { roomId }); }
  async _roomRecipients(roomId) {
    const room = await this.getRoom(roomId);
    return [...new Set([...room.members, ...room.subscribers, ...room.admins])].filter((u) => u !== this.userId);
  }
  async sendToRoom(roomId, text, preview = null) {
    const room = await this.getRoom(roomId);
    if (room.type === 'channel') return this.postChannel(roomId, text, preview); // канал: единый ключ + история
    const recipients = [...new Set([...room.members, ...room.subscribers, ...room.admins])].filter((u) => u !== this.userId);
    const msgId = bytesToHex(randomBytes(8));
    const envelopes = [];
    const inner = { t: 'text', body: text, msgId }; if (preview) inner.preview = preview;
    // MD2: на каждого участника — fan-out по его устройствам (или один легаси-конверт).
    for (const peer of recipients) { const { envs } = await this._envelopesFor(peer, inner, 'room-message'); for (const e of envs) { e.roomId = roomId; envelopes.push(e); } }
    await this._post('/_prizrak/client/v1/rooms/send', { roomId, envelopes });
    // Синхронизация групповых исходящих между СВОИМИ устройствами (как MD3 для личек):
    // rooms/send не доставляет отправителю, поэтому шлём копию self-broadcast'ом.
    try { await this._selfBroadcast({ t: 'sync-sent', roomId, inner }); } catch {}
    return { roomId, recipients: recipients.length, msgId };
  }

  // ── Вложения и голосовые (E2E-блобы) ──────────────────────────────────────
  async uploadBlob(bytes, mime) {
    const { key, nonce, ciphertext } = encryptBlob(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const d = await this._post('/_prizrak/client/v1/media/upload', { ciphertext: bytesToHex(ciphertext), nonce: bytesToHex(nonce), mime, size: bytes.length });
    return { mediaId: d.mediaId, key: bytesToHex(key), nonce: bytesToHex(nonce) };
  }
  async _postRaw(path, u8) {
    const res = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${this.token}` }, body: u8 });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `${path}: ${res.status}`); }
    return res.json().catch(() => ({}));
  }
  /** Чанковая загрузка большого блоба с прогрессом и возможностью отмены. */
  async uploadBlobChunked(bytes, mime, { onProgress, isCancelled } = {}) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const { key, nonce, ciphertext } = encryptBlob(u8);
    const uploadId = bytesToHex(randomBytes(12));
    const CHUNK = 4 * 1024 * 1024; // 4МБ
    const total = ciphertext.length; let sent = 0;
    try {
      for (let off = 0; off < total; off += CHUNK) {
        if (isCancelled && isCancelled()) throw Object.assign(new Error('Загрузка отменена'), { cancelled: true });
        const chunk = ciphertext.subarray(off, Math.min(off + CHUNK, total));
        await this._postRaw(`/_prizrak/client/v1/media/chunk?uploadId=${uploadId}&off=${off}`, chunk);
        sent += chunk.length;
        if (onProgress) onProgress(Math.min(99, Math.round((sent / total) * 100)));
      }
      const d = await this._post('/_prizrak/client/v1/media/finish', { uploadId, nonce: bytesToHex(nonce), mime });
      if (onProgress) onProgress(100);
      return { mediaId: d.mediaId, key: bytesToHex(key), nonce: bytesToHex(nonce) };
    } catch (e) {
      try { await this._post('/_prizrak/client/v1/media/abort', { uploadId }); } catch {}
      throw e;
    }
  }
  /** Отправить вложение (файл) или голосовое (voice:true) собеседнику. Большие — чанками с прогрессом. */
  async sendAttachment(peerId, bytes, { filename, mime, voice = false, videoNote = false, dur, wave, onProgress, isCancelled } = {}) {
    const size = bytes instanceof Uint8Array ? bytes.length : bytes.length;
    const up = size > 4 * 1024 * 1024
      ? await this.uploadBlobChunked(bytes, mime, { onProgress, isCancelled })
      : await this.uploadBlob(bytes, mime);
    // Для голосовых/видео-заметок передаём длительность (сек) и «волну» (амплитуды) —
    // они едут ВНУТРИ E2E-конверта, сервер их не видит.
    const meta = { t: 'att', mediaId: up.mediaId, key: up.key, nonce: up.nonce, filename, mime, size, voice };
    if (voice) { if (typeof dur === 'number') meta.dur = dur; if (Array.isArray(wave)) meta.wave = wave; }
    if (videoNote) { meta.videoNote = true; if (typeof dur === 'number') meta.dur = dur; }
    // Кросс-сервер: отправку НЕ блокируем переносом 80 МБ. Файл на сервер получателя
    // переносит сам получатель — его клиент по гейту ensureMedia дотянет блоб с нашего
    // сервера ОДИН раз и только тогда покажет сообщение и подтвердит доставку/прочтение.
    // (Так нет ни зависания у отправителя, ни гонки двух одновременных записей блоба.)
    const sent = await this._sendWrapped(peerId, meta);
    try { await this._selfSync(peerId, { ...meta, msgId: sent.msgId }); } catch {} // MD3: показать вложение на своих устройствах
    return { ...up, msgId: sent.msgId, delivered: sent.delivered, queued: sent.queued };
  }
  /**
   * Переслать УЖЕ полученное вложение другому пользователю — без повторной загрузки.
   * Метаданные (mediaId+key+nonce) едут внутри нового E2E-конверта; блоб остаётся на
   * сервере-владельце (origin), новый получатель дотянет его по mediaId+origin.
   */
  async forwardAttachment(peerId, att) {
    const origin = att._origin || att.origin || (this.userId.split(':')[1] || '');
    const meta = { t: 'att', mediaId: att.mediaId, key: att.key, nonce: att.nonce, filename: att.filename, mime: att.mime, size: att.size, voice: !!att.voice, origin };
    if (att.voice) { if (typeof att.dur === 'number') meta.dur = att.dur; if (Array.isArray(att.wave)) meta.wave = att.wave; }
    if (att.videoNote) { meta.videoNote = true; if (typeof att.dur === 'number') meta.dur = att.dur; }
    const sent = await this._sendWrapped(peerId, meta);
    try { await this._selfSync(peerId, { ...meta, msgId: sent.msgId }); } catch {}
    return { msgId: sent.msgId, delivered: sent.delivered, queued: sent.queued };
  }
  /** Скачать вложение потоково с прогрессом и отменой, вернуть расшифрованные байты. */
  _mediaOriginQ(att) { return att && att._origin ? `&origin=${encodeURIComponent(att._origin)}` : ''; }
  async fetchAttachmentProgress(att, { onProgress, isCancelled } = {}) {
    const res = await fetch(`${this.baseUrl}/_prizrak/client/v1/media/raw?id=${encodeURIComponent(att.mediaId)}${this._mediaOriginQ(att)}`, { headers: this._headers() });
    if (!res.ok || !res.body) return this.fetchAttachment(att); // фолбэк (старые блобы)
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = []; let received = 0;
    for (;;) {
      if (isCancelled && isCancelled()) { try { await reader.cancel(); } catch {} throw Object.assign(new Error('Скачивание отменено'), { cancelled: true }); }
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); received += value.length;
      if (onProgress && total) onProgress(Math.min(99, Math.round((received / total) * 100)));
    }
    const ct = new Uint8Array(received); let off = 0; for (const c of chunks) { ct.set(c, off); off += c.length; }
    const out = decryptBlob(hexToBytes(att.key), hexToBytes(att.nonce), ct);
    if (onProgress) onProgress(100);
    return out;
  }
  /** Скачать и расшифровать вложение по метаданным из сообщения. */
  async fetchAttachment(att) {
    // Сначала пробуем сырой поток (большие файлы), потом старый hex-эндпоинт.
    try {
      const res = await fetch(`${this.baseUrl}/_prizrak/client/v1/media/raw?id=${encodeURIComponent(att.mediaId)}${this._mediaOriginQ(att)}`, { headers: this._headers() });
      if (res.ok) { const buf = new Uint8Array(await res.arrayBuffer()); return decryptBlob(hexToBytes(att.key), hexToBytes(att.nonce), buf); }
    } catch {}
    const m = await this._get(`/_prizrak/client/v1/media/get?id=${encodeURIComponent(att.mediaId)}${this._mediaOriginQ(att)}`);
    return decryptBlob(hexToBytes(att.key), hexToBytes(att.nonce), hexToBytes(m.ciphertext));
  }

  // ── Кошелёк 👻 ──────────────────────────────────────────────────────────
  // Баланс/покупка/подарки — через ЦЕНТРАЛЬНЫЙ Банк Призраков, а не homeserver.
  // Homeserver'у нельзя доверять учёт покупной валюты (любой админ намайнил бы).
  // Ghost-key (Ed25519) детерминированно выводится из личности → одинаков на всех
  // устройствах (после восстановления личности), TOFU-привязка не ломается.
  _ghostKey() {
    if (this._gk) return this._gk;
    const seed = sha256(concatBytes(this.identity.identityKey.priv, new TextEncoder().encode('prizrak/ghost-key')));
    this._gk = { priv: seed, pub: ed25519.getPublicKey(seed) };
    return this._gk;
  }
  ghostPubHex() { return bytesToHex(this._ghostKey().pub); }
  _bankUrl(p) { return this.bankBase.replace(/\/$/, '') + p; }
  /** Зарегистрировать (TOFU) свой ghost-key в каталоге Банка — нужно до покупок/переводов.
   * Возвращает true, если пользователь зарегистрирован (создан сейчас или уже есть). */
  async bankRegister() {
    try {
      const r = await fetch(this._bankUrl('/api/directory/register'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: this.userId, ghostPubKey: this.ghostPubHex(), displayName: this.name, listed: true }),
      });
      // 200 — создан/обновлён; 401 — запись уже есть под нашим ключом (тоже ок).
      this._bankReg = r.ok || r.status === 401;
      return this._bankReg;
    } catch { return false; /* Банк недоступен — не критично для сообщений */ }
  }
  async _ensureBankRegistered() { if (!this._bankReg) await this.bankRegister(); }
  async bankBalance() {
    try { const r = await fetch(this._bankUrl(`/api/ghosts/balance?userId=${encodeURIComponent(this.userId)}`)); const d = await r.json(); return Number(d.balance) || 0; }
    catch { return 0; }
  }
  async bankHistory() {
    try { const r = await fetch(this._bankUrl(`/api/ghosts/history?userId=${encodeURIComponent(this.userId)}&limit=200`)); const d = await r.json(); return { balance: Number(d.balance) || 0, ops: Array.isArray(d.ops) ? d.ops : [] }; }
    catch { return { balance: 0, ops: [] }; }
  }
  _bankSign(body) { return bytesToHex(ed25519.sign(new TextEncoder().encode(body), this._ghostKey().priv)); }
  async _bankSigned(path, obj) {
    const body = JSON.stringify({ ...obj, userId: this.userId, ts: Math.floor(Date.now() / 1000), nonce: bytesToHex(randomBytes(8)) });
    const r = await fetch(this._bankUrl(path), { method: 'POST', headers: { 'content-type': 'application/json', 'x-sig': this._bankSign(body) }, body });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `${path}: ${r.status}`);
    return d;
  }

  async wallet() { return { balance: await this.bankBalance(), tx: [] }; }
  /** Покупка: Банк создаёт платёж в PayMoney и возвращает payment_url (открыть в браузере). */
  async buyGhosts(amount) { await this._ensureBankRegistered(); return this._bankSigned('/api/ghosts/buy', { ghosts: Math.floor(Number(amount)) }); }
  /** Подарить/перевести призраков (подписанный перевод в Банке). */
  async sendGhosts(to, amount) { await this._ensureBankRegistered(); const d = await this._bankSigned('/api/ghosts/transfer', { to, amount: Math.floor(Number(amount)) }); return { ok: true, balance: d.balance }; }

  // ── Подарки 🎁 (магазин как в Telegram, оплата 👻) ────────────────────────
  /** Каталог магазина подарков: [{id,emoji,name,price,left}] + процент возврата. */
  async giftCatalog() { const r = await fetch(this._bankUrl('/api/gifts/catalog')); const d = await r.json(); return d; }
  /** 🛡 Список стран выхода VPN с рейтингом (для экрана «Замаскироваться»). */
  async vpnCountries() { try { const r = await fetch(this._bankUrl('/api/vpn/countries')); const d = await r.json(); return d.countries || []; } catch { return []; } }
  /** Оценить узел VPN (1..5). */
  async vpnRate(nodeId, stars) { const r = await fetch(this._bankUrl('/api/vpn/rate'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId, acct: this.userId, stars }) }); return r.json(); }
  /** 🛡 Оплатить подписку VPN (списывает 👻 по тарифу). Возвращает {paidUntil}. */
  async vpnSubscribe(months = 1) { await this._ensureBankRegistered(); return this._bankSigned('/api/vpn/subscribe', { months: Number(months) || 1 }); }
  /** Статус подписки: {paidUntil}. Единственное, что клиент о себе хранит. */
  async vpnSub() { try { const r = await fetch(this._bankUrl('/api/vpn/sub?userId=' + encodeURIComponent(this.userId))); const d = await r.json(); return d.paidUntil || 0; } catch { return 0; } }
  /** Ордер на подключение к стране (проверяет оплату, выбирает узлы). Возвращает {order, paidUntil}. */
  async vpnConnect(country) { await this._ensureBankRegistered(); return this._bankSigned('/api/vpn/connect', { country: String(country || '').toUpperCase() }); }
  /** Купить и отправить подарок: списывает 👻 в Банке + шлёт E2E-сообщение-подарок в чат. */
  async sendGift(to, { giftId, msg = '', anon = false } = {}) {
    await this._ensureBankRegistered();
    const d = await this._bankSigned('/api/gifts/send', { to, giftId: Number(giftId), msg: String(msg || '').slice(0, 200), anon: !!anon });
    const g = d.gift || {};
    const meta = { t: 'gift', emoji: g.emoji, name: g.name, price: g.price, msg: String(msg || '').slice(0, 200), anon: !!anon };
    let sent = { msgId: null };
    try { sent = await this._sendWrapped(to, meta); try { await this._selfSync(to, { ...meta, msgId: sent.msgId }); } catch {} } catch {}
    return { ok: true, balance: d.balance, gift: g, msgId: sent.msgId };
  }
  /** Публичная витрина подарков пользователя (профиль). */
  async giftsOf(userId) { const r = await fetch(this._bankUrl(`/api/gifts/of?userId=${encodeURIComponent(userId)}`)); const d = await r.json(); return d.gifts || []; }
  /** Мои подарки (полный список) + процент возврата при распылении. */
  async myGifts() { await this._ensureBankRegistered(); return this._bankSigned('/api/gifts/mine', {}); }
  /** «Распылить» подарок → вернуть часть 👻. */
  async convertGift(id) { await this._ensureBankRegistered(); return this._bankSigned('/api/gifts/convert', { id: Number(id) }); }
  /** Скрыть/показать подарок на витрине. */
  async hideGift(id, hidden) { await this._ensureBankRegistered(); return this._bankSigned('/api/gifts/hide', { id: Number(id), hidden: !!hidden }); }

  // ── Узлы-тайники оператора (награды 👻) ──────────────────────────────────
  /** Мои узлы: список привязанных узлов со статистикой (аптайм/доставки/накопления). */
  async bankMyNodes() {
    try { const r = await fetch(this._bankUrl(`/api/nodes/mine?userId=${encodeURIComponent(this.userId)}`)); const d = await r.json(); return { balance: Number(d.balance) || 0, nodes: Array.isArray(d.nodes) ? d.nodes : [] }; }
    catch { return { balance: 0, nodes: [] }; }
  }
  /** Привязать узел к своему аккаунту по коду с его /status (base64url JSON {relayId,userId,sig}). */
  async bindNode(code) {
    let dec;
    try {
      const b64 = String(code || '').trim().replace(/-/g, '+').replace(/_/g, '/');
      const json = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
      dec = JSON.parse(json);
    } catch { throw new Error('Некорректный код привязки'); }
    if (!dec || !/^[0-9a-f]{64}$/i.test(dec.relayId || '') || !dec.sig) throw new Error('Некорректный код привязки');
    if (dec.userId && dec.userId !== this.userId) throw new Error('Код выписан для другого аккаунта (' + dec.userId + ')');
    await this._ensureBankRegistered();
    const d = await this._bankSigned('/api/nodes/bind', { relayId: dec.relayId, sig: dec.sig });
    return { ok: true, relayId: d.relayId };
  }

  // ── Звонки без STUN ─────────────────────────────────────────────────────
  _relay() {
    if (!this.relayUrl) throw new Error('Сервер не сообщил адрес relay для звонков (relayUrl)');
    return { ...parseRelay(this.relayUrl), psk: 'prizrak-relay' };
  }
  /** Инициировать звонок. onMedia — колбэк на входящие кадры. */
  async startCall(peerId, { video = false, onMedia, onRaw, onCtrl } = {}) {
    const callId = bytesToHex(randomBytes(8));
    const mediaKey = randomBytes(32);
    const call = new Call({ callId, mediaKey, relay: this._relay(), onMedia, onRaw, onCtrl });
    await call.connect();
    await this._sendWrapped(peerId, { t: 'call', event: 'offer', callId, mediaKey: bytesToHex(mediaKey), relayUrl: this.relayUrl, media: video ? 'video' : 'audio' });
    return { call, callId };
  }
  /** Принять входящий звонок по offer-сигналу. */
  async acceptCall(peerId, offer, { onMedia, onRaw, onCtrl } = {}) {
    const call = new Call({ callId: offer.callId, mediaKey: hexToBytes(offer.mediaKey), relay: { ...parseRelay(offer.relayUrl), psk: 'prizrak-relay' }, onMedia, onRaw, onCtrl });
    await call.connect();
    await this._sendWrapped(peerId, { t: 'call', event: 'answer', callId: offer.callId });
    return call;
  }
  async hangupCall(peerId, callId) { return this._sendWrapped(peerId, { t: 'call', event: 'hangup', callId }); }

  // ── Сигналинг звонка без встроенного транспорта (для клиентов со своим
  //    медиа-движком, напр. мобильного). Транспорт/медиа поднимает сам клиент. ──
  async callOffer(peerId, { callId, mediaKey, media = 'audio' }) {
    return this._sendWrapped(peerId, { t: 'call', event: 'offer', callId, mediaKey, relayUrl: this.relayUrl, media });
  }
  async callAnswer(peerId, callId) { return this._sendWrapped(peerId, { t: 'call', event: 'answer', callId }); }
  /** Гарантировать, что relayUrl известен (из конфига сервера) — нужно перед звонком. */
  async ensureRelay() { if (!this.relayUrl) { try { await this.serverConfig(); } catch {} } return this.relayUrl; }

  // ── Приём: расшифровка + разбор типов ─────────────────────────────────────
  _decodeEnvelope(env) {
    // MD2: адрес сессии — по устройству отправителя; конверт, адресованный НАШЕМУ
    // устройству (env.toDevice), расшифровывается ключами УСТРОЙСТВА, иначе — аккаунта.
    if (env.fromDevice && env.from !== this.userId) this._maybeRefreshDev(env.from, env.fromDevice); // MD5: новое устройство собеседника → обновить кэш
    const addr = env.fromDevice ? `${env.from}|${env.fromDevice}` : env.from;
    const deviceMode = !!env.toDevice && !!this.deviceIdentity && !!this.devicePreKeys;
    const rIdentity = deviceMode ? this.deviceIdentity : this.identity;
    const rPriv = deviceMode ? this.devicePreKeys.privateState : this.preKeys.privateState;
    if (env.handshake && !this.sessions.has(addr)) this.sessions.set(addr, acceptSession(rIdentity, rPriv, env.handshake));
    const session = this.sessions.get(addr);
    if (!session) { this._maybeReestablish(env.from, env.fromDevice, env.roomId); return { from: env.from, roomId: env.roomId || null, error: 'нет сессии' }; }
    let obj;
    try { obj = JSON.parse(session.decrypt(deserializeMessage(env.payload))); }
    catch (e) {
      // Авто-восстановление: собеседник начал НОВУЮ сессию (сменил ключи /
      // переустановил) — конверт несёт свежий handshake. Пересобираем сессию из
      // него и пробуем снова, вместо «invalid tag».
      if (env.handshake) {
        try {
          const fresh = acceptSession(rIdentity, rPriv, env.handshake);
          obj = JSON.parse(fresh.decrypt(deserializeMessage(env.payload)));
          this.sessions.set(addr, fresh);
        } catch { this._maybeReestablish(env.from, env.fromDevice, env.roomId); return { from: env.from, roomId: env.roomId || null, error: e.message }; }
      } else {
        this._maybeReestablish(env.from, env.fromDevice, env.roomId);
        return { from: env.from, roomId: env.roomId || null, error: e.message };
      }
    }
    // Успешно расшифровали → сессия к этому устройству есть, перестаём слать handshake.
    this.pendingHandshake.delete(addr);
    const base = { from: env.from, roomId: env.roomId || null, msgId: env.msgId || obj.msgId || null };
    if (obj.t === 'hs') return { ...base, kind: 'hs' };   // служебный «пинг» переустановки сессии — UI игнорирует
    if (obj.t === 'text') return { ...base, kind: 'text', text: obj.body, preview: obj.preview || null };
    if (obj.t === 'att') { obj._origin = obj.origin || (env.from || '').split(':')[1] || null; return { ...base, kind: 'attachment', attachment: obj }; } // _origin — домен-владелец блоба (для федеративной подкачки; при пересылке берём явный origin)
    if (obj.t === 'gift') return { ...base, kind: 'gift', gift: { emoji: obj.emoji, name: obj.name, price: obj.price, msg: obj.msg || '', anon: !!obj.anon } };
    if (obj.t === 'call') return { ...base, kind: 'call', call: obj };
    if (obj.t === 'reaction') return { ...base, kind: 'reaction', target: obj.target || null, emoji: obj.emoji || null, on: !!obj.on, paid: obj.paid || 0 };
    if (obj.t === 'sync-sent') return { ...base, kind: 'sync-sent', peer: obj.to || null, roomId: obj.roomId || base.roomId || null, inner: obj.inner || null }; // MD3: копия своего исходящего (личка или группа)
    if (obj.t === 'sync-read') return { ...base, kind: 'sync-read', peer: obj.peer || null }; // MD4: чат прочитан на другом устройстве
    if (obj.t === 'alias') return { ...base, kind: 'alias', peer: obj.peer || null, name: obj.name || '' }; // локальный псевдоним контакта (между своими устройствами)
    return { ...base, kind: obj.t || 'unknown', data: obj };
  }
  // Не смогли расшифровать личное сообщение (нет сессии / чужой ключ) → сбрасываем
  // свою сессию и шлём свежий handshake-пинг, чтобы обе стороны переустановили
  // сессию. Не чаще раза в 15 с на собеседника (без циклов).
  _maybeReestablish(peerId, deviceId, roomId) {
    if (roomId || !peerId || peerId === this.userId) return;
    const addr = this._addr(peerId, deviceId);
    const now = Date.now();
    this._reest ||= {};
    if (this._reest[addr] && now - this._reest[addr] < 15000) return;
    this._reest[addr] = now;
    this.sessions.delete(addr); delete this._peerIdk[addr]; this.pendingHandshake.delete(addr);
    // hs-пинг разворачивается по всем устройствам собеседника → сессии пересоберутся.
    Promise.resolve().then(async () => { try { await this._sendWrapped(peerId, { t: 'hs' }); } catch {} });
  }
  async receive() {
    const data = await this._get(`/_prizrak/client/v1/inbox?since=${this.cursor}${this.deviceId ? `&device=${encodeURIComponent(this.deviceId)}` : ''}`);
    const out = [];
    for (const m of (data.messages || [])) { if (m.seq > this.cursor) this.cursor = m.seq; const d = this._decodeEnvelope(m.envelope); out.push(d); this._maybeAck(d); }
    for (const r of (data.receipts || [])) out.push({ kind: 'receipt', from: r.from, msgIds: r.msgIds, status: r.status });
    for (const d of (data.deletions || [])) out.push({ kind: 'delete', msgId: d.msgId, roomId: d.roomId || null });
    for (const room of (data.invites || [])) out.push({ kind: 'invited', room });
    return out;
  }
  /** История комнаты (или вся) начиная с seq. Для отрисовки при открытии. */
  async getHistory(roomId = null, since = 0) {
    const q = roomId ? `?roomId=${encodeURIComponent(roomId)}&since=${since}` : `?since=${since}`;
    const { messages } = await this._get('/_prizrak/client/v1/history' + q);
    return messages.map((m) => ({ seq: m.seq, ...this._decodeEnvelope(m.envelope) }));
  }

  // ── Верификация контактов (защита от MITM) ────────────────────────────────
  async getSafetyNumber(userId) {
    if (userId === this.userId) return { userId, fingerprint: this.identity.fingerprint, self: true };
    const bundle = await this.fetchBundle(userId);
    return { userId, fingerprint: fingerprintOf(bundle.pgpPublicKey) };
  }
  async markVerified(userId) { const { fingerprint } = await this.getSafetyNumber(userId); this.verified[userId] = fingerprint; return fingerprint; }
  unverify(userId) { delete this.verified[userId]; }
  /** 'verified' | 'unverified' | 'changed' (ключ собеседника сменился — тревога). */
  async verificationStatus(userId) {
    const { fingerprint } = await this.getSafetyNumber(userId);
    if (!this.verified[userId]) return { status: 'unverified', fingerprint };
    return { status: this.verified[userId] === fingerprint ? 'verified' : 'changed', fingerprint };
  }
  async contactShare(userId) { return this._get(`/_prizrak/client/v1/contact/share?userId=${encodeURIComponent(userId || this.userId)}`); }

  // ── Конфиденциальность (чёрный список, «Группы и каналы», «Звонки») ────────
  async getPrivacy() { const d = await this._get('/_prizrak/client/v1/privacy'); return d.privacy || { blocked: [], groups: 'all', groupsAllow: [], calls: 'all', callsAllow: [] }; }
  async setPrivacy(privacy) { const d = await this._post('/_prizrak/client/v1/privacy', { privacy }); return d.privacy; }

  // ── Профили и аватары ─────────────────────────────────────────────────────
  async getProfile(userId) { return this._get(`/_prizrak/client/v1/profile?userId=${encodeURIComponent(userId)}`); }
  async setProfile(fields) { return this._post('/_prizrak/client/v1/profile', fields); }
  async setRoomProfile(roomId, fields) { return this._post('/_prizrak/client/v1/rooms/profile', { roomId, ...fields }); }
  /** Настройки группы: {privacy, perms, permExceptions, slowModeSec, historyVisible}. */
  async setRoomSettings(roomId, settings) { return this._post('/_prizrak/client/v1/rooms/settings', { roomId, settings }); }
  /** G5: поиск публичных групп по подстроке (через свой сервер → реестр). */
  async searchGroups(q) { const d = await this._get(`/_prizrak/client/v1/groups/search?q=${encodeURIComponent(q)}`); return d.results || []; }
  async roomShare(roomId) { return this._get(`/_prizrak/client/v1/rooms/share?roomId=${encodeURIComponent(roomId)}`); }
  /** Диагностика доставки канала/группы (владелец/админ): до кого сервер достаёт. */
  async roomDiag(roomId) { return this._get(`/_prizrak/client/v1/rooms/diag?roomId=${encodeURIComponent(roomId)}`); }
  /** Принимает и https://…/?join=<id>, и prizrak://join/<id>, и join/<id>. */
  async joinByLink(link) {
    const s = String(link).trim();
    let id = null;
    const q = s.match(/[?&]join=([^&#]+)/); if (q) id = decodeURIComponent(q[1]);
    if (!id) { const m = s.match(/join[/#]([^?&#]+)/); if (m) id = decodeURIComponent(m[1]); }
    if (!id) throw new Error('Некорректная ссылка-приглашение');
    id = id.trim();
    try { return await this.join(id); }
    catch (e) {
      const dom = (id.split(':')[1] || '').trim(), myDom = (this.userId.split(':')[1] || '').trim();
      if (dom && myDom && dom !== myDom) throw new Error(`Эта комната на сервере «${dom}». Присоединяться пока можно только к комнатам своего сервера («${myDom}»).`);
      throw e;
    }
  }

  // ── Ретеншн и админ-хранилище ────────────────────────────────────────────
  async setRoomRetention(roomId, retention) { return this._post('/_prizrak/client/v1/rooms/retention', { roomId, retention }); }
  async adminStorage() { return this._get('/_prizrak/client/v1/admin/storage'); }
  async adminSetStorage(opts) { return this._post('/_prizrak/client/v1/admin/storage', opts); }

  // ── Real-time (WebSocket пуш, с fallback на опрос) ──────────────────────────
  // Импорт 'ws' ленивый: если пакет недоступен (напр. не попал в сборку) —
  // не падаем, а мгновенно переключаемся на HTTP-опрос. Приложение работает в
  // обоих режимах.
  async connectRealtime(onEvent) {
    this._rtStop = false;
    this._onEvent = onEvent;
    this._startSafetyPoll(); // страховочный опрос ПОВЕРХ WS — ловит «повисшие» сообщения,
                             // если WS молча пропустил событие (федерация, спящий сокет и т.п.)
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/_prizrak/ws?token=${this.token}&since=${this.cursor}${this.deviceId ? `&device=${encodeURIComponent(this.deviceId)}` : ''}`;
    const handleRaw = (raw) => {
      let m; try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
      if (m.type === 'message') { if (m.seq > this.cursor) this.cursor = m.seq; const d = this._decodeEnvelope(m.envelope); onEvent(d); this._maybeAck(d); }
      else if (m.type === 'receipt') onEvent({ kind: 'receipt', from: m.from, msgIds: m.msgIds, status: m.status });
      else if (m.type === 'ghosts') onEvent({ kind: 'ghosts', ...m });
      else if (m.type === 'ready') onEvent({ kind: 'ready' });
      else if (m.type === 'delete') onEvent({ kind: 'delete', msgId: m.msgId, roomId: m.roomId });
      else if (m.type === 'role') onEvent({ kind: 'role', roomId: m.roomId, role: m.role });
      else if (m.type === 'owner') onEvent({ kind: 'owner', roomId: m.roomId });
      else if (m.type === 'kicked') onEvent({ kind: 'kicked', roomId: m.roomId });
      else if (m.type === 'invited') onEvent({ kind: 'invited', room: m.room });
      else if (m.type === 'room-settings') onEvent({ kind: 'room-settings', roomId: m.roomId, room: m.room });
      else if (m.type === 'channel-post') { this._handleChannelPost(m.roomId, m.post, onEvent); }
      else if (m.type === 'channel-reaction') onEvent({ kind: 'channel-reaction', roomId: m.roomId, msgId: m.msgId, counts: m.counts, paid: m.paid });
      else if (m.type === 'channel-keyreq') { this.resyncChannelKeys(m.roomId).catch(() => {}); } // подписчику не хватает ключа — раздаём
    };
    const onDown = () => { this._stopHeartbeat(); if (!this._rtStop) { this._startPolling(onEvent); this._scheduleReconnect(); } };
    // 1) Нативный WebSocket (React Native / браузер): API в browser-стиле, без ping —
    //    живость обеспечивает страховочный опрос.
    const NativeWS = (typeof globalThis !== 'undefined' && typeof globalThis.WebSocket === 'function' && !globalThis.process?.versions?.node) ? globalThis.WebSocket : null;
    if (NativeWS) {
      try {
        const ws = new NativeWS(wsUrl);
        this.ws = ws; this._alive = true;
        ws.onopen = () => { this._stopFastPoll(); this._alive = true; };
        ws.onmessage = (ev) => handleRaw(ev.data);
        ws.onerror = onDown;
        ws.onclose = onDown;
        return ws;
      } catch { this._startPolling(onEvent); this._scheduleReconnect(); return null; }
    }
    // 2) Node (десктоп/сервер): пакет 'ws' с ping/pong-heartbeat.
    try {
      const mod = await import('ws');
      const WS = mod.default || mod;
      this.ws = new WS(wsUrl);
      this._alive = true;
      this.ws.on('pong', () => { this._alive = true; }); // сервер жив
      this.ws.on('open', () => { this._stopFastPoll(); this._alive = true; this._startHeartbeat(); }); // WS жив — частый fallback-опрос не нужен
      this.ws.on('message', handleRaw);
      this.ws.on('error', onDown);
      this.ws.on('close', onDown);
      return this.ws;
    } catch {
      this._startPolling(onEvent); this._scheduleReconnect(); // 'ws' недоступен — опрос + попытки поднять WS
    }
  }
  // Один «слив» входящих (без гонок: параллельные вызовы не плодят дубли).
  async _drainOnce() {
    if (this._draining || this._rtStop) return;
    this._draining = true;
    try { for (const m of await this.receive()) this._onEvent && this._onEvent(m); }
    catch {} finally { this._draining = false; }
  }
  // Медленный опрос-страховка (работает ВСЕГДА, даже при живом WS).
  _startSafetyPoll() {
    if (this._safety || this._rtStop) return;
    this._safety = setInterval(() => { this._drainOnce(); }, 15000);
  }
  // Частый опрос-fallback (пока WS не работает).
  _startPolling(onEvent) {
    if (this._onEvent !== onEvent && onEvent) this._onEvent = onEvent;
    if (this._poll || this._rtStop) return;
    this._poll = setInterval(() => { this._drainOnce(); }, 1500);
  }
  _stopFastPoll() { if (this._poll) { clearInterval(this._poll); this._poll = null; } }
  // Heartbeat: раз в 20 сек шлём ping. Если к следующему тику НЕ пришёл pong —
  // соединение «зомби» (Mac уснул, сеть моргнула, close не прилетел) → рвём и
  // переподключаемся, восстанавливая живой приём (сообщения, входящие звонки).
  _startHeartbeat() {
    this._stopHeartbeat();
    this._hb = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      if (this._alive === false) { try { this.ws.terminate ? this.ws.terminate() : this.ws.close(); } catch {} return; } // нет понга → мёртв
      this._alive = false;
      try { this.ws.ping(); } catch { try { this.ws.terminate?.(); } catch {} }
    }, 20000);
    if (this._hb.unref) this._hb.unref();
  }
  _stopHeartbeat() { if (this._hb) { clearInterval(this._hb); this._hb = null; } }
  // Быстрая проверка «жив ли WS» (напр. при фокусе окна / возврате сети). Если сокет
  // не OPEN — пересоздаём; если OPEN — сразу пингуем, чтобы поймать зомби без ожидания тика.
  pokeConnection() {
    if (this._rtStop) return;
    this._drainOnce(); // сразу подтянуть накопившиеся сообщения — не ждём тик поллинга/WS
    if (!this.ws || this.ws.readyState !== 1) { this.forceReconnect(); return; }
    this._alive = false; try { this.ws.ping(); } catch { this.forceReconnect(); }
  }
  // Принудительно пересоздать соединение (напр. при пробуждении Mac из сна).
  forceReconnect() {
    if (this._rtStop) return;
    this._stopHeartbeat();
    try { this.ws?.terminate ? this.ws.terminate() : this.ws?.close?.(); } catch {}
    this.ws = null;
    this._startPolling(this._onEvent); // пока WS поднимается — быстрый опрос
    if (this._reconnectT) { clearTimeout(this._reconnectT); this._reconnectT = null; }
    this.connectRealtime(this._onEvent).catch(() => {});
  }
  // Переподключение WS: не остаёмся навсегда на опросе, пробуем вернуть live-сокет.
  _scheduleReconnect() {
    if (this._rtStop || this._reconnectT) return;
    this._reconnectT = setTimeout(() => {
      this._reconnectT = null;
      if (this._rtStop) return;
      try { this.ws?.removeAllListeners?.(); this.ws?.close?.(); } catch {}
      this.ws = null;
      this.connectRealtime(this._onEvent).catch(() => {});
    }, 5000);
  }
  disconnectRealtime() {
    this._rtStop = true;
    if (this._poll) clearInterval(this._poll); this._poll = null;
    if (this._safety) clearInterval(this._safety); this._safety = null;
    if (this._reconnectT) clearTimeout(this._reconnectT); this._reconnectT = null;
    this._stopHeartbeat();
    try { this.ws?.close(); } catch {} this.ws = null;
  }
}
