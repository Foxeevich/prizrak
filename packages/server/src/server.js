// server.js — Prizrak homeserver (v1.3).
// К 1.2 добавлено:
//   • Хранимая ЗАШИФРОВАННАЯ история сообщений с курсором (seq) — переживает
//     перезапуск клиента; доставка «пропущенного» при переподключении.
//   • Ретеншн: глобальный максимум (админ) + per-room срок, КЛАМПится к админскому.
//   • Хранилище медиа: несколько путей, добавление пути, общий лимит размера.
//   • Вывод версии сервера при старте.
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createRelay } from '../../relay/src/relay.js';
import { createRendezvous } from '../../relay/src/rendezvous.js';
import { loadServerIdentity, publicKeys, DeaddropFed, makeGroupRecord } from './deaddrop-fed.js';
import { Bootstrap, channelsFromConfig } from './bootstrap.js';
import { Store } from './store.js';
import { StorageManager } from './storage.js';
import { loadConfig } from './config.js';
import { parseUserId, hashPassword, verifyPassword, newToken } from './accounts.js';
import { makeRoom, canPost, addParticipant, removeParticipant, publicView, canManage, canModerate, setRole, transferOwner, kick, ban, unban, setReadOnly, isBanned, isParticipant, setRoomReactions, setRoomSettings, memberCan } from './rooms.js';
import { retentionSeconds, clampRetention, isValidRetention } from './retention.js';

function readVersion() {
  try { return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'VERSION'), 'utf8').trim(); }
  catch { return 'dev'; }
}

