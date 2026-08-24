// economy.js — деньги VPN: тариф, делёж выручки, начисление наград.
//
// Правила от владельца проекта:
//   • Цена подписки задаётся в админке Банка (например 150 👻/мес).
//   • Выручка делится: по умолчанию 50% оператору выходного узла, 50% сервису.
//     Проценты настраиваются в админке.
//   • Делёж между несколькими выходами — ПРОПОРЦИОНАЛЬНО прокачанному трафику:
//     кто больше отдал байт для оплаченных сессий, тот больше и получил.
//
// Здесь — чистый расчёт. Хранилище балансов и списание призраков — на стороне
// Банка (PHP), сюда приходят только суммы и счётчики трафика.

/** Политика по умолчанию. В проде приходит из настроек Банка. */
export const DEFAULT_POLICY = {
  priceGhosts: 150,        // цена подписки в месяц, 👻
  operatorPct: 50,         // доля оператора выходного узла, %
  servicePct: 50,          // доля сервиса, %
  minPayoutGhosts: 1,      // меньше — копим до следующего периода
};

/** Проверить и нормализовать политику (проценты обязаны давать 100). */
export function normalizePolicy(p = {}) {
  const pol = { ...DEFAULT_POLICY, ...p };
  const op = Number(pol.operatorPct), sv = Number(pol.servicePct);
  if (!Number.isFinite(op) || !Number.isFinite(sv) || op < 0 || sv < 0) throw new Error('доли должны быть неотрицательными числами');
  if (op + sv !== 100) throw new Error(`доли должны давать 100% (сейчас ${op + sv})`);
  if (!Number.isFinite(pol.priceGhosts) || pol.priceGhosts < 0) throw new Error('цена должна быть неотрицательной');
  return pol;
}

/**
 * Разделить выручку за период между сервисом и операторами выходов.
 *
 * @param {object} p
 * @param {number} p.revenueGhosts — вся выручка за период (сумма оплат подписок).
 * @param {object[]} p.usage — [{operator, nodeId, bytes}] — сколько байт отдал
 *        каждый выходной узел для ОПЛАЧЕННЫХ сессий за период.
 * @param {object} p.policy — политика делёжа.
 * @returns {{service, operators:[{operator, ghosts, bytes, share}] , dust}}
 */
export function splitRevenue({ revenueGhosts, usage = [], policy }) {
  const pol = normalizePolicy(policy);
  const serviceCut = Math.floor(revenueGhosts * pol.servicePct / 100);
  const operatorsPool = revenueGhosts - serviceCut;   // остаток — операторам, без потерь на округлении

  const totalBytes = usage.reduce((a, u) => a + Math.max(0, u.bytes || 0), 0);
  if (totalBytes === 0 || operatorsPool === 0) {
    // Никто ничего не прокачал (или операторам ничего не причитается) — всё сервису.
    return { service: revenueGhosts, operators: [], dust: 0 };
  }

  // Пропорционально трафику. Остаток от округления («пыль») отдаём сервису,
  // чтобы сумма сходилась до призрака.
  let handed = 0;
  const operators = usage
    .filter((u) => (u.bytes || 0) > 0)
    .map((u) => {
      const share = u.bytes / totalBytes;
      const ghosts = Math.floor(operatorsPool * share);
      handed += ghosts;
      return { operator: u.operator, nodeId: u.nodeId, bytes: u.bytes, share: Math.round(share * 1e4) / 1e4, ghosts };
    })
    .filter((o) => o.ghosts >= pol.minPayoutGhosts);

  const dust = operatorsPool - handed;   // недоразделённый остаток
  return { service: serviceCut + dust, operators, dust };
}

/**
 * Аккумулятор трафика оплаченных сессий на выходном узле — из него потом
 * формируется usage для splitRevenue. Узел считает байты по билетам, не зная,
 * кто клиент.
 */
export function makeUsageMeter() {
  const byNode = new Map();   // nodeId → {operator, bytes}
  return {
    add(nodeId, operator, bytes) {
      const e = byNode.get(nodeId) || { operator, bytes: 0 };
      e.bytes += Math.max(0, bytes || 0);
      byNode.set(nodeId, e);
    },
    snapshot() { return [...byNode.entries()].map(([nodeId, e]) => ({ nodeId, operator: e.operator, bytes: e.bytes })); },
    reset() { byNode.clear(); },
  };
}
