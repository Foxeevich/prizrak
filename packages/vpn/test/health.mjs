// health.mjs — тест живучести: обнаружение отвала и автоподхват.
import { makeWatcher, pickReplacement, switchNotice, LIMITS } from '../src/health.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// ── Наблюдатель ──────────────────────────────────────────────────────────────
const w = makeWatcher();
w.onReply(40); w.onReply(45); w.onReply(38);
ok(w.state() === 'ok', 'живой узел с нормальной задержкой — «ок»');

w.onMissedBeat(); w.onMissedBeat();
ok(w.state() === 'ok', 'два пропуска подряд ещё не приговор');
w.onMissedBeat();
ok(w.state() === 'dead', 'три пропуска подряд — узел мёртв');
w.onReply(50);
ok(w.state() === 'ok', 'ответ пришёл — счётчик пропусков сброшен');

// Обрыв несущей: одна попытка переподнять, потом смена узла
const w2 = makeWatcher();
w2.onReply(30);
w2.onCarrierClose();
ok(w2.mayReconnect(), 'после обрыва несущей даём попытку переподключиться');
ok(!w2.mayReconnect(), 'вторую попытку уже не даём');
ok(w2.state() === 'dead', 'несущая не поднялась — узел мёртв');

// Медленный ≠ мёртвый
const w3 = makeWatcher();
for (let i = 0; i < 5; i++) w3.onReply(3000);
ok(w3.state() === 'slow', 'большая задержка — «медленный», а не «мёртвый»');

const w4 = makeWatcher();
w4.onReply(50);
for (const bps of [1e6, 1e6, 1e6, 1e5]) w4.onThroughput(bps);
ok(w4.state() === 'slow', 'обвал скорости втрое от своей средней — «медленный»');

const w5 = makeWatcher();
w5.onReply(50); w5.onReply(60);
ok(w5.state() === 'ok', 'по двум замерам поспешных выводов не делаем');

// ── Выбор замены ─────────────────────────────────────────────────────────────
const nodes = [
  { id: 'fr-1', country: 'FR', rating: 4.8, alive: true },
  { id: 'fr-2', country: 'FR', rating: 4.2, alive: true },
  { id: 'fr-3', country: 'FR', rating: 4.9, alive: false },
  { id: 'de-1', country: 'DE', rating: 4.6, alive: true },
  { id: 'se-1', country: 'SE', rating: 4.9, alive: true },
];
const neighbors = { FR: ['DE', 'NL', 'BE'] };

let r = pickReplacement({ nodes, country: 'FR', tried: new Set(['fr-1']), neighbors });
ok(r.node.id === 'fr-2' && !r.countryChanged, 'сначала другой узел той же страны');

r = pickReplacement({ nodes, country: 'FR', tried: new Set(['fr-1', 'fr-2']), neighbors });
ok(r.node.id === 'de-1' && r.countryChanged, 'своя страна кончилась — идём в соседнюю из реестра');
ok(r.from === 'FR', 'помним, откуда ушли (для уведомления)');

ok(pickReplacement({ nodes: nodes.filter((n) => n.country === 'FR'), country: 'FR', tried: new Set(['fr-1', 'fr-2']), neighbors }) === null,
  'живых нет вовсе — возвращаем null, а не «как-нибудь»');

ok(!pickReplacement({ nodes, country: 'FR', tried: new Set(), neighbors }).node.alive === false, 'мёртвые узлы в выдачу не попадают');
ok(pickReplacement({ nodes, country: 'FR', tried: new Set(), neighbors }).node.id === 'fr-1', 'внутри страны берём лучший по рейтингу');

r = pickReplacement({ nodes, country: 'FR', tried: new Set(['fr-1', 'fr-2']), neighbors: {} });
ok(r.node.id === 'se-1', 'без таблицы соседей берём лучшее живое по рейтингу');

// ── Уведомления ──────────────────────────────────────────────────────────────
ok(switchNotice({ node: { id: 'fr-2' }, countryChanged: false }).level === 'log', 'смена узла внутри страны — тихо, в журнал');
const nt = switchNotice({ node: { id: 'de-1', country: 'DE' }, countryChanged: true, from: 'FR' });
ok(nt.level === 'notice' && nt.canChoose, 'смена страны — уведомление с возможностью выбрать другую');
ok(switchNotice(null).level === 'error' && /обход туннеля не пускаю/.test(switchNotice(null).text),
  'узлов нет — честно говорим и НЕ пускаем трафик мимо туннеля');

ok(LIMITS.missedBeats === 3 && LIMITS.reconnectTries === 1, 'пороги вынесены в политику (правятся из реестра)');

console.log(`\n«Живучесть»: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