export function createServer(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  const { domain } = cfg;
  const VERSION = readVersion();
  const store = new Store(cfg.storePath);
  const mediaDir = cfg.storagePaths || [join(cfg.storePath ? dirname(cfg.storePath) : './data', 'media')];
  const storage = new StorageManager({ paths: mediaDir, maxBytes: cfg.storageMaxBytes });

  const domainOf = (u) => u.split(':')[1];
  const isLocal = (u) => domainOf(u) === domain;

  // ── Криптоидентичность сервера + федерация через сеть тайников (Фаза 3, опционально) ──
  // Ed25519 (mailbox/ACK) + X25519 (шифрование сервер→сервер). Публикуется в discovery.
  const dataDir = cfg.storePath ? dirname(cfg.storePath) : './data';
  const serverIdentity = loadServerIdentity(join(dataDir, 'server-identity.json'));
  // Админы сервера: ник ЛЮБОЙ (не обязательно root), можно несколько. Права даёт (а) флаг isAdmin
  // в аккаунте (в т.ч. выданный на лету), либо (б) совпадение с cfg.admins (localpart или полный id).
  const adminSet = new Set((cfg.admins || []).filter(Boolean));
  const isAdminUser = (uid) => {
    if (!uid) return false;
    const a = store.getAccount(uid);
    if (a && a.isAdmin) return true;
    return adminSet.has(uid) || adminSet.has(String(uid).split(':')[0]);
  };
  const ddNodes = (cfg.deaddropNodes || process.env.DD_NODES || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  const _pubkeyCache = new Map(); // domain → {ed,x}
  async function resolvePubkeys(dom) {
    if (dom === domain) return publicKeys(serverIdentity);
    if (_pubkeyCache.has(dom)) return _pubkeyCache.get(dom);
    try {
      const base = await resolveBaseUrl(dom);
      const j = await (await fetch(base + '/.well-known/prizrak/server', { signal: AbortSignal.timeout(4000) })).json();
      if (j && j.keys && j.keys.ed && j.keys.x) { _pubkeyCache.set(dom, j.keys); return j.keys; }
    } catch {}
    if (cfg.deaddropKeys && cfg.deaddropKeys[dom]) { _pubkeyCache.set(dom, cfg.deaddropKeys[dom]); return cfg.deaddropKeys[dom]; }
    return null;
  }
  // Фаза 6b — мультиканальный подписанный бутстрап сидов (корень доверия вшит, каналы — DoH/HTTPS/baked).
  let bootstrap = null;
  const bootCfg = cfg.deaddropBootstrap;
  if (bootCfg && bootCfg.maintainerPub) {
    bootstrap = new Bootstrap({
      maintainerPubHex: bootCfg.maintainerPub,
      channels: channelsFromConfig(bootCfg),
      cachePath: join(dataDir, 'deaddrop-bootstrap.json'),      // кэш последнего валидного бандла
      log: (...a) => console.log(...a),
    });
  }
  let ddfed = null;
  if (ddNodes.length || bootstrap) {
    ddfed = new DeaddropFed({
      identity: serverIdentity, domain, seeds: ddNodes,
      rf: Number(cfg.deaddropRF || process.env.DD_RF || 4),
      ownEndpoints: [cfg.resolver[domain] || `https://${domain}`], // как нас видят другие серверы
      peersCachePath: join(dataDir, 'deaddrop-peers.json'),        // ЖИВОЙ кэш узлов (не конфиг)
      bridges: cfg.deaddropBridges || [],                          // приватные bridge-узлы (Фаза 6c)
      bridgesCachePath: join(dataDir, 'deaddrop-bridges.json'),
      powBits: cfg.deaddropPowBits || 0,                           // admission-PoW (Фаза 6)
      resolvePubkeys,
      onReceive: async (path, body, from) => {
        // Переинжект принятого пакета в СВОЙ же сервер (loopback) — как обычный федеративный POST.
        try { await fetch(`http://127.0.0.1:${cfg.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-prizrak-origin': from || '' }, body: JSON.stringify(body) }); } catch {}
      },
      log: (...a) => console.log(...a),
    });
  }

  // Эффективный ретеншн для записи истории (кламп per-room к админскому).
  function effectiveSecondsFor(entry) {
    let name = cfg.historyRetention;
    if (entry.roomId) { const r = store.getRoom(entry.roomId); if (r?.retention) name = clampRetention(r.retention, cfg.historyRetention); }
    return retentionSeconds(name);
  }
  function pruneAll() {
    const removed = store.pruneHistory(effectiveSecondsFor);
    const media = storage.pruneOlderThan(retentionSeconds(cfg.historyRetention));
    return { history: removed, media };
  }

  // Live WebSocket
  const live = new Map();
  // Presence: online = есть живой WS; иначе — сохранённый lastSeen.
  function presenceOf(userId) { const online = live.has(userId); return { online, lastSeen: online ? Date.now() : store.getLastSeen(userId) }; }
  // Сколько участников комнаты сейчас онлайн (на ЭТОМ сервере; федеративных членов не считаем).
  function roomOnlineCount(room) {
    if (!room) return 0;
    const uniq = new Set([room.owner, ...(room.admins || []), ...(room.moderators || []), ...(room.members || []), ...(room.subscribers || [])].filter(Boolean));
    let n = 0; for (const u of uniq) if (live.has(u)) n++; return n;
  }
  // MD2: конверт с toDevice пушим ТОЛЬКО на сокет этого устройства (иначе — всем сокетам юзера).
  function notify(userId, entry) { const set = live.get(userId); if (set) for (const ws of set) { if (entry.toDevice != null && ws._deviceId !== entry.toDevice) continue; try { ws.send(JSON.stringify({ type: 'message', envelope: entry.envelope, seq: entry.seq })); } catch {} } }
  function notifyEvent(userId, obj) { const set = live.get(userId); if (set) for (const ws of set) { try { ws.send(JSON.stringify(obj)); } catch {} } }
  // Возвращает true, если сообщение НОВОЕ (не дубль) — для антидубля при ретраях.
  // Заблокирован ли sender у target (чёрный список из настроек «Конфиденциальность»).
  function isBlockedBy(target, sender) {
    if (!sender || sender === target) return false;
    const pv = store.getPrivacy(target);
    return !!(pv && Array.isArray(pv.blocked) && pv.blocked.includes(sender));
  }
  function deliverLocal(envelope) {
    // Приватность: ЛИЧНЫЕ конверты от заблокированных — молча в никуда (отправителю
    // отвечаем как обычно, чтобы факт блокировки не палился). Группы не трогаем.
    if (!envelope.roomId && isBlockedBy(envelope.to, envelope.from)) return true;
    // «Контакты» получателя (для режима «Мои контакты»): кому Я писал — тот мой контакт.
    if (!envelope.roomId && envelope.from && envelope.from !== envelope.to) store.addPeer(envelope.from, envelope.to);
    if (store.hasMessage(envelope.to, envelope.msgId, envelope.toDevice || null)) return false; // уже доставляли на это устройство (ретрай) — не плодим копию
    const entry = store.appendHistory(envelope.to, { roomId: envelope.roomId || null, envelope }); notify(envelope.to, entry);
    return true;
  }

  // C3: резолв адреса другого сервера. Явная запись в resolver (или домен с портом) —
  // как есть. Иначе сканируем стабильные порты (как клиент) и кэшируем результат,
  // чтобы не опрашивать на каждой федеративной операции.
  const FED_PORTS = Array.isArray(cfg.ports) && cfg.ports.length ? [...new Set([443, ...cfg.ports])] : [443, 8801, 80, 993, 995, 587, 465, 143, 110, 25];
  const _fedCache = new Map(); // dom → { base, at }
  const _slowLast = new Map(); // `${roomId} ${userId}` → ts последней отправки (медленный режим)
  async function _probeFed(url) {
    try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000); const r = await fetch(url + '/_prizrak/client/v1/config', { signal: c.signal }); clearTimeout(t); return r.ok; } catch { return false; }
  }
  async function resolveBaseUrl(dom) {
    const fixed = cfg.resolver[dom]; if (fixed) return fixed;
    if (/:\d+$/.test(dom)) return `https://${dom}`;
    const c = _fedCache.get(dom); if (c && Date.now() - c.at < 300000) return c.base;
    const urls = FED_PORTS.map((p) => `${p === 443 ? 'https' : 'http'}://${dom}:${p}`);
    const oks = await Promise.all(urls.map(async (u) => (await _probeFed(u)) ? u : null));
    const base = oks.find(Boolean) || `https://${dom}`;
    _fedCache.set(dom, { base, at: Date.now() });
    return base;
  }
  // Универсальный POST на чужой сервер. При неудаче кладём в очередь (store-and-forward)
  // и повторим позже — сообщение не теряется, если сервер получателя сейчас выключен.
  async function federationPost(targetDomain, path, body, { queue = true } = {}) {
    try {
      const base = await resolveBaseUrl(targetDomain);
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-prizrak-origin': domain }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { ok: true };
    } catch (e) {
      // Прямой путь недоступен (напр. IP забанен на ТСПУ) → пробуем через сеть тайников.
      if (ddfed) { try { const r = await ddfed.send(targetDomain, path, body); if (r.ok) return { ok: true, viaDeaddrop: true, replicas: r.replicas }; } catch {} }
      if (queue) store.enqueueOutbox({ id: newToken().slice(0, 16), domain: targetDomain, path, body, at: Date.now(), attempts: 1 });
      return { ok: false, queued: queue };
    }
  }
  async function federateSend(envelope) { return federationPost(domainOf(envelope.to), '/_prizrak/federation/v1/send', envelope); }

  // ── Кросс-серверные комнаты ────────────────────────────────────────────────
  // Комната «живёт» на сервере из её id (!hex:домашний-домен). Операции над
  // чужой комнатой уходят на её домашний сервер по федерации, где выполняются
  // от имени me (доверие между серверами, как и вся федерация).
  const roomDomainOf = (roomId) => (String(roomId || '').split(':')[1] || domain);
  const isRoomLocal = (roomId) => roomDomainOf(roomId) === domain;
  async function federateRoomOp(roomId, payload) {
    try {
      const base = await resolveBaseUrl(roomDomainOf(roomId));
      const res = await fetch(`${base}/_prizrak/federation/v1/room-op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-prizrak-origin': domain }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    } catch { return { status: 502, data: { error: 'Домашний сервер комнаты недоступен' } }; }
  }
  // Диагностика доставки: по каждому участнику проверяем, достаёт ли ДО НЕГО сервер
  // (бандл-ключ) и есть ли у него ключ канала. Показывает истинную причину «нет ключа».
  async function channelDiag(room, me) {
    const members = [...new Set([room.owner, ...(room.admins || []), ...(room.subscribers || []), ...(room.members || [])])].filter((u) => u && u !== me);
    // Ключ канала теперь общий, лежит на сервере: если он есть для текущей эпохи —
    // ЛЮБОЙ участник заберёт его сам (владелец онлайн не нужен).
    const secretOnServer = room.type === 'channel' ? !!store.getChannelSecrets(room.id)[String(room.keyEpoch || 1)] : null;
    const report = [];
    for (const u of members) {
      const dom = (u.split(':')[1] || '');
      const local = dom === domain;
      let bundleOk = false, reason = '';
      if (local) { bundleOk = !!store.getUser(u); if (!bundleOk) reason = 'нет опубликованного ключа на этом сервере (пусть перезайдёт)'; }
      else {
        // Никакого ручного resolver не требуется: как и реальная доставка,
        // находим призрака авто-обнаружением по стандартным портам (resolveBaseUrl).
        try {
          const base = await resolveBaseUrl(dom);
          const r = await fetch(`${base}/_prizrak/federation/v1/bundle?userId=${encodeURIComponent(u)}`, { signal: AbortSignal.timeout(6000) });
          bundleOk = r.ok;
          if (!r.ok) reason = `сервер «${dom}» отвечает (${base}), но ключ пользователя не найден (HTTP ${r.status}) — пусть перезайдёт на своём сервере`;
        } catch { reason = `не достучались до «${dom}» на стандартных портах призрака (${FED_PORTS.join('/')}) — проверьте, что там слушает призрак и порт открыт в firewall`; }
      }
      // Ключ доступен участнику, если он на сервере (общий) ИЛИ есть его личный wrapped-грант.
      const hasKey = room.type === 'channel' ? (secretOnServer || Object.keys(store.getChannelKeys(room.id, u) || {}).length > 0) : null;
      report.push({ user: u, local, reachable: bundleOk, hasKey, reason });
    }
    return report;
  }
  // Изменение реакций → всем участникам (локальным по WS, чужим по федерации).
  function notifyReaction(room, msgId) {
    const sum = store.reactionSummary(room.id, msgId);
    for (const u of new Set([room.owner, ...(room.admins || []), ...(room.subscribers || []), ...(room.members || [])].filter(Boolean))) {
      const ev = { type: 'channel-reaction', roomId: room.id, msgId, counts: sum.counts, paid: sum.paid };
      if (isLocal(u)) notifyEvent(u, ev); else federationPost(domainOf(u), '/_prizrak/federation/v1/channel-evt', { to: u, ev }).catch(() => {});
    }
  }
  // Разослать пост канала: локальным по WS, участникам с других серверов по федерации.
  function fanoutChannelPost(room, from, post) {
    const recips = new Set([room.owner, ...(room.admins || []), ...(room.subscribers || []), ...(room.members || [])].filter(Boolean));
    recips.delete(from);
    for (const u of recips) {
      const ev = { type: 'channel-post', roomId: room.id, post };
      if (isLocal(u)) notifyEvent(u, ev); else federationPost(domainOf(u), '/_prizrak/federation/v1/channel-evt', { to: u, ev }).catch(() => {});
    }
  }
  // Ядро операций над ЛОКАЛЬНОЙ комнатой → {status, data}. Используется и напрямую
  // (клиент своего сервера), и по федерации (когда комната здесь «дома»).
  function roomOp(op, me, p) {
    const room = store.getRoom(p.roomId);
    if (!room) return { status: 404, data: { error: 'Комната не найдена' } };
    const isPart = isParticipant(room, me) || room.owner === me;
    switch (op) {
      case 'get': return { status: 200, data: { ...publicView(room), online: roomOnlineCount(room) } };
      case 'join':
        if (isBanned(room, me)) return { status: 403, data: { error: 'Вы забанены в этой комнате' } };
        addParticipant(room, me); store.saveRoom(room); return { status: 200, data: publicView(room) };
      case 'leave': removeParticipant(room, me); store.saveRoom(room); return { status: 200, data: { ok: true } };
      case 'invite': {
        const mayInvite = canManage(room, me) || (room.type === 'group'
          ? (room.members.includes(me) && memberCan(room, me, 'addMembers'))
          : room.admins.includes(me));
        if (!mayInvite) return { status: 403, data: { error: 'Нет прав приглашать участников' } };
        if (isBanned(room, p.userId)) return { status: 403, data: { error: 'Пользователь забанен в этой комнате' } };
        addParticipant(room, p.userId); store.saveRoom(room); routeInvite(p.userId, publicView(room)); return { status: 200, data: publicView(room) };
      }
      case 'settings': {
        const wasPublic = room.privacy === 'public';
        try { setRoomSettings(room, me, p.settings || {}); } catch (e) { return { status: 403, data: { error: e.message } }; }
        store.saveRoom(room);
        // G5: смена приватности → сразу публикуем/отзываем запись в реестре поиска.
        const isPublic = room.privacy === 'public';
        if (isPublic !== wasPublic) registryPublishRoom(room, !isPublic).catch(() => {});
        else if (isPublic) registryPublishRoom(room).catch(() => {}); // публичная: обновить имя/описание
        // Уведомляем участников об изменении настроек (клиент обновит вид/права).
        for (const u of new Set([room.owner, ...(room.admins || []), ...(room.members || []), ...(room.subscribers || [])].filter(Boolean))) {
          if (isLocal(u)) notifyEvent(u, { type: 'room-settings', roomId: room.id, room: publicView(room) });
          else federationPost(domainOf(u), '/_prizrak/federation/v1/channel-evt', { to: u, ev: { type: 'room-settings', roomId: room.id, room: publicView(room) } }).catch(() => {});
        }
        return { status: 200, data: publicView(room) };
      }
      case 'send': {
        if (!canPost(room, me)) return { status: 403, data: { error: 'В этой комнате вам нельзя писать' } };
        // Медленный режим: рядовой участник группы не чаще раза в slowModeSec.
        if (room.type === 'group' && room.slowModeSec > 0 && !canManage(room, me)) {
          const key = room.id + ' ' + me; const now = Date.now(); const last = _slowLast.get(key) || 0;
          const waitMs = room.slowModeSec * 1000 - (now - last);
          if (waitMs > 0) return { status: 429, data: { error: 'Медленный режим: подождите', retryAfterSec: Math.ceil(waitMs / 1000) } };
          _slowLast.set(key, now);
        }
        for (const env of (p.envelopes || [])) deliver({ ...env, from: me, roomId: room.id, type: env.type || 'room-message' });
        return { status: 200, data: { ok: true, fanout: (p.envelopes || []).length } };
      }
      case 'channel-history':
        if (!isPart) return { status: 403, data: { error: 'Вы не участник' } };
        return { status: 200, data: { posts: store.channelHistory(room.id, Number(p.since || 0)) } };
      case 'channel-keys':
        if (!isPart) return { status: 403, data: { error: 'Вы не участник' } };
        return { status: 200, data: { keys: store.getChannelKeys(room.id, me) } };
      case 'channel-secret': // серверный общий ключ канала — выдаётся любому участнику (без владельца-онлайн)
        if (!isPart) return { status: 403, data: { error: 'Вы не участник' } };
        return { status: 200, data: { secrets: store.getChannelSecrets(room.id) } };
      case 'channel-set-secret': // сохранить общий ключ канала (владелец/админ)
        if (!canManage(room, me)) return { status: 403, data: { error: 'Управлять ключом канала может владелец или админ' } };
        for (const [ep, hex] of Object.entries(p.secrets || {})) if (hex) store.setChannelSecret(room.id, ep, hex);
        return { status: 200, data: { ok: true } };
      case 'channel-grant':
        if (!canManage(room, me)) return { status: 403, data: { error: 'Раздавать ключи канала может владелец или админ' } };
        for (const g of p.grants || []) store.grantChannelKeys(room.id, g.userId, [{ epoch: g.epoch, wrapped: g.wrapped }]);
        return { status: 200, data: { ok: true } };
      case 'channel-post': {
        if (!canPost(room, me)) return { status: 403, data: { error: 'В этот канал вам нельзя писать' } };
        const entry = store.appendChannelPost(room.id, { msgId: p.msgId, from: me, epoch: p.epoch, ct: p.ct, nonce: p.nonce });
        fanoutChannelPost(room, me, { seq: entry.seq, msgId: p.msgId, from: me, epoch: p.epoch, ct: p.ct, nonce: p.nonce });
        return { status: 200, data: { ok: true, seq: entry.seq, msgId: p.msgId } };
      }
      case 'channel-reactions':
        if (!isPart) return { status: 403, data: { error: 'Вы не участник' } };
        return { status: 200, data: { reactions: store.reactionsForRoom(room.id, me) } };
      case 'request-keys': {
        if (!isPart) return { status: 403, data: { error: 'Вы не участник' } };
        // Просим владельца/админов выдать ключ этому участнику. Локальным — и live,
        // и durable (обработают при следующем входе, если сейчас офлайн). Чужим — по федерации.
        for (const u of new Set([room.owner, ...(room.admins || [])].filter(Boolean))) {
          const ev = { type: 'channel-keyreq', roomId: room.id, from: me };
          if (isLocal(u)) { store.pushKeyReq(u, { roomId: room.id, from: me }); notifyEvent(u, ev); }
          else federationPost(domainOf(u), '/_prizrak/federation/v1/channel-evt', { to: u, ev, durable: true }).catch(() => {});
        }
        return { status: 200, data: { ok: true } };
      }
      case 'channel-react': {
        if (room.reactionsEnabled === false) return { status: 403, data: { error: 'Реакции в этом канале отключены' } };
        if (!isPart) return { status: 403, data: { error: 'Вы не участник' } };
        if (!p.emoji || typeof p.emoji !== 'string') return { status: 400, data: { error: 'Нужен emoji' } };
        const cur = store.reactionSummary(room.id, p.msgId, me), maxR = room.maxReactions || 11;
        const isNew = !(p.emoji in (cur.counts || {})), removing = (cur.mine || []).includes(p.emoji);
        if (isNew && !removing && Object.keys(cur.counts || {}).length >= maxR) return { status: 403, data: { error: `Достигнут лимит реакций на публикацию (${maxR})` } };
        const sum = store.toggleReaction(room.id, p.msgId, p.emoji, me); notifyReaction(room, p.msgId);
        return { status: 200, data: sum };
      }
      case 'channel-react-paid': {
        if (!room.paidReactionsEnabled) return { status: 403, data: { error: 'Платные реакции в этом канале отключены' } };
        if (!isPart) return { status: 403, data: { error: 'Вы не участник' } };
        const amt = Math.floor(Number(p.amount)); if (!(amt > 0)) return { status: 400, data: { error: 'Некорректная сумма' } };
        const sum = store.addPaidReaction(room.id, p.msgId, me, amt); notifyReaction(room, p.msgId);
        return { status: 200, data: sum };
      }
      case 'reactions-settings':
        try { setRoomReactions(room, me, p); } catch (e) { return { status: 403, data: { error: e.message } }; }
        store.saveRoom(room); return { status: 200, data: publicView(room) };
      case 'retention': {
        if (!canManage(room, me)) return { status: 403, data: { error: 'Менять срок хранения может владелец или админ' } };
        if (!isValidRetention(p.retention)) return { status: 400, data: { error: 'Недопустимый срок' } };
        const effective = clampRetention(p.retention, cfg.historyRetention);
        room.retention = effective; store.saveRoom(room);
        return { status: 200, data: { ok: true, requested: p.retention, effective, adminMax: cfg.historyRetention, clamped: effective !== p.retention } };
      }
      default: return { status: 400, data: { error: 'Неизвестная операция' } };
    }
  }
  // Локальная комната — выполняем прямо; чужая — по федерации на её домашний сервер.
  async function clientRoomOp(op, me, params) {
    if (isRoomLocal(params.roomId)) return roomOp(op, me, params);
    return federateRoomOp(params.roomId, { op, me, ...params });
  }
  async function deliver(envelope) {
    if (isLocal(envelope.to)) { deliverLocal(envelope); return { delivered: true }; }
    const r = await federateSend(envelope);
    return { delivered: r.ok, queued: !!r.queued };
  }
  // Периодический дренаж очереди федерации + отбрасывание протухших (по federationRetention).
  function fedRetentionMs() { const s = retentionSeconds(cfg.federationRetention); return isFinite(s) ? s * 1000 : Infinity; }
  async function drainOutbox() {
    for (const item of store.outboxAll().slice()) {
      let ok = false;
      try {
        if (item.kind === 'media') { const r = await pushMediaChunked(item.domain, item.mediaId); ok = r.ok || r.gone; }
        else { const base = await resolveBaseUrl(item.domain); const res = await fetch(`${base}${item.path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-prizrak-origin': domain }, body: JSON.stringify(item.body) }); ok = res.ok; }
      } catch {}
      if (ok) store.removeOutbox(item.id); else item.attempts = (item.attempts || 1) + 1;
    }
    store.saveOutbox();
    const ms = fedRetentionMs();
    if (isFinite(ms)) { const dropped = store.pruneOutbox(Date.now() - ms); if (dropped) console.log(`[federation ${domain}] отброшено недоставленных (сервер получателя не появился за ${cfg.federationRetention}): ${dropped}`); }
  }
  // PUSH медиа на сервер получателя (потоком, без буфера в памяти). Так файл лежит
  // на сервере получателя ДО того, как он откроет чат → скачивание мгновенное/локальное.
  // Прогресс переносов (для прогресс-баров с процентами на обеих сторонах).
  const pushProgress = new Map(); // mediaId → { sent, total, done, ok } (у отправителя)
  const recvProgress = new Map(); // mediaId → { received, total }         (у получателя)
  const PUSH_CHUNK = 1024 * 1024; // 1 МБ
  // Чанковый перенос блоба на сервер получателя, с колбэком прогресса. Тело каждого
  // чанка — обычный буфер (без стрим+duplex, что ломалось на части версий Node).
  async function pushMediaChunked(targetDomain, mediaId, onProgress) {
    const meta = storage.metaOf(mediaId); const rs = storage.readStream(mediaId);
    if (!meta || !rs) return { ok: true, gone: true };
    const total = meta.bytes; let sent = 0;
    try {
      const base = await resolveBaseUrl(targetDomain);
      const hdr = { 'x-prizrak-origin': domain };
      let r = await fetch(`${base}/_prizrak/federation/v1/media-recv-init?id=${encodeURIComponent(mediaId)}&total=${total}`, { method: 'POST', headers: hdr });
      if (!r.ok) throw new Error('init ' + r.status);
      for await (const chunk of rs) {
        r = await fetch(`${base}/_prizrak/federation/v1/media-recv-chunk?id=${encodeURIComponent(mediaId)}`, { method: 'POST', headers: { ...hdr, 'content-type': 'application/octet-stream', 'x-total': String(total) }, body: chunk });
        if (!r.ok) throw new Error('chunk ' + r.status);
        sent += chunk.length; if (onProgress) onProgress(sent, total);
      }
      r = await fetch(`${base}/_prizrak/federation/v1/media-recv-fin?id=${encodeURIComponent(mediaId)}&nonce=${encodeURIComponent(meta.nonce || '')}`, { method: 'POST', headers: hdr });
      return { ok: r.ok };
    } catch (e) { try { rs.destroy(); } catch {} return { ok: false, error: e.message }; }
  }
  // Запустить перенос в ФОНЕ с учётом прогресса (у отправителя).
  function startPush(targetDomain, mediaId) {
    if (targetDomain === domain) return;
    const cur = pushProgress.get(mediaId); if (cur && !cur.done) return; // уже идёт
    const total = storage.metaOf(mediaId)?.bytes || 0;
    pushProgress.set(mediaId, { sent: 0, total, done: false });
    pushMediaChunked(targetDomain, mediaId, (sent, tot) => pushProgress.set(mediaId, { sent, total: tot, done: false }))
      .then((res) => {
        pushProgress.set(mediaId, { sent: total, total, done: true, ok: !!res.ok });
        if (!res.ok && !res.gone) store.enqueueOutbox({ id: newToken().slice(0, 16), kind: 'media', mediaId, domain: targetDomain, at: Date.now(), attempts: 1 });
        const t = setTimeout(() => pushProgress.delete(mediaId), 60000); if (t.unref) t.unref(); // чистим статус через минуту
      });
  }
  // Фоновая подкачка блоба (без длинных висящих запросов): media/head запускает
  // её и сразу отвечает, а клиент опрашивает present, пока не появится.
  const pendingPulls = new Set();
  function ensureFederatedMediaAsync(id, origin) {
    if (storage.has(id) || !origin || origin === domain || pendingPulls.has(id)) return;
    pendingPulls.add(id);
    pullFederatedMedia(id, origin).catch(() => {}).finally(() => pendingPulls.delete(id));
  }
  // Подтянуть медиа-блоб с сервера-владельца (origin) и закэшировать у себя.
  async function pullFederatedMedia(id, origin) {
    try {
      const base = await resolveBaseUrl(origin);
      const r = await fetch(`${base}/_prizrak/federation/v1/media?id=${encodeURIComponent(id)}`);
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      const nonce = r.headers.get('x-nonce') || '';
      try { storage.putRaw(id, buf, { nonce, mime: '' }); } catch {} // кэш локально
      return { buffer: buf, nonce };
    } catch { return null; }
  }

  // ── Квитанции доставки/прочтения (received/read) ──────────────────────────
  function deliverReceipt(r) { // r.to — исходный отправитель (локальный)
    store.pushReceipt(r.to, { from: r.from, msgIds: r.msgIds, status: r.status, at: Date.now() });
    notifyEvent(r.to, { type: 'receipt', from: r.from, msgIds: r.msgIds, status: r.status });
  }
  async function routeReceipt(r) {
    if (isLocal(r.to)) { deliverReceipt(r); return; }
    await federationPost(domainOf(r.to), '/_prizrak/federation/v1/receipt', r); // очередь при недоступности
  }

  // ── Приглашения в комнаты/каналы (durable + федеративные) ──────────────────
  // Раньше invite только добавлял участника на сервере, но НЕ уведомлял его —
  // и комната не появлялась в приложении приглашённого. Теперь шлём событие
  // 'invited' с публичным видом комнаты; офлайн — в очередь, чужой сервер — по федерации.
  function deliverInvite(userId, room) { // userId — локальный
    store.pushInvite(userId, room);
    notifyEvent(userId, { type: 'invited', room });
  }
  async function routeInvite(userId, room) {
    if (isLocal(userId)) { deliverInvite(userId, room); return; }
    await federationPost(domainOf(userId), '/_prizrak/federation/v1/invite', { userId, room }); // очередь при недоступности
  }
  // Выполнить удаление сообщения (с проверкой прав) на ЭТОМ сервере + разослать tombstone.
  // requester — тот, кто инициировал (может быть с чужого сервера при форварде).
  function performDelete(msgId, requester) {
    const entry = store.findMessage(msgId); if (!entry) return { ok: true, gone: true };
    const author = entry.envelope.from;
    if (entry.roomId) { const room = store.getRoom(entry.roomId); if (!(requester === author || (room && canModerate(room, requester)))) return { ok: false, code: 403 }; }
    else { const recips = [entry.envelope.to, entry.envelope.from].filter(Boolean); if (!(requester === author || recips.includes(requester))) return { ok: false, code: 403 }; }
    const affected = store.deleteMessage(msgId);
    const notifySet = new Set([...affected, author]);
    if (!entry.roomId) { if (entry.envelope.to) notifySet.add(entry.envelope.to); if (entry.envelope.from) notifySet.add(entry.envelope.from); }
    for (const u of notifySet) routeDeletion(u, msgId, entry.roomId || null); // локально ИЛИ по федерации
    return { ok: true, affected: notifySet.size };
  }
  // Удаление «у всех»: тумбстон должен дойти и до участников на ДРУГИХ серверах.
  function deliverDeletion(u, msgId, roomId) { notifyEvent(u, { type: 'delete', msgId, roomId: roomId || null }); store.pushDeletion(u, { msgId, roomId: roomId || null }); }
  async function routeDeletion(u, msgId, roomId) {
    if (isLocal(u)) { deliverDeletion(u, msgId, roomId); return; }
    await federationPost(domainOf(u), '/_prizrak/federation/v1/delete', { to: u, msgId, roomId: roomId || null });
  }

  const MAX_AVATAR = 700000; // ~512КБ в base64
  function publicProfile(userId) {
    const p = store.getProfile(userId) || {};
    const out = { userId, displayName: p.displayName || userId.split(':')[0], bio: p.bio || '', birthday: p.birthday || '', personalChannel: p.personalChannel || '', avatar: p.avatar || null };
    if (p.showPhone && p.phone) out.phone = p.phone; // телефон только если явно открыт
    return out;
  }

  const handler = async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const body = async () => { const ch = []; let n = 0; for await (const c of req) { n += c.length; if (n > 25 * 1024 * 1024) throw new Error('Слишком большой запрос'); ch.push(c); } return ch.length ? JSON.parse(Buffer.concat(ch).toString()) : {}; };
    const rawBody = async (limit = 16 * 1024 * 1024) => { const ch = []; let n = 0; for await (const c of req) { n += c.length; if (n > limit) throw new Error('Слишком большой фрагмент'); ch.push(c); } return Buffer.concat(ch); };
    const auth = () => { const h = req.headers['authorization'] || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : null; const r = t && store.getToken(t); return r ? r.userId : null; };
    const url = new URL(req.url, `http://${domain}`); const P = url.pathname;
    const sinceParam = () => Number(url.searchParams.get('since') || 0);

    try {
      if (P === '/.well-known/prizrak/server') return json(200, { 'm.server': domain, base_url: cfg.resolver[domain] || `https://${domain}`, keys: publicKeys(serverIdentity), deaddrop: ddNodes.length > 0 });
      if (P === '/health') return json(200, { ok: true, domain, version: VERSION });
      if (P === '/_prizrak/client/v1/config') return json(200, { domain, version: VERSION, registrationEnabled: cfg.registrationEnabled, requiresInvite: !!cfg.registrationInviteCode, relayUrl: cfg.relayUrl, historyRetention: cfg.historyRetention });

      // Регистрация / логин
      if (req.method === 'POST' && P === '/_prizrak/client/v1/register') {
        if (!cfg.registrationEnabled) return json(403, { error: 'Регистрация на этом сервере отключена администратором' });
        const { userId, password, inviteCode, publicBundle, keyBackup } = await body();
        parseUserId(userId, domain);
        if (cfg.registrationInviteCode && inviteCode !== cfg.registrationInviteCode) return json(403, { error: 'Требуется корректный инвайт-код' });
        if (store.hasAccount(userId)) return json(409, { error: 'Имя уже занято' });
        const isAdmin = adminSet.has(userId.split(':')[0]) || adminSet.has(userId);
        store.createAccount(userId, { ...hashPassword(password), isAdmin: !!isAdmin });
        if (cfg.welcomeGhosts > 0) store.credit(userId, cfg.welcomeGhosts, { kind: 'welcome' });
        if (publicBundle) store.putUser(userId, publicBundle);
        if (keyBackup) store.putKeyBackup(userId, keyBackup); // зашифрованная резервная копия личности
        const token = newToken(); store.putToken(token, userId);
        return json(200, { ok: true, userId, token, isAdmin: !!isAdmin });
      }
      // ── Конфиденциальность: чёрный список + политики «Группы и каналы» / «Звонки» ──
      // {blocked:[id…], groups:'all'|'contacts'|'none', groupsAllow:[id…], calls:…, callsAllow:[…]}
      if (req.method === 'GET' && P === '/_prizrak/client/v1/privacy') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        return json(200, { privacy: store.getPrivacy(me) || { blocked: [], groups: 'all', groupsAllow: [], calls: 'all', callsAllow: [] } });
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/privacy') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { privacy } = await body();
        const mode = (v) => (['all', 'contacts', 'none'].includes(v) ? v : 'all');
        const ids = (v) => (Array.isArray(v) ? [...new Set(v.map((s) => String(s).trim()).filter((s) => /^[^:\s]+:[^:\s]+$/.test(s)))].slice(0, 500) : []);
        const clean = {
          blocked: ids(privacy?.blocked), groups: mode(privacy?.groups), groupsAllow: ids(privacy?.groupsAllow),
          calls: mode(privacy?.calls), callsAllow: ids(privacy?.callsAllow),
        };
        store.putPrivacy(me, clean);
        return json(200, { ok: true, privacy: clean });
      }
      // B3: включить/обновить восстановление по фразе (копия личности + аутентификатор фразы).
      if (req.method === 'POST' && P === '/_prizrak/client/v1/seed-backup') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { seedBackup, seedAuth } = await body();
        if (!seedBackup || !seedAuth) return json(400, { error: 'Нужны seedBackup и seedAuth' });
        store.putSeedBackup(me, seedBackup);
        store.setSeedCred(me, hashPassword(seedAuth)); // солёный хэш аутентификатора фразы
        return json(200, { ok: true });
      }
      // B3: восстановление по фразе — сброс пароля и выдача копии личности.
      if (req.method === 'POST' && P === '/_prizrak/client/v1/recover-seed') {
        const { userId, seedAuth, newPassword } = await body();
        parseUserId(userId, domain);
        const acc = store.getAccount(userId);
        const cred = store.getSeedCred(userId);
        if (!acc || !cred || !verifyPassword(seedAuth, cred)) return json(401, { error: 'Неверная фраза восстановления' });
        const blob = store.getSeedBackup(userId);
        if (!blob) return json(404, { error: 'Для этого аккаунта нет копии по фразе' });
        store.setPassword(userId, hashPassword(newPassword)); // сброс пароля
        const token = newToken(); store.putToken(token, userId);
        return json(200, { ok: true, userId, token, isAdmin: !!acc.isAdmin, seedBackup: blob });
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/login') {
        const { userId, password, publicBundle, keyBackup } = await body();
        const acc = store.getAccount(userId);
        if (!acc || !verifyPassword(password, acc)) return json(401, { error: 'Неверные логин или пароль' });
        const token = newToken(); store.putToken(token, userId);
        const existing = store.getKeyBackup(userId);
        if (existing) {
          // Есть резервная копия — вернём её клиенту, он восстановит исходную личность.
          return json(200, { ok: true, userId, token, isAdmin: !!acc.isAdmin, keyBackup: existing });
        }
        // Легаси-аккаунт без бэкапа: принять присланные ключи как авторитетные
        // (re-key), чтобы опубликованный bundle совпадал с приватными ключами клиента.
        if (publicBundle) store.putUser(userId, publicBundle);
        if (keyBackup) store.putKeyBackup(userId, keyBackup);
        return json(200, { ok: true, userId, token, isAdmin: !!acc.isAdmin, keyBackup: null });
      }

      if (req.method === 'GET' && P === '/_prizrak/client/v1/bundle') {
        const userId = url.searchParams.get('userId');
        if (isLocal(userId)) { const u = store.getUser(userId); return u ? json(200, u.publicBundle) : json(404, { error: 'Пользователь не найден' }); }
        const base = await resolveBaseUrl(domainOf(userId)); const r = await fetch(`${base}/_prizrak/federation/v1/bundle?userId=${encodeURIComponent(userId)}`); return json(r.status, await r.json());
      }
      // MD1: публикация bundle текущего устройства в реестр.
      if (req.method === 'POST' && P === '/_prizrak/client/v1/devices/publish') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { deviceId, bundle, name } = await body();
        if (!deviceId || !bundle) return json(400, { error: 'Нужны deviceId и bundle' });
        store.putDevice(me, deviceId, bundle, { name });
        return json(200, { ok: true });
      }
      // MD1: список устройств пользователя (для fan-out на все устройства). Локально или по федерации.
      if (req.method === 'GET' && P === '/_prizrak/client/v1/devices') {
        const userId = url.searchParams.get('userId');
        if (isLocal(userId)) return json(200, { devices: store.getDevices(userId) });
        const base = await resolveBaseUrl(domainOf(userId));
        try { const r = await fetch(`${base}/_prizrak/federation/v1/devices?userId=${encodeURIComponent(userId)}`); return json(r.status, await r.json()); }
        catch { return json(200, { devices: [] }); }
      }
      // MD1: отзыв своего устройства из реестра.
      if (req.method === 'POST' && P === '/_prizrak/client/v1/devices/revoke') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { deviceId } = await body(); if (!deviceId) return json(400, { error: 'Нужен deviceId' });
        return json(200, { ok: store.revokeDevice(me, deviceId) });
      }

      // ── Профили (хранятся на домашнем сервере пользователя) ────────────────
      if (req.method === 'GET' && P === '/_prizrak/client/v1/profile') {
        const userId = url.searchParams.get('userId');
        if (isLocal(userId)) return json(200, publicProfile(userId));
        const base = await resolveBaseUrl(domainOf(userId));
        const r = await fetch(`${base}/_prizrak/federation/v1/profile?userId=${encodeURIComponent(userId)}`);
        return json(r.status, await r.json());
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/profile') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const f = await body();
        if (f.avatar?.data && f.avatar.data.length > MAX_AVATAR) return json(413, { error: 'Аватар слишком большой (макс ~512КБ)' });
        const allowed = {};
        for (const k of ['displayName', 'bio', 'birthday', 'phone', 'showPhone', 'personalChannel', 'avatar']) if (k in f) allowed[k] = f[k];
        store.setProfile(me, allowed);
        return json(200, publicProfile(me));
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/profile') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { roomId, name, description, avatar } = await body();
        const room = store.getRoom(roomId); if (!room) return json(404, { error: 'Комната не найдена' });
        if (!canManage(room, me)) return json(403, { error: 'Менять профиль комнаты может владелец или админ' });
        if (avatar?.data && avatar.data.length > MAX_AVATAR) return json(413, { error: 'Аватар слишком большой (макс ~512КБ)' });
        if (name != null) room.name = name; if (description != null) room.description = description; if (avatar !== undefined) room.avatar = avatar;
        store.saveRoom(room); return json(200, publicView(room));
      }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/rooms/share') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const roomId = url.searchParams.get('roomId');
        // Комната может жить на ЧУЖОМ сервере (федеративная группа) — тогда спрашиваем
        // её у домашнего сервера комнаты, иначе ссылка-приглашение не собиралась (был 404).
        let room = store.getRoom(roomId);
        if (!room) { try { const r = await clientRoomOp('get', me, { roomId }); if (r.status === 200) room = r.data.room || r.data; } catch {} }
        if (!room) return json(404, { error: 'Комната не найдена' });
        return json(200, { roomId, name: room.name, link: `${cfg.inviteBase}/?join=${encodeURIComponent(roomId)}`, deepLink: `prizrak://join/${roomId}` });
      }
      // Поделиться контактом (ссылка на личный чат с пользователем)
      if (req.method === 'GET' && P === '/_prizrak/client/v1/contact/share') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const userId = url.searchParams.get('userId') || me;
        return json(200, { userId, link: `${cfg.inviteBase}/?dm=${encodeURIComponent(userId)}`, deepLink: `prizrak://dm/${userId}` });
      }

      // Отправка / история (курсор)
      if (req.method === 'POST' && P === '/_prizrak/client/v1/send') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const e = await body(); e.from = me; let out = { delivered: false }; try { out = await deliver(e); } catch {} return json(200, { ok: true, msgId: e.msgId || null, delivered: out.delivered, queued: !!out.queued }); }
      // Квитанция о доставке/прочтении: отправитель узнаёт статус своего сообщения.
      if (req.method === 'POST' && P === '/_prizrak/client/v1/receipt') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const b = await body(); const ids = Array.isArray(b.msgIds) ? b.msgIds : (b.msgIds ? [b.msgIds] : []); if (!b.to || !ids.length) return json(400, { error: 'нужны to и msgIds' }); routeReceipt({ from: me, to: b.to, msgIds: ids, status: b.status === 'read' ? 'read' : 'received' }); return json(200, { ok: true }); }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/inbox') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const dev = url.searchParams.get('device') || null; return json(200, { messages: store.historySince(me, sinceParam(), dev).map((x) => ({ envelope: x.envelope, seq: x.seq })), receipts: store.drainReceipts(me), deletions: store.drainDeletions(me), invites: store.drainInvites(me) }); }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/history') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const roomId = url.searchParams.get('roomId');
        const list = roomId ? store.historyForRoom(me, roomId, sinceParam()) : store.historySince(me, sinceParam());
        return json(200, { messages: list.map((x) => ({ envelope: x.envelope, seq: x.seq })) });
      }

      // Комнаты
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/create') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { type, name } = await body(); const room = makeRoom({ type, name, creator: me, domain }); store.createRoom(room); return json(200, publicView(room)); }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/rooms') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); return json(200, { rooms: store.roomsForUser(me).map(publicView) }); }
      // Восстановление списка личных чатов на новом устройстве: собеседники по
      // метаданным истории (сервер видит только from/at, содержимое — E2E).
      if (req.method === 'GET' && P === '/_prizrak/client/v1/chats') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); return json(200, { chats: store.dmPeers(me) }); }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/rooms/get') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const r = await clientRoomOp('get', me, { roomId: url.searchParams.get('roomId') }); return json(r.status, r.data); }
      // Presence собеседника: online / был недавно (lastSeen). Для чужого домена — по федерации.
      if (req.method === 'GET' && P === '/_prizrak/client/v1/presence') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const userId = url.searchParams.get('userId') || '';
        if (isLocal(userId)) return json(200, { userId, ...presenceOf(userId) });
        try { const base = await resolveBaseUrl(domainOf(userId)); const r = await fetch(`${base}/_prizrak/federation/v1/presence?userId=${encodeURIComponent(userId)}`); if (r.ok) return json(200, await r.json()); } catch {}
        return json(200, { userId, online: false, lastSeen: 0, unknown: true });
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/invite') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { roomId, userId } = await body();
        // Приватность приглашаемого (если он наш): ЧС и политика «Группы и каналы».
        if (userId && isLocal(userId) && userId !== me) {
          const pv = store.getPrivacy(userId);
          if (pv) {
            if ((pv.blocked || []).includes(me)) return json(403, { error: 'Пользователь ограничил приглашения в группы' });
            const m = pv.groups || 'all';
            const ok = m === 'all' || (pv.groupsAllow || []).includes(me) || (m === 'contacts' && store.isPeer(userId, me));
            if (!ok) return json(403, { error: 'Пользователь ограничил приглашения в группы' });
          }
        }
        const r = await clientRoomOp('invite', me, { roomId, userId }); return json(r.status, r.data);
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/join') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const r = await clientRoomOp('join', me, { roomId: (await body()).roomId }); return json(r.status, r.data); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/leave') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const r = await clientRoomOp('leave', me, { roomId: (await body()).roomId }); return json(r.status, r.data); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/send') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { roomId, envelopes } = await body(); const r = await clientRoomOp('send', me, { roomId, envelopes }); return json(r.status, r.data); }
      // Ретеншн комнаты (кламп к админскому максимуму; чужая комната — по федерации)
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/retention') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { roomId, retention } = await body(); const r = await clientRoomOp('retention', me, { roomId, retention }); return json(r.status, r.data); }
      // Настройки группы: приватность, права участников, исключения, медленный режим, видимость истории.
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/settings') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { roomId, settings } = await body(); const r = await clientRoomOp('settings', me, { roomId, settings }); return json(r.status, r.data); }
      // G5: поиск публичных групп через реестр (клиент ходит через СВОЙ сервер — работает и за стелсом).
      if (req.method === 'GET' && P === '/_prizrak/client/v1/groups/search') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        if (!cfg.registryUrl) return json(200, { results: [], registry: null });
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 2) return json(400, { error: 'Минимум 2 символа' });
        try {
          const r = await fetch(`${cfg.registryUrl}/api/search?q=${encodeURIComponent(q)}&limit=30`, { signal: AbortSignal.timeout(8000) });
          const d = await r.json().catch(() => ({}));
          return json(200, { results: Array.isArray(d.results) ? d.results : [], registry: cfg.registryUrl });
        } catch { return json(502, { error: 'Реестр групп недоступен' }); }
      }
      // Назначить роль (владелец/админ; владельца не трогаем)
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/role') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { roomId, userId, role } = await body(); const room = store.getRoom(roomId); if (!room) return json(404, { error: 'Комната не найдена' });
        try { setRole(room, me, userId, role); } catch (e) { return json(403, { error: e.message }); }
        store.saveRoom(room); notifyEvent(userId, { type: 'role', roomId, role }); return json(200, publicView(room));
      }
      // Передать владельца (только владелец)
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/transfer') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { roomId, newOwner } = await body(); const room = store.getRoom(roomId); if (!room) return json(404, { error: 'Комната не найдена' });
        try { transferOwner(room, me, newOwner); } catch (e) { return json(403, { error: e.message }); }
        store.saveRoom(room); notifyEvent(newOwner, { type: 'owner', roomId }); return json(200, publicView(room));
      }
      // Кик / бан / разбан / режим «только чтение»
      if (req.method === 'POST' && (P === '/_prizrak/client/v1/rooms/kick' || P === '/_prizrak/client/v1/rooms/ban')) {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { roomId, userId } = await body(); const room = store.getRoom(roomId); if (!room) return json(404, { error: 'Комната не найдена' });
        try { (P.endsWith('ban') ? ban : kick)(room, me, userId); } catch (e) { return json(403, { error: e.message }); }
        store.saveRoom(room); notifyEvent(userId, { type: 'kicked', roomId }); return json(200, publicView(room));
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/unban') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { roomId, userId } = await body(); const room = store.getRoom(roomId); if (!room) return json(404, { error: 'Комната не найдена' });
        try { unban(room, me, userId); } catch (e) { return json(403, { error: e.message }); }
        store.saveRoom(room); return json(200, publicView(room));
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/readonly') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { roomId, readOnly } = await body(); const room = store.getRoom(roomId); if (!room) return json(404, { error: 'Комната не найдена' });
        try { setReadOnly(room, me, readOnly); } catch (e) { return json(403, { error: e.message }); }
        store.saveRoom(room); return json(200, publicView(room));
      }

      // ── Канал: общий ключ + история ──────────────────────────────────────
      // ── Каналы: все операции работают и с ЧУЖИМ каналом (по федерации на его дом. сервер) ──
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/channel/grant') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { roomId, grants } = await body(); const r = await clientRoomOp('channel-grant', me, { roomId, grants }); return json(r.status, r.data); }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/rooms/channel/keys') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const r = await clientRoomOp('channel-keys', me, { roomId: url.searchParams.get('roomId') }); return json(r.status, r.data); }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/rooms/channel/secret') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const r = await clientRoomOp('channel-secret', me, { roomId: url.searchParams.get('roomId') }); return json(r.status, r.data); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/channel/set-secret') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { roomId, secrets } = await body(); const r = await clientRoomOp('channel-set-secret', me, { roomId, secrets }); return json(r.status, r.data); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/channel/post') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { roomId, msgId, epoch, ct, nonce } = await body(); const r = await clientRoomOp('channel-post', me, { roomId, msgId, epoch, ct, nonce }); return json(r.status, r.data); }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/rooms/channel/history') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const r = await clientRoomOp('channel-history', me, { roomId: url.searchParams.get('roomId'), since: url.searchParams.get('since') || 0 }); return json(r.status, r.data); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/reactions/settings') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { roomId, reactionsEnabled, paidReactionsEnabled, reactionEmojis, maxReactions } = await body(); const r = await clientRoomOp('reactions-settings', me, { roomId, reactionsEnabled, paidReactionsEnabled, reactionEmojis, maxReactions }); return json(r.status, r.data); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/channel/react') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { roomId, msgId, emoji } = await body(); const r = await clientRoomOp('channel-react', me, { roomId, msgId, emoji }); return json(r.status, r.data); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/channel/react-paid') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { roomId, msgId, amount } = await body(); const r = await clientRoomOp('channel-react-paid', me, { roomId, msgId, amount }); return json(r.status, r.data); }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/rooms/channel/reactions') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const r = await clientRoomOp('channel-reactions', me, { roomId: url.searchParams.get('roomId') }); return json(r.status, r.data); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/channel/request-keys') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const r = await clientRoomOp('request-keys', me, { roomId: (await body()).roomId }); return json(r.status, r.data); }
      // Диагностика доставки (владелец/админ): до кого сервер достаёт, у кого есть ключ.
      if (req.method === 'GET' && P === '/_prizrak/client/v1/rooms/diag') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const roomId = url.searchParams.get('roomId');
        if (!isRoomLocal(roomId)) { const { status, data } = await federateRoomOp(roomId, { op: '__diag', me }); return json(status, data); }
        const room = store.getRoom(roomId); if (!room) return json(404, { error: 'Комната не найдена' });
        if (!canManage(room, me)) return json(403, { error: 'Диагностика доступна владельцу или админу' });
        const report = await channelDiag(room, me);
        return json(200, { report, domain, type: room.type, keyEpoch: room.keyEpoch || 0 });
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/rooms/channel/rotate') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const room = store.getRoom((await body()).roomId); if (!room) return json(404, { error: 'Комната не найдена' });
        if (!canManage(room, me)) return json(403, { error: 'Ротация ключа — владелец или админ' });
        room.keyEpoch = (room.keyEpoch || 1) + 1; store.saveRoom(room);
        return json(200, { ok: true, epoch: room.keyEpoch });
      }
      // Удалить сообщение (для всех). Права: свой чат — участник; комната — автор/модератор/админ/владелец.
      if (req.method === 'POST' && P === '/_prizrak/client/v1/messages/delete') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { msgId, peer } = await body(); if (!msgId) return json(400, { error: 'Нужен msgId' });
        if (store.findMessage(msgId)) { const r = performDelete(msgId, me); if (r.code === 403) return json(403, { error: 'Нет прав удалять это сообщение' }); return json(200, { ok: true, msgId, affected: r.affected || 0 }); }
        // Копии сообщения нет локально (личное сообщение хранится на сервере собеседника).
        // Форвардим запрос на удаление на его сервер — там и проверят права, и разошлют tombstone.
        if (peer && !isLocal(peer)) { await federationPost(domainOf(peer), '/_prizrak/federation/v1/delete-request', { msgId, from: me }); return json(200, { ok: true, msgId, forwarded: true }); }
        return json(404, { error: 'Сообщение не найдено' });
      }

      // Кошелёк 👻
      if (req.method === 'GET' && P === '/_prizrak/client/v1/wallet') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const w = store.wallet(me); return json(200, { balance: w.balance, tx: w.tx }); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/ghosts/send') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { to, amount, note } = await body(); const amt = Math.floor(Number(amount)); if (!(amt > 0)) return json(400, { error: 'Некорректная сумма' }); if (!store.getAccount(to) && isLocal(to)) return json(404, { error: 'Получатель не найден' }); store.debit(me, amt, { kind: 'send', to, note }); if (isLocal(to)) store.credit(to, amt, { kind: 'receive', from: me, note }); const s = live.get(to); if (s) for (const ws of s) { try { ws.send(JSON.stringify({ type: 'ghosts', from: me, amount: amt, note })); } catch {} } return json(200, { ok: true, balance: store.wallet(me).balance }); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/ghosts/buy') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const amt = Math.floor(Number((await body()).amount)); if (!(amt > 0)) return json(400, { error: 'Некорректная сумма' }); return json(200, { ok: true, balance: store.credit(me, amt, { kind: 'purchase' }), demo: true }); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/ghosts/grant') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); if (!isAdminUser(me)) return json(403, { error: 'Только для администратора' }); const { to, amount } = await body(); const amt = Math.floor(Number(amount)); if (!(amt > 0)) return json(400, { error: 'Некорректная сумма' }); return json(200, { ok: true, to, balance: store.credit(to, amt, { kind: 'grant', from: me }) }); }

      // ── Управление администраторами (любой ник, несколько, на лету) ─────────
      // Действующий админ выдаёт/снимает права isAdmin существующему пользователю. Ник любой.
      if (req.method === 'POST' && P === '/_prizrak/client/v1/admin/grant-admin') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); if (!isAdminUser(me)) return json(403, { error: 'Только для администратора' });
        const { userId } = await body(); if (!userId || !store.getAccount(userId)) return json(404, { error: 'Пользователь не найден (сначала он должен зарегистрироваться)' });
        store.setAdmin(userId, true); return json(200, { ok: true, userId, isAdmin: true });
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/admin/revoke-admin') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); if (!isAdminUser(me)) return json(403, { error: 'Только для администратора' });
        const { userId } = await body(); if (!userId || !store.getAccount(userId)) return json(404, { error: 'Пользователь не найден' });
        const admins = store.listAdmins(); if (admins.length <= 1 && admins.includes(userId)) return json(400, { error: 'Нельзя снять последнего администратора' });
        store.setAdmin(userId, false);
        const stillCfg = adminSet.has(userId) || adminSet.has(String(userId).split(':')[0]);
        return json(200, { ok: true, userId, isAdmin: stillCfg, note: stillCfg ? 'остаётся админом по конфигу (admins)' : undefined });
      }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/admin/admins') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); if (!isAdminUser(me)) return json(403, { error: 'Только для администратора' });
        return json(200, { ok: true, admins: store.listAdmins(), configured: [...adminSet] });
      }

      // Медиа (StorageManager, лимит размера)
      if (req.method === 'POST' && P === '/_prizrak/client/v1/media/upload') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { ciphertext, nonce, mime } = await body(); if (!ciphertext) return json(400, { error: 'Пустой блоб' }); const id = newToken().slice(0, 24); try { storage.put(id, { ciphertext, nonce, mime }); } catch (e) { return json(413, { error: e.message }); } return json(200, { ok: true, mediaId: id }); }
      // Удаление медиа-блоба (освобождает место). mediaId — секретный токен доступа,
      // сервер его в открытом виде не видит (он в E2E-конверте), поэтому удаление
      // инициирует клиент при удалении сообщения с вложением.
      if (req.method === 'POST' && P === '/_prizrak/client/v1/media/delete') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const { mediaId } = await body(); if (!mediaId) return json(400, { error: 'Нужен mediaId' }); const removed = storage.remove(String(mediaId)); return json(200, { ok: true, removed }); }
      // Запустить перенос блоба на сервер получателя в ФОНЕ (клиент отправителя дёргает
      // сразу после отправки). Возвращаем сразу; прогресс — через media/push-status.
      if (req.method === 'POST' && P === '/_prizrak/client/v1/media/federate') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { mediaId, toDomain } = await body(); if (!mediaId || !toDomain) return json(400, { error: 'нужны mediaId и toDomain' });
        if (toDomain === domain) return json(200, { ok: true, local: true });
        startPush(String(toDomain), String(mediaId));
        return json(200, { ok: true, started: true });
      }
      // Прогресс переноса на сервер получателя (у отправителя): { sent, total, done, ok }.
      if (req.method === 'GET' && P === '/_prizrak/client/v1/media/push-status') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const p = pushProgress.get(url.searchParams.get('mediaId')); return json(200, p || { done: true, unknown: true });
      }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/media/get') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); const id = url.searchParams.get('id'); const origin = url.searchParams.get('origin'); let m = storage.get(id); if (!m && origin && origin !== domain) { const raw = await pullFederatedMedia(id, origin); if (raw) m = { ciphertext: raw.buffer.toString('hex'), nonce: raw.nonce, mime: '' }; } return m ? json(200, m) : json(404, { error: 'Медиа не найдено' }); }

      // ── Чанковая загрузка больших файлов (обходит лимит JSON, даёт прогресс) ──
      if (req.method === 'POST' && P === '/_prizrak/client/v1/media/chunk') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const uploadId = String(url.searchParams.get('uploadId') || '').replace(/[^a-f0-9]/gi, '');
        if (!uploadId) return json(400, { error: 'Нет uploadId' });
        const buf = await rawBody(16 * 1024 * 1024); // до 16МБ на фрагмент
        try { storage.appendChunk(uploadId, buf); } catch (e) { return json(500, { error: e.message }); }
        return json(200, { ok: true, received: storage.tmpSize(uploadId) });
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/media/finish') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const { uploadId, nonce, mime } = await body();
        const uid = String(uploadId || '').replace(/[^a-f0-9]/gi, '');
        const id = newToken().slice(0, 24);
        try { storage.finishUpload(id, uid, { nonce, mime }); } catch (e) { storage.abortUpload(uid); return json(413, { error: e.message }); }
        return json(200, { ok: true, mediaId: id });
      }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/media/abort') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        storage.abortUpload(String((await body()).uploadId || '').replace(/[^a-f0-9]/gi, ''));
        return json(200, { ok: true });
      }
      // Сырой шифртекст (octet-stream) — для скачивания больших файлов без hex-раздувания.
      // Есть ли блоб на НАШЕМ сервере? Нет — тянем с origin (файл целиком оказывается
      // у получателя, ПОСЛЕ чего клиент шлёт квитанции доставки/прочтения).
      if (req.method === 'GET' && P === '/_prizrak/client/v1/media/head') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const id = url.searchParams.get('id'); const origin = url.searchParams.get('origin');
        if (storage.has(id)) return json(200, { present: true });
        const rp = recvProgress.get(id);
        if (rp) return json(200, { present: false, received: rp.received, total: rp.total }); // идёт push от отправителя
        // НЕ тянем сами здесь (иначе гонка с входящим push за один и тот же блоб).
        // Если push так и не придёт — файл подтянется при ручном скачивании (media/raw).
        return json(200, { present: false });
      }
      if (req.method === 'GET' && P === '/_prizrak/client/v1/media/raw') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' });
        const id = url.searchParams.get('id'); const origin = url.searchParams.get('origin');
        let m = storage.getRaw(id);
        if (!m && origin && origin !== domain) m = await pullFederatedMedia(id, origin); // блоб на сервере отправителя — тянем оттуда
        if (!m) return json(404, { error: 'Медиа не найдено' });
        // Content-Length обязателен — по нему клиент считает % скачивания (кольцо прогресса).
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': m.buffer.length, 'x-nonce': m.nonce || '', 'access-control-allow-origin': '*' });
        res.end(m.buffer); return;
      }
      // Федеративная отдача блоба другому серверу (ciphertext — расшифровать без E2E-ключа нельзя).
      if (req.method === 'GET' && P === '/_prizrak/federation/v1/presence') { const userId = url.searchParams.get('userId') || ''; return json(200, isLocal(userId) ? { userId, ...presenceOf(userId) } : { userId, online: false, lastSeen: 0, unknown: true }); }
      if (req.method === 'GET' && P === '/_prizrak/federation/v1/media') {
        const m = storage.getRaw(url.searchParams.get('id'));
        if (!m) return json(404, { error: 'нет медиа' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': m.buffer.length, 'x-nonce': m.nonce || '' });
        res.end(m.buffer); return;
      }

      // Админ: хранилище и ретеншн
      if (req.method === 'GET' && P === '/_prizrak/client/v1/admin/storage') { const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); if (!isAdminUser(me)) return json(403, { error: 'Только для администратора' }); return json(200, { retention: cfg.historyRetention, storage: storage.stats() }); }
      if (req.method === 'POST' && P === '/_prizrak/client/v1/admin/storage') {
        const me = auth(); if (!me) return json(401, { error: 'Нужен токен' }); if (!isAdminUser(me)) return json(403, { error: 'Только для администратора' });
        const { retention, addPath, maxBytes } = await body();
        if (retention) { if (!isValidRetention(retention)) return json(400, { error: 'Недопустимый срок' }); cfg.historyRetention = retention; }
        if (addPath) storage.addPath(addPath);
        if (maxBytes) storage.setMaxBytes(Number(maxBytes));
        const pruned = pruneAll();
        return json(200, { ok: true, retention: cfg.historyRetention, storage: storage.stats(), pruned });
      }

      // Федерация
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/send') {
        const e = await body(); if (!isLocal(e.to)) return json(400, { error: 'Получатель не на этом сервере' });
        const isNew = deliverLocal(e);
        // Подтверждаем отправителю (на его сервер), что сообщение дошло до НАШЕГО сервера
        // → у него загорается вторая серая галочка ✓✓. Работает и для отложенной доставки из очереди.
        if (isNew && !e.roomId && e.from && e.msgId) routeReceipt({ to: e.from, from: e.to, msgIds: [e.msgId], status: 'server' });
        return json(200, { ok: true, delivered: e.to });
      }
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/receipt') { const r = await body(); if (!isLocal(r.to)) return json(400, { error: 'Не тот сервер' }); deliverReceipt(r); return json(200, { ok: true }); }
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/invite') { const { userId, room } = await body(); if (!isLocal(userId)) return json(400, { error: 'Не тот сервер' }); deliverInvite(userId, room); return json(200, { ok: true }); }
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/delete') { const { to, msgId, roomId } = await body(); if (!isLocal(to)) return json(400, { error: 'Не тот сервер' }); deliverDeletion(to, msgId, roomId); return json(200, { ok: true }); }
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/delete-request') { const { msgId, from } = await body(); const r = performDelete(msgId, from); return json(r.code === 403 ? 403 : 200, r.code === 403 ? { error: 'нет прав' } : { ok: true }); }
      // Приём медиа-блоба с сервера отправителя (push). Пишем потоком в хранилище.
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/media-recv') { const id = url.searchParams.get('id'); const nonce = req.headers['x-nonce'] || ''; if (!id) return json(400, { error: 'нужен id' }); if (storage.has(id)) return json(200, { ok: true, already: true }); try { await storage.putStream(id, req, { nonce }); } catch (e) { return json(413, { error: e.message }); } return json(200, { ok: true }); }
      // Чанковый приём блоба (для прогресса на обеих сторонах).
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/media-recv-init') { const id = url.searchParams.get('id'); if (!id) return json(400, { error: 'нужен id' }); try { storage.abortUpload(id); } catch {} recvProgress.set(id, { received: 0, total: Number(url.searchParams.get('total') || 0) }); return json(200, { ok: true }); }
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/media-recv-chunk') { const id = url.searchParams.get('id'); if (!id) return json(400, { error: 'нужен id' }); const buf = await rawBody(4 * 1024 * 1024); storage.appendChunk(id, buf); const p = recvProgress.get(id) || { received: 0, total: Number(req.headers['x-total'] || 0) }; p.received += buf.length; if (req.headers['x-total']) p.total = Number(req.headers['x-total']); recvProgress.set(id, p); return json(200, { ok: true, received: p.received }); }
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/media-recv-fin') { const id = url.searchParams.get('id'); const nonce = url.searchParams.get('nonce') || ''; if (!id) return json(400, { error: 'нужен id' }); try { storage.finishUpload(id, id, { nonce, mime: '' }); } catch (e) { recvProgress.delete(id); return json(413, { error: e.message }); } recvProgress.delete(id); return json(200, { ok: true }); }
      if (req.method === 'GET' && P === '/_prizrak/federation/v1/bundle') { const u = store.getUser(url.searchParams.get('userId')); return u ? json(200, u.publicBundle) : json(404, { error: 'Пользователь не найден' }); }
      if (req.method === 'GET' && P === '/_prizrak/federation/v1/devices') { return json(200, { devices: store.getDevices(url.searchParams.get('userId')) }); }
      // Кросс-серверная операция над комнатой: выполняем здесь (комната «дома») от имени me.
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/room-op') {
        const { op, me, ...p } = await body();
        if (op === '__diag') { const room = store.getRoom(p.roomId); if (!room) return json(404, { error: 'Комната не найдена' }); if (!canManage(room, me)) return json(403, { error: 'Диагностика доступна владельцу или админу' }); const report = await channelDiag(room, me); return json(200, { report, domain, type: room.type, keyEpoch: room.keyEpoch || 0 }); }
        const r = roomOp(op, me, p); return json(r.status, r.data);
      }
      // Кросс-серверная доставка события канала (пост/реакция) нашему локальному участнику.
      if (req.method === 'POST' && P === '/_prizrak/federation/v1/channel-evt') { const { to, ev, durable } = await body(); if (isLocal(to)) { if (durable && ev && ev.type === 'channel-keyreq') store.pushKeyReq(to, { roomId: ev.roomId, from: ev.from }); notifyEvent(to, ev); } return json(200, { ok: true }); }
      if (req.method === 'GET' && P === '/_prizrak/federation/v1/profile') { return json(200, publicProfile(url.searchParams.get('userId'))); }

      return json(404, { error: 'Неизвестный маршрут' });
    } catch (e) { return json(500, { error: e.message }); }
  };

  // WebSocket в noServer-режиме: один WSS обслуживает upgrade на всех портах (C1).
  const wss = new WebSocketServer({ noServer: true });
  function handleUpgrade(req, socket, head) {
    let pathname = '/';
    try { pathname = new URL(req.url, `http://${domain}`).pathname; } catch {}
    if (pathname === '/_prizrak/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else socket.destroy();
  }
  wss.on('connection', (ws, req) => {
    const u = new URL(req.url, `http://${domain}`); const rec = store.getToken(u.searchParams.get('token') || '');
    if (!rec) { ws.close(4001, 'нет токена'); return; }
    const userId = rec.userId; const since = Number(u.searchParams.get('since') || 0);
    ws._deviceId = u.searchParams.get('device') || null; // MD2: устройство сокета
    if (!live.has(userId)) live.set(userId, new Set());
    live.get(userId).add(ws);
    store.setLastSeen(userId, Date.now()); // онлайн
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); // heartbeat: клиент отвечает на ping
    ws.send(JSON.stringify({ type: 'ready' }));
    for (const e of store.historySince(userId, since, ws._deviceId)) ws.send(JSON.stringify({ type: 'message', envelope: e.envelope, seq: e.seq }));
    for (const r of store.drainReceipts(userId)) ws.send(JSON.stringify({ type: 'receipt', from: r.from, msgIds: r.msgIds, status: r.status }));
    for (const d of store.drainDeletions(userId)) ws.send(JSON.stringify({ type: 'delete', msgId: d.msgId, roomId: d.roomId || null }));
    for (const room of store.drainInvites(userId)) ws.send(JSON.stringify({ type: 'invited', room }));
    // Отложенные запросы ключа канала: владелец/админ, зайдя, раздаст ключи просителям.
    for (const kr of store.drainKeyReqs(userId)) ws.send(JSON.stringify({ type: 'channel-keyreq', roomId: kr.roomId, from: kr.from }));
    ws.on('close', () => { const s = live.get(userId); if (s) { s.delete(ws); if (!s.size) live.delete(userId); } store.setLastSeen(userId, Date.now()); }); // офлайн: запомнили момент
    ws.on('error', () => {});
  });
  // Серверный heartbeat: пингуем клиентов; кто не ответил pong'ом за интервал — мёртв,
  // рвём (освобождаем presence и не копим зомби-сокеты). Также держит соединение живым через NAT.
  const wsHb = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false; try { ws.ping(); } catch {}
    }
  }, 30000);
  if (wsHb.unref) wsHb.unref();
  wss.on('close', () => clearInterval(wsHb));

  // Периодическая очистка по ретеншну
  const pruneTimer = setInterval(pruneAll, 60 * 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();
  pruneAll();

  // Дренаж очереди федерации (store-and-forward): повтор доставки на сервера,
  // которые были недоступны, и отбрасывание протухших по federationRetention.
  const outboxTimer = setInterval(() => { drainOutbox().catch(() => {}); }, 20000);
  if (outboxTimer.unref) outboxTimer.unref();
  if (store.outboxAll().length) drainOutbox().catch(() => {}); // на старте — попробовать доставить накопившееся

  // ── G5: публикация ПУБЛИЧНЫХ групп/каналов в реестр поиска (tech.prizrak.im) ──
  // Только комнаты с privacy='public'; приватные НИКОГДА не публикуются. Сервер
  // переподтверждает записи периодически (TTL в реестре сам чистит умершие).
  const regMembersOf = (r) => new Set([r.owner, ...(r.admins || []), ...(r.members || []), ...(r.subscribers || [])].filter(Boolean)).size;
  async function registryPublishRoom(room, del = false) {
    if (!cfg.registryUrl) return;
    try {
      const signed = makeGroupRecord(serverIdentity, {
        roomId: room.id, domain, name: room.name, description: room.description,
        members: regMembersOf(room), type: room.type, del,
      });
      await fetch(cfg.registryUrl + '/api/' + (del ? 'unpublish' : 'publish'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed), signal: AbortSignal.timeout(8000),
      });
    } catch {} // реестр недоступен — не мешаем работе сервера, повторим по таймеру
  }
  async function registrySyncAll() {
    if (!cfg.registryUrl) return;
    for (const room of store.allRooms()) {
      if (room.privacy === 'public') await registryPublishRoom(room);
    }
  }
  let registryTimer = null;
  if (cfg.registryUrl) {
    registryTimer = setInterval(() => { registrySyncAll().catch(() => {}); }, 6 * 3600 * 1000);
    if (registryTimer.unref) registryTimer.unref();
    setTimeout(() => { registrySyncAll().catch(() => {}); }, 30000).unref?.();
  }

  // Порт relay для звонков — из relayUrl (stealth://host:port).
  const relayPort = (() => { const m = String(cfg.relayUrl || '').match(/:(\d+)\s*$/); return m ? Number(m[1]) : null; })();

  // C1: список портов. Точечный запуск (тесты передают port) или явный ports —
  // слушаем как указано; иначе — стабильный список из конфига. Занятые/без прав пропускаем.
  let ports;
  if (Array.isArray(overrides.ports)) ports = overrides.ports;
  else if (overrides.port != null) ports = [cfg.port];
  else ports = (Array.isArray(cfg.ports) && cfg.ports.length) ? cfg.ports : [cfg.port];
  ports = [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0))];

  // C4: TLS-опции (маскировка = настоящий TLS). Грузим cert/key один раз.
  let tlsOpts = null;
  if (cfg.tlsCert && cfg.tlsKey) {
    try { tlsOpts = { cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey) }; }
    catch (e) { console.log(`[homeserver ${domain}] ⚠ TLS не загружен (${e.message}) — TLS-порты будут обычным HTTP`); }
  }
  const tlsPortSet = new Set((cfg.tlsPorts || []).filter((p) => p > 0));
  const isTls = (p) => !!tlsOpts && tlsPortSet.has(p);

  const servers = [];
  return new Promise((resolve) => {
    (async () => {
      const bound = [];
      await Promise.all(ports.map((p) => new Promise((res) => {
        const srv = isTls(p) ? https.createServer(tlsOpts, handler) : http.createServer(handler);
        srv.on('upgrade', handleUpgrade);
        let settled = false;
        srv.once('error', (e) => { if (settled) return; settled = true; if (e && e.code !== 'EADDRINUSE' && e.code !== 'EACCES') console.log(`[homeserver ${domain}] порт :${p} пропущен: ${e.code || e.message}`); res(); });
        srv.listen(p, () => { if (settled) return; settled = true; srv._prizrakTls = isTls(p); bound.push(p); servers.push(srv); res(); });
      })));
      bound.sort((a, b) => a - b);
      const primary = servers.find((s) => s.address()?.port === cfg.port) || servers[0] || null;
      const portsLabel = bound.map((p) => p + (isTls(p) ? '🔒' : '')).join(', ') || '—';
      console.log(`[homeserver ${domain} v${VERSION}] Запуск homeserver'а v${VERSION} · слушает порты: ${portsLabel} · регистрация: ${cfg.registrationEnabled ? 'ВКЛ' : 'ВЫКЛ'}${cfg.registrationInviteCode ? ' (инвайт)' : ''} · ретеншн: ${cfg.historyRetention}${cfg.relayUrl ? ' · relay: ' + cfg.relayUrl : ''}`);
      let relay = null;
      if (relayPort && cfg.startRelay !== false && process.env.PRIZRAK_NO_INPROC_RELAY !== '1') {
        try { relay = await createRelay({ psk: 'prizrak-relay', port: relayPort, host: '0.0.0.0' }); console.log(`[homeserver ${domain}] ✅ relay для звонков слушает :${relayPort}`); }
        catch (e) { console.log(`[homeserver ${domain}] ⚠ relay НЕ запущен на :${relayPort}: ${e.message}`); }
      }
      // Prizrak Rendezvous — UDP reflect (наш STUN) для прямого P2P звонков (Фаза 3).
      let rendezvous = null;
      if (cfg.startRelay !== false && process.env.PRIZRAK_NO_INPROC_RELAY !== '1') {
        const rzPort = Number(process.env.PRIZRAK_RENDEZVOUS_PORT || 8811);
        try { rendezvous = await createRendezvous({ port: rzPort, host: '0.0.0.0' }); console.log(`[homeserver ${domain}] ✅ rendezvous (наш STUN) слушает UDP :${rzPort}`); }
        catch (e) { console.log(`[homeserver ${domain}] ⚠ rendezvous НЕ запущен: ${e.message}`); }
      }
      // Федерация через тайники (Фаза 3): поллим свои ящики, если сеть тайников задана.
      let bootTimer = null, rewardTimer = null;
      if (ddfed) {
        // Фаза 6b: если задан бутстрап — тянем подписанный бандл сидов по каналам и доливаем в seeds.
        if (bootstrap) {
          const applyBoot = async () => {
            try {
              const seeds = await bootstrap.resolve();
              if (seeds.length) { ddfed.seeds = [...new Set([...ddfed.seeds, ...seeds.map((s) => s.replace(/\/+$/, ''))])]; }
            } catch {}
          };
          await applyBoot();                                   // до старта поллинга — получить точку входа
          bootTimer = setInterval(applyBoot, 6 * 3600 * 1000); // бандлы ротируются нечасто — раз в 6ч
          bootTimer.unref?.();
          console.log(`[homeserver ${domain}] ✅ бутстрап сидов: каналов ${bootstrap.channels.length}, сидов сейчас ${ddfed.seeds.length}`);
        }
        ddfed.start(Number(cfg.deaddropPollMs || process.env.DD_POLL_MS || 15000));
        console.log(`[homeserver ${domain}] ✅ федерация через тайники включена (сидов: ${ddfed.seeds.length})`);

        // Фаза 7: отчёт о здоровье узлов в Банк Призраков → начисление наград операторам.
        if (cfg.deaddropRewardsUrl && cfg.deaddropRewardsToken) {
          const reportRewards = async () => {
            try {
              await ddfed.refreshNodes();
              const samples = await Promise.all(ddfed.nodes.map(async (n) => {
                try {
                  const h = await (await fetch(n.endpoint + '/dd/health', { signal: AbortSignal.timeout(5000) })).json();
                  return { relayId: h.nodeId || n.relayId, uptimeMs: h.uptimeMs || 0, acks: h.acks || 0, bytes: h.bytes || 0, endpoints: [n.endpoint], group: n.group || '', online: true };
                } catch { return { relayId: n.relayId, endpoints: [n.endpoint], group: n.group || '', online: false }; }
              }));
              if (samples.length) await fetch(cfg.deaddropRewardsUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-report-token': cfg.deaddropRewardsToken }, body: JSON.stringify({ samples }), signal: AbortSignal.timeout(8000) });
            } catch {}
          };
          reportRewards();
          rewardTimer = setInterval(reportRewards, Number(cfg.deaddropRewardsMs || 300000));
          rewardTimer.unref?.();
          console.log(`[homeserver ${domain}] ✅ отчёт наград операторам → ${cfg.deaddropRewardsUrl}`);
        }
      }
      // 🤖 Bot API (packages/botapi) — аналог Telegram Bot API + 👻 PrizrakFather.
      // Поднимается ВНУТРИ процесса (как relay), но только при самостоятельном запуске
      // (__standalone) — тесты и встраивания createServer() его не трогают.
      let botapi = null;
      if (cfg.botapiEnabled !== false && overrides.__standalone === true) {
        try {
          const { startBotApi } = await import('../../botapi/src/botapi-server.js');
          const { randomBytes: rb } = await import('node:crypto');
          const { writeFileSync: wf } = await import('node:fs');
          const tokFile = join(dataDir, 'botapi-admin.token');
          let adm = cfg.botapiAdminToken;
          if (!adm) { try { adm = readFileSync(tokFile, 'utf8').trim(); } catch {} }
          if (!adm) { adm = rb(24).toString('hex'); try { wf(tokFile, adm); } catch {} }
          const apiPort = cfg.botapiPort || 8840;
          // База — первый НЕ-TLS порт ≥1024 (ботам с локалхоста TLS не нужен).
          // Порты <1024 (110, 143, 465, …) не годятся: встроенный fetch Node их
          // блокирует как «bad ports» → был бы «fetch failed» при регистрации отца.
          const plain = bound.find((p) => p >= 1024 && !(cfg.tlsPorts || []).includes(p)) || cfg.port;
          botapi = await startBotApi({ port: apiPort, dbPath: join(dataDir, 'botapi.sqlite'), adminToken: adm, domain, baseUrl: `http://127.0.0.1:${plain}`, inviteCode: cfg.registrationInviteCode || null });
          console.log(`[homeserver ${domain}] ✅ Bot API слушает :${apiPort} — 👻 PrizrakFather: prizrakfather:${domain} (админ-токен: ${tokFile})`);
          console.log(`  ⚠ Откройте TCP ${apiPort}, если боты будут ходить с других машин. Документация: ${cfg.inviteBase}/api.html`);
        } catch (e) { console.log(`[homeserver ${domain}] ⚠ Bot API НЕ запущен: ${e.message}`); }
      }
      const closeAll = () => { for (const s of servers) { try { s.close(); } catch {} } if (botapi) { try { botapi.server.close(); } catch {} } if (bootTimer) { try { clearInterval(bootTimer); } catch {} } if (rewardTimer) { try { clearInterval(rewardTimer); } catch {} } if (registryTimer) { try { clearInterval(registryTimer); } catch {} } if (ddfed) { try { ddfed.stop(); } catch {} } };
      resolve({ server: primary, servers, closeAll, boundPorts: bound, store, storage, domain, port: cfg.port, cfg, wss, version: VERSION, pruneAll, drainOutbox, relay, rendezvous, ddfed, serverIdentity, deliver });
    })();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Последний рубеж: даже неожиданная ошибка не должна ронять homeserver.
  process.on('uncaughtException', (e) => console.error('[homeserver] uncaughtException (продолжаем):', e?.message || e));
  process.on('unhandledRejection', (e) => console.error('[homeserver] unhandledRejection (продолжаем):', e?.message || e));
  createServer({ __standalone: true }); // самостоятельный запуск — поднимаем и Bot API
}
