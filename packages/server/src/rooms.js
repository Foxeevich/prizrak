// rooms.js — модель комнат: ГРУППЫ и КАНАЛЫ (как в Telegram).
//
//   group   — все участники (members) читают и пишут.
//   channel — админы (admins) вещают, подписчики (subscribers) только читают.
//
// Сервер знает состав комнаты (метаданные маршрутизации), но НЕ содержимое:
// сообщения доставляются как E2E-конверты каждому получателю (fan-out).
import { randomBytes } from 'node:crypto';

// Набор реакций по умолчанию (как быстрый набор Telegram).
export const DEFAULT_REACTIONS = ['👍', '❤️', '🔥', '🎉', '😁', '😢', '👏', '🙏'];

export function newRoomId(domain) {
  return `!${randomBytes(8).toString('hex')}:${domain}`;
}

// Права РЯДОВОГО участника группы (владелец/админы — всегда всё). Как «Возможности
// участников» в Telegram.
export const MEMBER_PERM_KEYS = ['sendMessages', 'sendMedia', 'addMembers', 'pinMessages', 'changeInfo', 'changeOwnTag'];
export function defaultPerms() {
  return { sendMessages: true, sendMedia: true, addMembers: true, pinMessages: true, changeInfo: true, changeOwnTag: false };
}
// Допустимые значения медленного режима (сек), как в Telegram.
export const SLOWMODE_ALLOWED = [0, 5, 10, 30, 60, 300, 900, 3600];

export function makeRoom({ type, name, creator, domain }) {
  if (type !== 'group' && type !== 'channel') throw new Error('type должен быть group или channel');
  return {
    id: newRoomId(domain),
    type,
    name: name || (type === 'channel' ? 'Канал' : 'Группа'),
    description: '',
    avatar: null,                                       // { mime, data(base64) }
    creator,
    owner: creator,                                     // владелец (полные права)
    admins: [creator],                                  // всё, кроме передачи прав
    moderators: [],                                     // следят за порядком (удаление)
    members: type === 'group' ? [creator] : [creator], // в канале creator — админ-вещатель
    subscribers: [],                                    // только для каналов
    banned: [],                                         // забаненные (не могут вернуться)
    readOnly: false,                                    // «только чтение» для группы
    privacy: 'private',                                 // 'public' | 'private' (по умолчанию частная)
    slowModeSec: 0,                                     // медленный режим (0 = выкл)
    historyVisible: true,                               // видна ли история новым участникам
    perms: defaultPerms(),                              // права рядового участника группы
    permExceptions: {},                                 // userId → частичный оверрайд прав
    keyEpoch: type === 'channel' ? 1 : 0,               // текущая эпоха ключа канала
    reactionsEnabled: true,                             // разрешены ли реакции на посты
    paidReactionsEnabled: false,                        // платные реакции (донат 👻 автору)
    reactionEmojis: [...DEFAULT_REACTIONS],             // набор доступных реакций
    maxReactions: 11,                                   // макс. РАЗНЫХ реакций на публикацию (1..11)
    createdAt: Date.now(),
  };
}

/** Эффективные права участника: owner/админ — всё true; иначе базовые perms + исключение. */
export function effectivePerms(room, userId) {
  if (canManage(room, userId)) { const all = {}; for (const k of MEMBER_PERM_KEYS) all[k] = true; return all; }
  const base = { ...defaultPerms(), ...(room.perms || {}) };
  const ex = (room.permExceptions || {})[userId] || {};
  const out = {}; for (const k of MEMBER_PERM_KEYS) out[k] = k in ex ? !!ex[k] : !!base[k];
  return out;
}
/** Может ли участник конкретное действие (ключ из MEMBER_PERM_KEYS). */
export function memberCan(room, userId, key) { return !!effectivePerms(room, userId)[key]; }

