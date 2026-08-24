// deaddrop-fed.js — федерация homeserver'ов через сеть тайников (Фаза 3).
// Когда прямой путь Д1→Д2 перерезан ТСПУ, конверт едет через промежуточные узлы-тайники:
//   • Отправитель ШИФРУЕТ федеративный пакет {path, body, from} на X25519-ключ сервера-получателя
//     (узел видит только шифртекст — не знает ни содержимого, ни маршрута).
//   • Адрес = «слепой ящик» mailbox=HKDF(recipientEdPub, epoch); узел не знает домен получателя.
//   • Раскладываем по RF узлам детерминированно (placement, как у тайника).
//   • Получатель поллит свой ящик, забирает, расшифровывает, ПЕРЕинжектит локально и шлёт ACK
//     (подпись Ed25519 — только владелец ящика вправе удалить блоб).
// Форматы (msgId/mailbox/ACK) 1:1 с packages/deaddrop.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { blake3 } from '@noble/hashes/blake3';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';

// ── Крипто-форматы (совместимо с узлом-тайником) ────────────────────────────
const MB_SALT = utf8ToBytes('prizrak/deaddrop/mailbox/v1');
const FED_SALT = utf8ToBytes('prizrak/deaddrop/fed/v1');
export const msgIdOf = (ct) => bytesToHex(blake3(ct));
export const mailboxOf = (edPubHex, epoch) => bytesToHex(hkdf(sha256, hexToBytes(edPubHex), MB_SALT, utf8ToBytes('epoch:' + epoch), 16));
// Фаза 6d — ОБЩИЙ широковещательный ящик директории серверов (публичный, вычисляется всеми
// одинаково). Директория едет поверх overlay теми же примитивами, что и сообщения.
export const directoryMailbox = (epoch) => bytesToHex(hkdf(sha256, utf8ToBytes('prizrak/deaddrop/directory/pub'), MB_SALT, utf8ToBytes('epoch:' + epoch), 16));
const ackMsg = (msgId) => utf8ToBytes('prizrak/dd/ack/v1:' + msgId);

// ── Фаза 6: закалка (форматы 1:1 с packages/deaddrop/src/hardening.js) ────────
// Паддинг полезной нагрузки до вёдер — длина сообщения не утекает по размеру блоба.
const BUCKETS = [256, 512, 1024, 4096, 16384, 65536, 262144, 1048576];
const bucketFor = (n) => { for (const b of BUCKETS) if (n <= b) return b; return Math.ceil(n / 1048576) * 1048576; };
function padTo(payload) {
  const p = payload instanceof Uint8Array ? payload : utf8ToBytes(String(payload));
  const out = new Uint8Array(bucketFor(p.length + 4));
  new DataView(out.buffer).setUint32(0, p.length); out.set(p, 4);
  return out;
}
function unpad(buf) {
  if (!buf || buf.length < 4) return buf || new Uint8Array(0);
  const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
  if (len > buf.length - 4) return buf.subarray(4);
  return buf.subarray(4, 4 + len);
}
// Proof-of-work admission-токен (H(msgId‖nonce) с ≥bits нулевых старших бит).
function leadingZeroBits(bytes) { let n = 0; for (const b of bytes) { if (b === 0) { n += 8; continue; } let x = b, c = 0; while ((x & 0x80) === 0) { c++; x <<= 1; } return n + c; } return n; }
const powHash = (msgId, nonce) => sha256(utf8ToBytes('prizrak/dd/pow/v1:' + msgId + ':' + nonce));
function powSolve(msgId, bits, max = 5e6) { if (!bits || bits <= 0) return '0'; for (let i = 0; i < max; i++) if (leadingZeroBits(powHash(String(msgId), String(i))) >= bits) return String(i); throw new Error('pow-timeout'); }
export const signAck = (edPriv, msgId) => bytesToHex(ed25519.sign(ackMsg(msgId), edPriv));
export const curEpoch = () => Math.floor(Date.now() / 86400000); // сутки

