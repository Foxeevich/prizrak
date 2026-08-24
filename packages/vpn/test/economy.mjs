// economy.mjs — тест тарифа, делёжа выручки и учёта трафика.
import { normalizePolicy, splitRevenue, makeUsageMeter, DEFAULT_POLICY } from '../src/economy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const sum = (a) => a.reduce((x, y) => x + y, 0);

// ── Политика ──────────────────────────────────────────────────────────────────
ok(DEFAULT_POLICY.priceGhosts === 150 && DEFAULT_POLICY.operatorPct === 50, 'дефолт: 150 👻, делёж 50/50');
ok(normalizePolicy({ operatorPct: 70, servicePct: 30 }).operatorPct === 70, 'кастомный делёж принимается');
let threw = false; try { normalizePolicy({ operatorPct: 60, servicePct: 30 }); } catch { threw = true; }
ok(threw, 'доли, не дающие 100%, отвергнуты');
threw = false; try { normalizePolicy({ priceGhosts: -1 }); } catch { threw = true; }
ok(threw, 'отрицательная цена отвергнута');

// ── Делёж 50/50 между двумя выходами пропорц. трафику ─────────────────────────
const r = splitRevenue({
  revenueGhosts: 1000,
  usage: [
    { operator: 'op-A', nodeId: 'exit-A', bytes: 3_000_000 },
    { operator: 'op-B', nodeId: 'exit-B', bytes: 1_000_000 },
  ],
  policy: { operatorPct: 50, servicePct: 50 },
});
// Сервис 500, операторам 500; A прокачал 75% → 375, B 25% → 125.
ok(r.service === 500, 'сервису — половина (500)');
const a = r.operators.find((o) => o.operator === 'op-A'), b = r.operators.find((o) => o.operator === 'op-B');
ok(a.ghosts === 375 && b.ghosts === 125, 'операторам — пропорционально трафику (375 / 125)');
ok(r.service + sum(r.operators.map((o) => o.ghosts)) === 1000, 'сумма выплат сходится до призрака (без потерь)');

// ── Округление: «пыль» уходит сервису, всё сходится ───────────────────────────
const r2 = splitRevenue({
  revenueGhosts: 100,
  usage: [
    { operator: 'x', nodeId: 'nx', bytes: 1 },
    { operator: 'y', nodeId: 'ny', bytes: 1 },
    { operator: 'z', nodeId: 'nz', bytes: 1 },
  ],
  policy: { operatorPct: 50, servicePct: 50 },
});
ok(r2.service + sum(r2.operators.map((o) => o.ghosts)) === 100, 'при неделимости остаток («пыль») отдан сервису, сумма = 100');

// ── Никто не прокачал → всё сервису ───────────────────────────────────────────
const r3 = splitRevenue({ revenueGhosts: 300, usage: [], policy: DEFAULT_POLICY });
ok(r3.service === 300 && r3.operators.length === 0, 'нет трафика операторов — вся выручка сервису');

// ── Кастомный делёж 70/30 ─────────────────────────────────────────────────────
const r4 = splitRevenue({
  revenueGhosts: 1000,
  usage: [{ operator: 'solo', nodeId: 'n', bytes: 500 }],
  policy: { operatorPct: 70, servicePct: 30 },
});
ok(r4.service === 300 && r4.operators[0].ghosts === 700, 'делёж 70/30 применён (700 оператору, 300 сервису)');

// ── Учёт трафика ──────────────────────────────────────────────────────────────
const meter = makeUsageMeter();
meter.add('exit-A', 'op-A', 1000);
meter.add('exit-A', 'op-A', 500);
meter.add('exit-B', 'op-B', 2000);
const snap = meter.snapshot();
ok(snap.find((s) => s.nodeId === 'exit-A').bytes === 1500, 'счётчик суммирует байты узла');
ok(snap.length === 2, 'два узла в снимке');
meter.reset();
ok(meter.snapshot().length === 0, 'сброс обнуляет учёт (новый период)');

// Интеграция: снимок метра прямо в делёж
const meter2 = makeUsageMeter();
meter2.add('e1', 'o1', 4_000_000);
meter2.add('e2', 'o2', 4_000_000);
const r5 = splitRevenue({ revenueGhosts: 200, usage: meter2.snapshot(), policy: DEFAULT_POLICY });
ok(r5.operators.length === 2 && r5.operators[0].ghosts === 50 && r5.operators[1].ghosts === 50, 'равный трафик → равные выплаты (50/50 из 100 пула)');

console.log(`\n«Экономика»: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