/** Обновить настройки группы (владелец/админ): тип, медленный режим, историю, права, исключения. */
export function setRoomSettings(room, actor, patch = {}) {
  if (!canManage(room, actor)) throw new Error('Менять настройки может владелец или админ');
  const p = patch || {};
  if (p.privacy != null) { const v = String(p.privacy); if (v === 'public' || v === 'private') room.privacy = v; }
  if (p.slowModeSec != null) { const v = Math.floor(Number(p.slowModeSec)) || 0; room.slowModeSec = SLOWMODE_ALLOWED.includes(v) ? v : 0; }
  if (p.historyVisible != null) room.historyVisible = !!p.historyVisible;
  if (p.perms && typeof p.perms === 'object') { room.perms = { ...defaultPerms(), ...(room.perms || {}) }; for (const k of MEMBER_PERM_KEYS) if (k in p.perms) room.perms[k] = !!p.perms[k]; }
  if (p.permExceptions && typeof p.permExceptions === 'object') {
    const out = {}; for (const [u, ov] of Object.entries(p.permExceptions)) { if (!u || typeof ov !== 'object' || !ov) continue; const e = {}; for (const k of MEMBER_PERM_KEYS) if (k in ov) e[k] = !!ov[k]; if (Object.keys(e).length) out[u] = e; }
    room.permExceptions = out;
  }
  return room;
}

/** Настройки реакций комнаты/канала (владелец или админ). */
export function setRoomReactions(room, actor, { reactionsEnabled, paidReactionsEnabled, reactionEmojis, maxReactions } = {}) {
  if (!canManage(room, actor)) throw new Error('Менять настройки реакций может владелец или админ');
  if (reactionsEnabled != null) room.reactionsEnabled = !!reactionsEnabled;
  if (paidReactionsEnabled != null) room.paidReactionsEnabled = !!paidReactionsEnabled;
  if (Array.isArray(reactionEmojis)) room.reactionEmojis = reactionEmojis.filter((e) => typeof e === 'string' && e).slice(0, 64);
  if (!room.reactionEmojis || !room.reactionEmojis.length) room.reactionEmojis = [...DEFAULT_REACTIONS];
  if (maxReactions != null) room.maxReactions = Math.max(1, Math.min(11, Math.floor(Number(maxReactions)) || 11));
  return room;
}

/** Может ли пользователь публиковать в комнату. */
export function canPost(room, userId) {
  if (room.type === 'group') {
    if (room.readOnly) return room.owner === userId || (room.admins || []).includes(userId); // read-only: только владелец/админы
    if (!room.members.includes(userId)) return false;
    return memberCan(room, userId, 'sendMessages'); // рядовой пишет, только если разрешено
  }
  return room.owner === userId || room.admins.includes(userId); // канал: вещают владелец/админы
}

// ── Роли ────────────────────────────────────────────────────────────────────
export function isOwner(room, u) { return room.owner === u; }
/** Управление комнатой: настройки, роли, приглашения (владелец и админы). */
export function canManage(room, u) { return room.owner === u || room.admins.includes(u); }
/** Модерация: удаление чужих сообщений (владелец, админы, модераторы). */
export function canModerate(room, u) { return room.owner === u || room.admins.includes(u) || (room.moderators || []).includes(u); }

/** Назначить роль. role ∈ admin|moderator|member. Владельца трогать нельзя. */
export function setRole(room, actor, target, role) {
  if (!canManage(room, actor)) throw new Error('Недостаточно прав для управления ролями');
  if (target === room.owner) throw new Error('Нельзя менять роль владельца');
  room.admins = (room.admins || []).filter((u) => u !== target);
  room.moderators = (room.moderators || []).filter((u) => u !== target);
  if (role === 'admin') room.admins.push(target);
  else if (role === 'moderator') room.moderators.push(target);
  else if (role !== 'member') throw new Error('Неизвестная роль');
  return room;
}

/** Передать владельца (только текущий владелец). Старый владелец остаётся админом. */
export function transferOwner(room, actor, newOwner) {
  if (room.owner !== actor) throw new Error('Передать права может только владелец');
  const old = room.owner;
  room.owner = newOwner;
  room.admins = (room.admins || []).filter((u) => u !== newOwner);
  if (!room.admins.includes(old)) room.admins.push(old);
  return room;
}

