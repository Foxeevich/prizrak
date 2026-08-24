// countries.mjs — тест реестра стран, проверки страны и рейтинга.
import { verifyCountry, countryList, neighborsOf, countryName, countryFlag } from '../src/countries.js';
import { submitRating, summary, freshRatings, FRESH_DAYS, PRIOR_WEIGHT, HIDE_BELOW } from '../src/ratings.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
const DAY = 86400;

// ── Реестр ────────────────────────────────────────────────────────────────────
ok(countryName('FR') === 'Франция' && countryFlag('FR') === '🇫🇷', 'имя и флаг страны');
ok(neighborsOf('FR').includes('DE'), 'у Франции есть соседи для авто-подхвата');
ok(neighborsOf('ZZ').length === 0, 'у неизвестной страны соседей нет');

// ── Проверка страны по наблюдаемому адресу ────────────────────────────────────
const geoip = (ip) => ({ '1.1.1.1': 'FR', '2.2.2.2': 'DE' }[ip] || null);
const good = verifyCountry({ claimed: 'FR', observedIp: '1.1.1.1', geoip });
ok(good.ok && good.country === 'FR' && !good.mismatch, 'заявка совпала с наблюдением');
const lie = verifyCountry({ claimed: 'FR', observedIp: '2.2.2.2', geoip });
ok(lie.ok && lie.country === 'DE' && lie.mismatch, 'оператор соврал — верим наблюдению (DE), помечаем расхождение');
ok(!verifyCountry({ claimed: 'FR', observedIp: '9.9.9.9', geoip }).ok, 'страна не определилась — не ок');

// ── Рейтинг: базовое среднее и Байес ──────────────────────────────────────────
const store = new Map(), last = new Map();
const now = 1_000_000_000;

// Узел с единственной пятёркой не должен показывать «5.00»
submitRating(store, last, { nodeId: 'a', acct: 'u1', stars: 5, paid: true, nowSec: now });
const sA = summary(store, 'a', now);
ok(sA.mean < 5 && sA.mean > 3.5, 'одна «5» → Байес держит рейтинг ниже 5 (~3.75)');
ok(sA.count === 1, 'учтена одна оценка');

// Много четвёрок → среднее подтягивается к 4
for (let i = 0; i < 50; i++) submitRating(store, last, { nodeId: 'b', acct: 'u' + i, stars: 4, paid: true, nowSec: now });
ok(near(summary(store, 'b', now).mean, 4, 0.06), '50 четвёрок → около 4.00');
ok(/из 5$/.test(summary(store, 'b', now).text), 'текст в формате «X.XX из 5»');

// ── Антинакрутка ──────────────────────────────────────────────────────────────
ok(!submitRating(store, last, { nodeId: 'a', acct: 'u9', stars: 6, paid: true, nowSec: now }).ok, 'оценка вне 1..5 отклонена');
ok(!submitRating(store, last, { nodeId: 'a', acct: 'u9', stars: 5, paid: false, nowSec: now }).ok, 'без оплаченного билета оценка не принимается');
submitRating(store, last, { nodeId: 'c', acct: 'u1', stars: 5, paid: true, nowSec: now });
ok(!submitRating(store, last, { nodeId: 'c', acct: 'u1', stars: 1, paid: true, nowSec: now + 100 }).ok, 'вторая оценка тем же аккаунтом в сутки отклонена');
ok(submitRating(store, last, { nodeId: 'c', acct: 'u1', stars: 1, paid: true, nowSec: now + DAY + 1 }).ok, 'через сутки оценка снова можно');

// ── Свежесть ──────────────────────────────────────────────────────────────────
const store2 = new Map(), last2 = new Map();
submitRating(store2, last2, { nodeId: 'd', acct: 'old', stars: 5, paid: true, nowSec: now - (FRESH_DAYS + 5) * DAY });
submitRating(store2, last2, { nodeId: 'd', acct: 'new', stars: 2, paid: true, nowSec: now });
const fresh = freshRatings(store2, 'd', now);
ok(fresh.length === 1 && fresh[0].stars === 2, 'старые оценки (>60 дней) не учитываются');

// ── Скрытие плохих узлов ──────────────────────────────────────────────────────
const store3 = new Map(), last3 = new Map();
for (let i = 0; i < 10; i++) submitRating(store3, last3, { nodeId: 'bad', acct: 'u' + i, stars: 1, paid: true, nowSec: now });
const sBad = summary(store3, 'bad', now);
ok(sBad.mean < HIDE_BELOW && sBad.hidden, 'узел со стабильно низкими оценками скрывается');
const sFew = summary(store3, 'unknown', now);
ok(!sFew.hidden, 'узел без оценок не прячем (априор нейтральный)');

// ── Список стран для UI ───────────────────────────────────────────────────────
const exits = [
  { id: 'fr1', country: 'FR', alive: true },
  { id: 'fr2', country: 'FR', alive: true },
  { id: 'de1', country: 'DE', alive: true },
  { id: 'de2', country: 'DE', alive: false },  // мёртвый — не считаем
];
const rateOf = (id) => ({ fr1: 4.8, fr2: 4.0, de1: 4.6 }[id] ?? null);
const list = countryList(exits, rateOf);
const fr = list.find((c) => c.code === 'FR'), de = list.find((c) => c.code === 'DE');
ok(fr.nodes === 2 && near(fr.rating, 4.4), 'Франция: 2 живых узла, средняя 4.40');
ok(de.nodes === 1, 'Германия: мёртвый узел не учтён (1 живой)');
ok(fr.ratingText === '4.40 из 5', 'текст рейтинга страны «4.40 из 5»');
ok(list[0].code === 'DE' || list[0].rating >= list[1].rating, 'страны отсортированы по рейтингу');

console.log(`\n«Страны и рейтинг»: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
