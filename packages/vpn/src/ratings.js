// ratings.js — рейтинг узлов 1–5 звёзд от пользователей.
//
// Пользователь ставит узлу оценку качества; на экране выбора страны видна
// средняя, например «4.35 из 5». Наивное среднее ломается тремя способами,
// которые тут закрыты:
//
//  1. Мало оценок. Узел с единственной «5» не должен обгонять узел с сотней
//     четвёрок. Лечение: БАЙЕСОВА поправка — подмешиваем априор (глобальное
//     среднее) с весом m, пока своих оценок мало.
//  2. Старьё. Узел деградировал, а старые пятёрки держат рейтинг. Лечение:
//     СВЕЖЕСТЬ — оценки старше 60 дней не учитываем.
//  3. Накрутка. Лечение (частично здесь, частично в приёме): одна оценка на
//     узел в сутки от аккаунта, и только с ОПЛАЧЕННОГО билета; ниже 2.5 узел
//     скрывается из выдачи.

export const FRESH_DAYS = 60;
export const PRIOR_MEAN = 3.5;   // априорное среднее (нейтрально-хорошее)
export const PRIOR_WEIGHT = 5;   // сколько «виртуальных» оценок априора
export const HIDE_BELOW = 2.5;   // ниже — прячем из списка
const DAY = 86400;

/**
 * Принять оценку. Возвращает {ok} или {ok:false, reason}. Антинакрутка:
 *  • оценка 1..5 целая;
 *  • только с оплаченного билета (paid=true);
 *  • не чаще одной на узел в сутки от аккаунта.
 *
 * @param {Map} store — nodeId → [{acct, stars, ts}]
 * @param {Map} lastByAcct — `${nodeId}|${acct}` → ts последней оценки
 */
export function submitRating(store, lastByAcct, { nodeId, acct, stars, paid, nowSec = Math.floor(Date.now() / 1000) }) {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { ok: false, reason: 'оценка вне 1..5' };
  if (!paid) return { ok: false, reason: 'оценивать может только оплативший' };
  const key = `${nodeId}|${acct}`;
  const last = lastByAcct.get(key);
  if (last != null && nowSec - last < DAY) return { ok: false, reason: 'не чаще раза в сутки' };
  const arr = store.get(nodeId) || [];
  arr.push({ acct, stars, ts: nowSec });
  store.set(nodeId, arr);
  lastByAcct.set(key, nowSec);
  return { ok: true };
}

/**
 * Свежие оценки узла: не старше FRESH_DAYS, по одной последней на аккаунт
 * (чтобы аккаунт не «накапливал вес»).
 */
export function freshRatings(store, nodeId, nowSec = Math.floor(Date.now() / 1000)) {
  const arr = store.get(nodeId) || [];
  const cutoff = nowSec - FRESH_DAYS * DAY;
  const latestByAcct = new Map();
  for (const r of arr) {
    if (r.ts < cutoff) continue;
    const prev = latestByAcct.get(r.acct);
    if (!prev || r.ts > prev.ts) latestByAcct.set(r.acct, r);
  }
  return [...latestByAcct.values()];
}

/**
 * Итоговая сводка по узлу: байесово среднее, число оценок, текст и видимость.
 * mean — то самое «4.35 из 5».
 */
export function summary(store, nodeId, nowSec = Math.floor(Date.now() / 1000)) {
  const rs = freshRatings(store, nodeId, nowSec);
  const n = rs.length;
  const sum = rs.reduce((a, r) => a + r.stars, 0);
  // Байес: (априор*вес + сумма) / (вес + n)
  const mean = (PRIOR_MEAN * PRIOR_WEIGHT + sum) / (PRIOR_WEIGHT + n);
  const rounded = Math.round(mean * 100) / 100;
  return {
    nodeId,
    count: n,
    mean: rounded,
    text: `${rounded.toFixed(2)} из 5`,
    hidden: n >= PRIOR_WEIGHT && rounded < HIDE_BELOW,   // прячем только когда оценок уже достаточно
  };
}

/** Средняя по стране: усреднение видимых узлов (для countryList). */
export function meanOf(store, nodeId, nowSec) {
  return summary(store, nodeId, nowSec).mean;
}
