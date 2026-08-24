// engine.mjs — тест движка клиента: выбор узлов, отказоустойчивость,
// make-before-break, и главный инвариант «никогда не пускать трафик мимо туннеля».
import { makeEngine } from '../src/engine.js';
import { makeAddressBook, packShare } from '../src/flock.js';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// Директория и книга с реле (RU) и выходами (FR, DE, SE).
const seed = bytesToHex(ed25519.utils.randomPrivateKey());
const pub = bytesToHex(ed25519.getPublicKey(seed));
const mkBook = () => {
  const book = makeAddressBook({ trustedPubs: [pub], k: 5 });
  const nodes = [
    { id: 'ru-relay-1', roles: ['relay'], country: 'RU', epoch: 1 },
    { id: 'ru-relay-2', roles: ['relay'], country: 'RU', epoch: 1 },
    { id: 'fr-1', roles: ['exit'], country: 'FR', epoch: 1 },
    { id: 'fr-2', roles: ['exit'], country: 'FR', epoch: 1 },
    { id: 'de-1', roles: ['exit'], country: 'DE', epoch: 1 },
    { id: 'se-1', roles: ['exit'], country: 'SE', epoch: 1 },
  ];
  for (const n of nodes) book.accept(packShare(seed, { ...n, addrs: [n.id + ':443'] }));
  return book;
};
const rating = { 'fr-1': 4.9, 'fr-2': 4.2, 'de-1': 4.6, 'se-1': 4.8 };
const rateOf = (id) => rating[id] ?? 3;

// Управляемый connect: по умолчанию поднимает цепочку; можно «ломать» узлы.
function connector(broken = new Set()) {
  return async ({ relay, exit }) => {
    if (broken.has(exit.id) || broken.has(relay.id)) return null;
    return { id: `${relay.id}>${exit.id}`, send: (b) => b, recv: (b) => b, close: async () => {} };
  };
}

// ── Подъём: выбираем лучший выход страны ──────────────────────────────────────
{
  const states = [];
  const eng = makeEngine({ book: mkBook(), connect: connector(), rateOf, onState: (s) => states.push(s) });
  ok(!eng.trafficAllowed(), 'до маскировки трафик наружу НЕ разрешён');
  const okUp = await eng.mask('FR');
  ok(okUp && eng.state() === 'up', 'маскировка поднялась');
  ok(eng.currentExit() === 'fr-1', 'выбран лучший по рейтингу выход Франции (fr-1)');
  ok(eng.trafficAllowed(), 'туннель поднят — трафик разрешён');
  ok(states.includes('connecting') && states.includes('up'), 'состояния прошли connecting→up');
}

// ── send запрещён вне состояния up ────────────────────────────────────────────
{
  const eng = makeEngine({ book: mkBook(), connect: connector(), rateOf });
  let threw = false; try { eng.send(new Uint8Array([1])); } catch { threw = true; }
  ok(threw, 'send до подъёма туннеля бросает — трафик наружу не выпускается');
  await eng.mask('FR');
  ok(eng.send(new Uint8Array([1, 2, 3])).length === 3, 'после подъёма send работает');
}

// ── Автозамена внутри страны (тихо) ───────────────────────────────────────────
{
  const notices = [];
  const eng = makeEngine({ book: mkBook(), connect: connector(), rateOf, onNotice: (n) => notices.push(n) });
  await eng.mask('FR');
  ok(eng.currentExit() === 'fr-1', 'на fr-1');
  await eng.onExitFailed();
  ok(eng.currentExit() === 'fr-2' && eng.state() === 'up', 'fr-1 умер → тихо перешли на fr-2 (та же страна)');
  ok(notices.filter((n) => n.level === 'notice').length === 0, 'смена узла ВНУТРИ страны без уведомления');
}

// ── Кончились свои — уходим в соседнюю страну (с уведомлением) ─────────────────
{
  const notices = [];
  const eng = makeEngine({ book: mkBook(), connect: connector(), rateOf, onNotice: (n) => notices.push(n) });
  await eng.mask('FR');
  await eng.onExitFailed();   // fr-1 → fr-2
  await eng.onExitFailed();   // fr-2 умер, своих нет → соседняя страна
  ok(['DE', 'NL', 'BE', 'CH', 'ES'].includes(eng.country()) && eng.state() === 'up', 'ушли в соседнюю страну');
  ok(notices.some((n) => n.level === 'notice' && n.canChoose), 'смена СТРАНЫ показана уведомлением');
  ok(eng.currentExit() === 'de-1', 'в соседней стране взяли живой выход (de-1)');
}

// ── Совсем нет выходов → «ищу», трафик в обход НЕ пускаем ──────────────────────
{
  const broken = new Set(['fr-1', 'fr-2', 'de-1', 'se-1']);
  let refill = 0;
  const eng = makeEngine({ book: mkBook(), connect: connector(broken), rateOf, onRefill: () => refill++ });
  const okUp = await eng.mask('FR');
  ok(!okUp && eng.state() === 'searching', 'ни один выход не поднялся → состояние «ищу»');
  ok(!eng.trafficAllowed(), 'в состоянии «ищу» трафик наружу НЕ разрешён (нет голого IP)');
  ok(refill > 0, 'запрошена дозаправка адресов у «Стаи»');
}

// ── Смена страны на лету: make-before-break ───────────────────────────────────
{
  const eng = makeEngine({ book: mkBook(), connect: connector(), rateOf });
  await eng.mask('FR');
  const okSw = await eng.switchCountry('SE');
  ok(okSw && eng.country() === 'SE' && eng.currentExit() === 'se-1', 'переключились на Швецию');
  ok(eng.state() === 'up', 'после переключения туннель поднят');
}

// ── Откат, если новая страна недоступна: старую цепочку не рвём ────────────────
{
  const broken = new Set(['se-1']);   // Швеция недоступна
  const eng = makeEngine({ book: mkBook(), connect: connector(broken), rateOf });
  await eng.mask('FR');
  const before = eng.currentExit();
  const okSw = await eng.switchCountry('SE');
  ok(!okSw, 'переключение в недоступную страну не удалось');
  ok(eng.country() === 'FR' && eng.currentExit() === before && eng.state() === 'up',
    'откатились на Францию, старая цепочка цела (make-before-break)');
}

console.log(`\n«Движок»: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