// Запечатать пакет на X25519-ключ получателя: [ephPub(32)][nonce(12)][ChaCha20Poly1305 ct].
export function seal(recipientXPubHex, plaintext) {
  const eph = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, hexToBytes(recipientXPubHex));
  const key = hkdf(sha256, shared, FED_SALT, new Uint8Array(0), 32);
  const nonce = randomBytes(12);
  const ct = chacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(32 + 12 + ct.length);
  out.set(ephPub, 0); out.set(nonce, 32); out.set(ct, 44);
  return out;
}
export function open(ownXPriv, blob) {
  if (blob.length < 44) throw new Error('short');
  const ephPub = blob.subarray(0, 32), nonce = blob.subarray(32, 44), ct = blob.subarray(44);
  const shared = x25519.getSharedSecret(ownXPriv, ephPub);
  const key = hkdf(sha256, shared, FED_SALT, new Uint8Array(0), 32);
  return chacha20poly1305(key, nonce).decrypt(ct);
}

// ── Идентичность сервера: Ed25519 (mailbox/ACK) + X25519 (шифрование) ─────────
export function loadServerIdentity(path) {
  if (existsSync(path)) {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return { edPriv: hexToBytes(j.edPriv), edPub: hexToBytes(j.edPub), edPubHex: j.edPub, xPriv: hexToBytes(j.xPriv), xPub: hexToBytes(j.xPub), xPubHex: j.xPub };
  }
  const edPriv = randomBytes(32), edPub = ed25519.getPublicKey(edPriv);
  const xPriv = x25519.utils.randomPrivateKey(), xPub = x25519.getPublicKey(xPriv);
  mkdirSync(dirname(path), { recursive: true });
  const j = { edPriv: bytesToHex(edPriv), edPub: bytesToHex(edPub), xPriv: bytesToHex(xPriv), xPub: bytesToHex(xPub) };
  writeFileSync(path, JSON.stringify(j, null, 2), { mode: 0o600 });
  return { edPriv, edPub, edPubHex: j.edPub, xPriv, xPub, xPubHex: j.xPub };
}
export const publicKeys = (id) => ({ ed: id.edPubHex, x: id.xPubHex });

// ── Директория серверов (Фаза 6a): подписанная запись homeserver'а ───────────
const srvRecBytes = (r) => utf8ToBytes(JSON.stringify({ domain: r.domain, keys: r.keys, endpoints: r.endpoints, addedAt: r.addedAt }));
export function makeServerRecord(identity, domain, endpoints, addedAt) {
  const base = { domain, keys: { ed: identity.edPubHex, x: identity.xPubHex }, endpoints: [...(endpoints || [])], addedAt: addedAt || Date.now() };
  return { ...base, sig: bytesToHex(ed25519.sign(srvRecBytes(base), identity.edPriv)) };
}
function verifyServerRecord(r) {
  if (!r || typeof r.domain !== 'string' || !r.keys || typeof r.keys.ed !== 'string' || typeof r.keys.x !== 'string' || !Array.isArray(r.endpoints) || typeof r.addedAt !== 'number' || typeof r.sig !== 'string') return false;
  try { return ed25519.verify(hexToBytes(r.sig), srvRecBytes(r), hexToBytes(r.keys.ed)); } catch { return false; }
}

// ── Реестр публичных групп (G5): подписанные записи для tech.prizrak.im ──────
// Запись подписана Ed25519-ключом сервера-дома группы. del:true = отзыв (unpublish).
const regRecBytes = (r) => utf8ToBytes(JSON.stringify({ roomId: r.roomId, domain: r.domain, name: r.name, description: r.description, members: r.members, type: r.type, updatedAt: r.updatedAt, ed: r.ed, del: !!r.del }));
export function makeGroupRecord(identity, { roomId, domain, name, description, members, type, updatedAt, del }) {
  const base = {
    roomId, domain,
    name: String(name || '').slice(0, 96),
    description: String(description || '').slice(0, 400),
    members: Math.max(0, Number(members) || 0),
    type: type === 'channel' ? 'channel' : 'group',
    updatedAt: updatedAt || Date.now(),
    ed: identity.edPubHex,
    del: !!del,
  };
  return { record: base, sig: bytesToHex(ed25519.sign(regRecBytes(base), identity.edPriv)) };
}
export function verifyGroupRecord(record, sig) {
  if (!record || typeof record.roomId !== 'string' || typeof record.domain !== 'string' || typeof record.ed !== 'string' || typeof sig !== 'string') return false;
  try { return ed25519.verify(hexToBytes(sig), regRecBytes(record), hexToBytes(record.ed)); } catch { return false; }
}

