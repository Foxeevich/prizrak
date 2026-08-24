// countries.js — реестр стран выхода и честная проверка страны.
//
// Пользователь выбирает страну выхода в приложении. Но страну узла нельзя брать
// со слов оператора («у меня Франция») — проверяем по GeoIP **наблюдаемого**
// адреса, с которого узел реально выходит в интернет. Заявка и наблюдение
// разошлись — верим наблюдению и помечаем узел.
//
// Здесь — реестр (какие страны показывать, флаги, соседи для авто-подхвата) и
// логика сверки. Сам GeoIP-резолвер инъектируется (в проде — база MaxMind или
// аналог на стороне директории), чтобы модуль оставался чистым и тестируемым.

// Соседи для авто-подхвата (§7e/health.js). Сеть-география, не политика:
// куда разумно перекинуть пользователя, если его страна кончилась.
export const NEIGHBORS = {
  FR: ['DE', 'NL', 'BE', 'CH', 'ES'],
  DE: ['NL', 'FR', 'PL', 'CH', 'AT'],
  NL: ['DE', 'BE', 'FR', 'GB'],
  SE: ['FI', 'NO', 'DK', 'DE'],
  GB: ['NL', 'FR', 'IE', 'DE'],
  US: ['CA'],
  PL: ['DE', 'CZ', 'LT'],
};

const NAMES = {
  FR: 'Франция', DE: 'Германия', NL: 'Нидерланды', BE: 'Бельгия', CH: 'Швейцария',
  ES: 'Испания', PL: 'Польша', SE: 'Швеция', FI: 'Финляндия', NO: 'Норвегия',
  DK: 'Дания', GB: 'Великобритания', IE: 'Ирландия', US: 'США', CA: 'Канада',
  AT: 'Австрия', CZ: 'Чехия', LT: 'Литва',
};
const FLAGS = {
  FR: '🇫🇷', DE: '🇩🇪', NL: '🇳🇱', BE: '🇧🇪', CH: '🇨🇭', ES: '🇪🇸', PL: '🇵🇱',
  SE: '🇸🇪', FI: '🇫🇮', NO: '🇳🇴', DK: '🇩🇰', GB: '🇬🇧', IE: '🇮🇪', US: '🇺🇸',
  CA: '🇨🇦', AT: '🇦🇹', CZ: '🇨🇿', LT: '🇱🇹',
};

export const countryName = (code) => NAMES[code] || code;
export const countryFlag = (code) => FLAGS[code] || '🏳️';
export const neighborsOf = (code) => NEIGHBORS[code] || [];

/**
 * Сверить заявленную страну узла с наблюдаемым адресом.
 * @param {object} p
 * @param {string} p.claimed — что заявил оператор (ISO-код).
 * @param {string} p.observedIp — адрес, с которого узел реально выходит.
 * @param {function} p.geoip — (ip) => ISO-код страны (инъекция).
 * @returns {{ok, country, claimed, mismatch}} — country это ИСТИНА (по наблюдению).
 */
export function verifyCountry({ claimed, observedIp, geoip }) {
  const observed = (geoip && geoip(observedIp)) || null;
  if (!observed) return { ok: false, country: null, claimed, mismatch: false, reason: 'страна не определена' };
  const mismatch = claimed != null && claimed !== observed;
  return { ok: true, country: observed, claimed, mismatch };
}

/**
 * Собрать список стран для экрана выбора: только страны, где есть живые выходы,
 * с агрегатами (число узлов, лучший/средний рейтинг). rateOf — как получить
 * рейтинг узла (обычно ratings.summary(...).mean).
 *
 * @param {object[]} exitNodes — [{id, country, alive, ...}]
 * @param {function} rateOf — (nodeId) => число рейтинга или null
 */
export function countryList(exitNodes, rateOf = () => null) {
  const by = new Map();
  for (const n of exitNodes) {
    if (n.alive === false) continue;
    const c = n.country;
    if (!c) continue;
    if (!by.has(c)) by.set(c, { code: c, name: countryName(c), flag: countryFlag(c), nodes: 0, ratings: [] });
    const e = by.get(c);
    e.nodes += 1;
    const r = rateOf(n.id);
    if (typeof r === 'number') e.ratings.push(r);
  }
  const out = [];
  for (const e of by.values()) {
    const avg = e.ratings.length ? e.ratings.reduce((a, b) => a + b, 0) / e.ratings.length : null;
    out.push({
      code: e.code, name: e.name, flag: e.flag, nodes: e.nodes,
      rating: avg == null ? null : Math.round(avg * 100) / 100,     // «4.35»
      ratingText: avg == null ? '—' : `${(Math.round(avg * 100) / 100).toFixed(2)} из 5`,
    });
  }
  // Сортировка: сначала по рейтингу (где он есть), потом по имени.
  out.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.name.localeCompare(b.name, 'ru'));
  return out;
}
