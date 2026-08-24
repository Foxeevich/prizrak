// retention.js — сроки хранения истории.
// Перечень как просил админ: вечно, 1 год, полгода, 3 мес, 1 мес, 2 недели,
// 1 неделя, 3 дня, 1 день. Пользовательский срок НЕ может превышать админский.
const DAY = 86400;
export const RETENTIONS = {
  forever: Infinity,
  '1y': 365 * DAY,
  '6mo': 182 * DAY,
  '3mo': 91 * DAY,
  '1mo': 30 * DAY,
  '2w': 14 * DAY,
  '1w': 7 * DAY,
  '3d': 3 * DAY,
  '1d': 1 * DAY,
};
export const RETENTION_NAMES = Object.keys(RETENTIONS);

export function isValidRetention(name) { return Object.prototype.hasOwnProperty.call(RETENTIONS, name); }
export function retentionSeconds(name) { return RETENTIONS[name] ?? Infinity; }

/**
 * Клампинг: вернуть более СТРОГИЙ (короткий) из двух сроков.
 * Если пользователь просит дольше админского — вернётся админский.
 */
export function clampRetention(userName, adminName) {
  const u = isValidRetention(userName) ? userName : 'forever';
  const a = isValidRetention(adminName) ? adminName : 'forever';
  return retentionSeconds(u) <= retentionSeconds(a) ? u : a;
}