// ── Приватные bridge-узлы (Фаза 6c): «билет-мост» = подписанная запись узла (relayId) ────
// Раздаётся ВНЕ сети доверенным серверам; в общий реестр bridge себя не анонсирует, поэтому
// цензор его не выкачает. Формат билета 1:1 с registry.makeRecord: {relayId,endpoints,addedAt,sig}.
const bridgeBytes = (r) => utf8ToBytes(JSON.stringify({ relayId: r.relayId, endpoints: r.endpoints, addedAt: r.addedAt }));
export function verifyBridgeTicket(r) {
  if (!r || typeof r.relayId !== 'string' || !Array.isArray(r.endpoints) || typeof r.addedAt !== 'number' || typeof r.sig !== 'string') return false;
  try { return ed25519.verify(hexToBytes(r.sig), bridgeBytes(r), hexToBytes(r.relayId)); } catch { return false; }
}

// ── Детерминированное размещение (HRW, копия логики узла-тайника) ─────────────
function unitHash(msgId, relayId) {
  const h = sha256(utf8ToBytes(msgId + '|' + relayId));
  let v = 0; for (let i = 0; i < 6; i++) v = v * 256 + h[i];
  return Math.min((v + 1) / 2 ** 48, 1 - 1e-12);
}
function placement(msgId, nodes, rf) {
  const scored = nodes.map((n) => ({ relayId: n.relayId, group: n.group, s: 1 / -Math.log(unitHash(msgId, n.relayId)) })).sort((a, b) => b.s - a.s);
  const out = [], groups = new Set();
  for (const n of scored) { if (out.length >= rf) break; if (n.group && groups.has(n.group)) continue; out.push(n.relayId); if (n.group) groups.add(n.group); }
  if (out.length < rf) for (const n of scored) { if (out.length >= rf) break; if (!out.includes(n.relayId)) out.push(n.relayId); }
  return out;
}
const groupOf = (url) => { try { return new URL(url).hostname.split('.').slice(-2).join('.'); } catch { return url; } };
const clean = (u) => String(u || '').replace(/\/$/, '');

/**
 * Клиент федерации через тайники. Инъекции:
 *  - resolvePubkeys(domain) → { ed, x } публичные ключи сервера-получателя (или null).
 *  - onReceive(path, body, fromDomain) — переинжектить принятый пакет локально.
 *  - fetchImpl — необязательный fetch (для тестов).
 */
export class DeaddropFed {
  constructor({ identity, domain, seeds = [], rf = 4, ownEndpoints = [], peersCachePath = null, bridges = [], bridgesCachePath = null, powBits = 0, resolvePubkeys, onReceive, fetchImpl, log } = {}) {
    this.id = identity; this.domain = domain; this.rf = rf;
    this.powBits = Number(powBits) || 0;   // Фаза 6: PoW admission при PUT (0 = выкл)
    this.seeds = (seeds || []).map(clean).filter(Boolean);
    this.ownEndpoints = ownEndpoints;
    this.peersCachePath = peersCachePath;         // кэш ЖИВЫХ узлов (не конфиг!) — переживает рестарт
    this.bridgesCachePath = bridgesCachePath;     // кэш приватных мостов (тоже не конфиг)
    this.resolveFallback = resolvePubkeys || (async () => null);
    this.onReceive = onReceive || (() => {});
    this.f = fetchImpl || fetch;
    this.log = log || (() => {});
    this.nodes = [];              // [{ relayId, endpoint, group }] — ЖИВОЙ набор (из реестра+кэша)
    this.bridges = [];            // приватные bridge-узлы (всегда в наборе, НЕ гоняются по PEX)
    this.serverDir = new Map();    // domain → { keys, endpoints } (директория серверов)
    this.seen = new Set();        // обработанные msgId (антидубль)
    this._poll = null;
    this._loadPeersCache();
    this._loadBridgesCache();
    if (bridges && bridges.length) this.addBridges(bridges);
  }

  _loadBridgesCache() {
    if (!this.bridgesCachePath || !existsSync(this.bridgesCachePath)) return;
    try { const arr = JSON.parse(readFileSync(this.bridgesCachePath, 'utf8')); if (Array.isArray(arr)) this.bridges = arr.filter((n) => n && n.relayId && n.endpoint); } catch {}
  }
  _saveBridgesCache() { if (this.bridgesCachePath) { try { writeFileSync(this.bridgesCachePath, JSON.stringify(this.bridges)); } catch {} } }