// ── Кик / бан ────────────────────────────────────────────────────────────────
export function rank(room, u) { if (room.owner === u) return 3; if ((room.admins || []).includes(u)) return 2; if ((room.moderators || []).includes(u)) return 1; return 0; }
/** Может ли actor кикнуть/забанить target: нужна модерация и СТРОГО выше ранг. */
export function canActOn(room, actor, target) {
  if (target === room.owner || actor === target) return false;
  return canModerate(room, actor) && rank(room, actor) > rank(room, target);
}
export function kick(room, actor, target) {
  if (!canActOn(room, actor, target)) throw new Error('Недостаточно прав, чтобы удалить этого участника');
  removeParticipant(room, target);
  return room;
}
export function ban(room, actor, target) {
  if (!canActOn(room, actor, target)) throw new Error('Недостаточно прав, чтобы забанить этого участника');
  removeParticipant(room, target);
  room.banned = room.banned || [];
  if (!room.banned.includes(target)) room.banned.push(target);
  return room;
}
export function unban(room, actor, target) {
  if (!canManage(room, actor)) throw new Error('Разбанить может владелец или админ');
  room.banned = (room.banned || []).filter((u) => u !== target);
  return room;
}
export function setReadOnly(room, actor, value) {
  if (!canManage(room, actor)) throw new Error('Менять режим может владелец или админ');
  room.readOnly = !!value;
  return room;
}
export function isBanned(room, u) { return (room.banned || []).includes(u); }

/** Кто состоит в комнате вообще (для проверки прав на чтение/членство). */
export function isParticipant(room, userId) {
  return room.members.includes(userId) || room.subscribers.includes(userId) || room.admins.includes(userId);
}

/** Список получателей сообщения от sender (себе конверт не шлём). */
export function recipientsOf(room, senderId) {
  const set = new Set([...room.members, ...room.subscribers, ...room.admins]);
  set.delete(senderId);
  return [...set];
}

/** Добавить участника (в группу — в members, в канал — в subscribers). */
export function addParticipant(room, userId) {
  if (room.type === 'group') {
    if (!room.members.includes(userId)) room.members.push(userId);
  } else {
    if (!room.subscribers.includes(userId) && !room.admins.includes(userId)) room.subscribers.push(userId);
  }
  return room;
}

export function removeParticipant(room, userId) {
  room.members = room.members.filter((u) => u !== userId);
  room.subscribers = room.subscribers.filter((u) => u !== userId);
  room.admins = room.admins.filter((u) => u !== userId);
  room.moderators = (room.moderators || []).filter((u) => u !== userId);
  return room;
}

/** Публичное представление комнаты для клиента. */
export function publicView(room) {
  return {
    id: room.id, type: room.type, name: room.name, description: room.description || '',
    avatar: room.avatar || null, creator: room.creator, owner: room.owner || room.creator,
    admins: room.admins, moderators: room.moderators || [], members: room.members, subscribers: room.subscribers,
    banned: room.banned || [], readOnly: !!room.readOnly, keyEpoch: room.keyEpoch || 0,
    privacy: room.privacy === 'public' ? 'public' : 'private',
    slowModeSec: room.slowModeSec || 0,
    historyVisible: room.historyVisible !== false,
    perms: { ...defaultPerms(), ...(room.perms || {}) },
    permExceptions: room.permExceptions || {},
    reactionsEnabled: room.reactionsEnabled !== false,
    paidReactionsEnabled: !!room.paidReactionsEnabled,
    reactionEmojis: (room.reactionEmojis && room.reactionEmojis.length) ? room.reactionEmojis : [...DEFAULT_REACTIONS],
    maxReactions: room.maxReactions || 11,
    retention: room.retention || null, createdAt: room.createdAt,
  };
}