  // Принять «билеты-мосты»: подписанные записи узлов ИЛИ {relayId,endpoint(s)}. Возвращает число новых.
  // ВАЖНО: чтобы placement совпал у двух серверов, оба должны иметь ОДИН И ТОТ ЖЕ мост.
  addBridges(list) {
    const by = new Map(this.bridges.map((b) => [b.relayId, b]));
    let added = 0;
    for (const item of (list || [])) {
      let relayId, endpoint;
      if (item && item.sig && item.relayId) { if (!verifyBridgeTicket(item)) continue; relayId = item.relayId; endpoint = clean(item.endpoints && item.endpoints[0]); }
      else if (item && item.relayId) { relayId = item.relayId; endpoint = clean(item.endpoint || (item.endpoints && item.endpoints[0])); }
      if (!relayId || !endpoint) continue;
      if (!by.has(relayId)) added++;
      by.set(relayId, { relayId, endpoint, group: groupOf(endpoint), bridge: true });
    }
    this.bridges = [...by.values()];
    this._saveBridgesCache();
    return added;
  }

  _loadPeersCache() {
    if (!this.peersCachePath || !existsSync(this.peersCachePath)) return;
    try { const arr = JSON.parse(readFileSync(this.peersCachePath, 'utf8')); if (Array.isArray(arr)) this.nodes = arr.filter((n) => n && n.relayId && n.endpoint); } catch {}
  }
  _savePeersCache() {
    if (!this.peersCachePath) return;
    try { writeFileSync(this.peersCachePath, JSON.stringify(this.nodes)); } catch {}
  }

  ep(relayId) { const n = this.nodes.find((x) => x.relayId === relayId); return n ? n.endpoint : null; }

  // Живой набор узлов: peer-exchange (спрашиваем реестр у СИДОВ И у уже известных узлов) + кэш.
  // Так смена узлов не требует правок конфига, а смерть сидов не рвёт связь, пока жив хоть один узел.
  async refreshNodes() {
    const map = new Map();
    for (const n of this.nodes) map.set(n.relayId, n);           // база — уже известные (из кэша)
    const sources = new Set([...this.seeds, ...this.nodes.map((n) => n.endpoint)]);
    for (const s of sources) {
      try {
        const j = await (await this.f(s + '/registry/list', { signal: AbortSignal.timeout(5000) })).json();
        for (const r of (j.records || [])) {
          const url = clean(r.endpoints && r.endpoints[0]);
          // Фаза 6: домен отказа — ПОДПИСАННАЯ метка group (если оператор задал), иначе суффикс хоста.
          if (r.relayId && url) map.set(r.relayId, { relayId: r.relayId, endpoint: url, group: r.group || groupOf(url) });
        }
      } catch {}
    }
    // Свежая сеть с пустым реестром — берём сами сиды как узлы (relayId из /dd/health).
    if (!map.size) for (const s of this.seeds) {
      try { const h = await (await this.f(s + '/dd/health', { signal: AbortSignal.timeout(5000) })).json(); if (h.nodeId) map.set(h.nodeId, { relayId: h.nodeId, endpoint: s, group: groupOf(s) }); } catch {}
    }
    // Приватные bridge-узлы ВСЕГДА в наборе (они не приходят по PEX и не удаляются им).
    for (const b of this.bridges) map.set(b.relayId, { relayId: b.relayId, endpoint: b.endpoint, group: b.group, bridge: true });
    this.nodes = [...map.values()];
    this._savePeersCache();
    return this.nodes.length;
  }

  // Директория серверов: анонсируем себя узлам и подтягиваем чужие подписанные записи.
  // Два пути: (a) control-plane /directory/* (6a) и (b) ПОВЕРХ overlay — те же PUT/POLL/GET,
  // что несут сообщения (6d, dogfooding). Overlay-путь так же цензуростоек, как доставка.
  async syncDirectory() {
    await this.refreshNodes();
    if (!this.nodes.length) return { servers: this.serverDir.size };
    const rec = makeServerRecord(this.id, this.domain, this.ownEndpoints);
    for (const n of this.nodes) {
      try { await this.f(n.endpoint + '/directory/announce', { method: 'POST', body: JSON.stringify({ records: [rec] }), signal: AbortSignal.timeout(5000) }); } catch {}
      try {
        const j = await (await this.f(n.endpoint + '/directory/list', { signal: AbortSignal.timeout(5000) })).json();
        for (const r of (j.records || [])) if (verifyServerRecord(r)) this.serverDir.set(r.domain, { keys: r.keys, endpoints: r.endpoints, addedAt: r.addedAt });
      } catch {}
    }
    if (this.overlayDirectory !== false) {
      try { await this.publishDirectoryOverlay(rec); } catch {}
      try { await this.pullDirectoryOverlay(); } catch {}
    }
    return { servers: this.serverDir.size };
  }

  // Фаза 6d — публикация своей записи в директорию ПОВЕРХ overlay: подписанная запись сервера
  // (публичная, шифровать не нужно) кладётся как блоб в ОБЩИЙ широковещательный ящик директории
  // тем же PUT, что и сообщения. Без ACK — живёт до TTL, обновляется каждым syncDirectory.
  async publishDirectoryOverlay(_rec) {
    const epoch = curEpoch();
    // ВАЖНО: запись СТАБИЛЬНА в пределах эпохи (сутки) — addedAt привязан к эпохе, а не к now().
    // Иначе каждый цикл syncDirectory (раз в ~15с) давал бы новый msgId и новый блоб → узлы
    // копили бы тысячи одинаковых визиток. Со стабильным addedAt это ОДИН блоб на сервер в сутки
    // (контент-адресация схлопывает повторные PUT).
    const record = makeServerRecord(this.id, this.domain, this.ownEndpoints, epoch * 86400000);
    const blob = utf8ToBytes(JSON.stringify(record));
    const msgId = msgIdOf(blob);
    const mailbox = directoryMailbox(epoch);
    // Директории живут коротко: poll смотрит эпохи [epoch, epoch-1], поэтому 2 суток + час хватает,
    // а старые визитки быстро выметаются sweep'ом (без ACK они иначе висели бы весь TTL).
    const expiry = Date.now() + 2 * 86400000 + 3600000;
    const target = placement(msgId, this.nodes, this.rf);
    let replicas = 0;
    for (const rid of target) {
      const base = this.ep(rid); if (!base) continue;
      try { if (await this._put(base, { msgId, mailbox, epoch, expiry, blob })) replicas++; } catch {}
    }
    return { replicas };
  }

  // Подтянуть директорию ПОВЕРХ overlay: опрашиваем широковещательный ящик директории на всех
  // узлах, забираем блобы, проверяем подпись записи → serverDir. (Публичная инфа — не расшифровка.)
  async pullDirectoryOverlay() {
    if (!this._dirSeen) this._dirSeen = new Set();
    const mailboxes = [curEpoch(), curEpoch() - 1].map((e) => directoryMailbox(e));
    let learned = 0;
    for (const node of this.nodes) {
      for (const mailbox of mailboxes) {
        let items = [];
        try { const j = await (await this.f(node.endpoint + '/dd/poll', { method: 'POST', body: JSON.stringify({ mailbox }), signal: AbortSignal.timeout(5000) })).json(); items = j.items || []; } catch { continue; }
        for (const it of items) {
          const msgId = it.msgId;
          const seenKey = node.endpoint + ':' + msgId;
          if (this._dirSeen.has(msgId)) continue;
          let blob; try { const r = await this.f(node.endpoint + '/dd/get/' + msgId, { signal: AbortSignal.timeout(8000) }); if (!r.ok) continue; blob = new Uint8Array(await r.arrayBuffer()); } catch { continue; }
          if (msgIdOf(blob) !== msgId) continue;
          let rec; try { rec = JSON.parse(Buffer.from(blob).toString()); } catch { continue; }
          this._dirSeen.add(msgId);
          if (verifyServerRecord(rec)) { this.serverDir.set(rec.domain, { keys: rec.keys, endpoints: rec.endpoints, addedAt: rec.addedAt }); learned++; }
        }
      }
    }
    return { learned };
  }

  // Ключи получателя: сперва из директории тайников (без прямого доступа к нему!), затем фоллбэк
  // (discovery/конфиг).
  async _keysFor(dom) {
    const d = this.serverDir.get(dom);
    if (d && d.keys && d.keys.ed && d.keys.x) return d.keys;
    return await this.resolveFallback(dom);
  }

  // PUT блоба на узел с admission-PoW (Фаза 6), если он включён. Возвращает true при ok.
  async _put(base, { msgId, mailbox, epoch, expiry, blob }) {
    const headers = { 'x-dd-msgid': msgId, 'x-dd-mailbox': mailbox, 'x-dd-epoch': String(epoch), 'x-dd-expiry': String(expiry) };
    if (this.powBits > 0) headers['x-dd-pow'] = powSolve(msgId, this.powBits);
    const r = await this.f(base + '/dd/put', { method: 'PUT', headers, body: Buffer.from(blob), signal: AbortSignal.timeout(8000) });
    const j = await r.json(); return !!j.ok;
  }

  /** Отправить федеративный пакет получателю через тайники. Возвращает {ok, replicas, msgId}. */
  async send(recipientDomain, path, body) {
    const pk = await this._keysFor(recipientDomain);
    if (!pk || !pk.ed || !pk.x) return { ok: false, reason: 'no-pubkey' };
    await this.refreshNodes();
    if (!this.nodes.length) return { ok: false, reason: 'no-nodes' };
    const epoch = curEpoch();
    // Фаза 6: паддинг открытого текста до ведра → длина сообщения не утекает по размеру блоба.
    const blob = seal(pk.x, padTo(utf8ToBytes(JSON.stringify({ path, body, from: this.domain }))));
    const msgId = msgIdOf(blob);
    const mailbox = mailboxOf(pk.ed, epoch);
    const expiry = Date.now() + 7 * 86400000;
    const target = placement(msgId, this.nodes, this.rf);
    let replicas = 0;
    for (const rid of target) {
      const base = this.ep(rid); if (!base) continue;
      try { if (await this._put(base, { msgId, mailbox, epoch, expiry, blob })) replicas++; } catch {}
    }
    if (replicas) this.log(`[deaddrop-fed] ${this.domain}→${recipientDomain} через тайники: ${replicas}/${target.length} реплик, msgId=${msgId.slice(0, 12)}`);
    return { ok: replicas > 0, replicas, msgId };
  }

  /** Опросить свои ящики на всех узлах, забрать/расшифровать/переинжектить/подтвердить. */
  async pollOnce() {
    await this.refreshNodes();
    if (!this.nodes.length) return { got: 0 };
    const mailboxes = [curEpoch(), curEpoch() - 1].map((e) => mailboxOf(this.id.edPubHex, e));
    let got = 0;
    for (const node of this.nodes) {
      for (const mailbox of mailboxes) {
        let items = [];
        try { const j = await (await this.f(node.endpoint + '/dd/poll', { method: 'POST', body: JSON.stringify({ mailbox }), signal: AbortSignal.timeout(5000) })).json(); items = j.items || []; } catch { continue; }
        for (const it of items) {
          const msgId = it.msgId;
          if (this.seen.has(msgId)) { this._ack(node.endpoint, msgId); continue; }
          let blob; try { const r = await this.f(node.endpoint + '/dd/get/' + msgId, { signal: AbortSignal.timeout(8000) }); if (!r.ok) continue; blob = new Uint8Array(await r.arrayBuffer()); } catch { continue; }
          if (msgIdOf(blob) !== msgId) continue;            // целостность
          let pkt; try { pkt = JSON.parse(Buffer.from(unpad(open(this.id.xPriv, blob))).toString()); } catch { continue; } // не нам/битый
          this.seen.add(msgId);
          try { await this.onReceive(pkt.path, pkt.body, pkt.from); got++; } catch {}
          this._ack(node.endpoint, msgId);
          this.log(`[deaddrop-fed] ${this.domain} принял через тайник ${pkt.path} от ${pkt.from}`);
        }
      }
    }
    return { got };
  }
  async _ack(base, msgId) {
    try { await this.f(base + '/dd/ack', { method: 'POST', body: JSON.stringify({ msgId, pub: this.id.edPubHex, sig: signAck(this.id.edPriv, msgId) }), signal: AbortSignal.timeout(5000) }); } catch {}
  }

  start(pollMs = 15000) {
    if (this._poll) return;
    this.syncDirectory().catch(() => {});   // анонс себя + подтянуть директорию серверов
    this.pollOnce().catch(() => {});
    this._poll = setInterval(() => { this.syncDirectory().catch(() => {}); this.pollOnce().catch(() => {}); }, pollMs);
    this._poll.unref?.();
  }
  stop() { if (this._poll) clearInterval(this._poll); this._poll = null; }
}
