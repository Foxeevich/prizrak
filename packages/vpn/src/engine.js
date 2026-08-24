// engine.js — движок клиента: связывает все слои в один туннель.
//
// Собирает воедино написанное на этапах 1–5 + живучесть:
//   Стая (адресная книга) → выбор реле+выхода по стране и рейтингу →
//   Эстафета (два прыжка) → Личина+Тень (сессии) → Дыхание (форма) →
//   Живучесть (следим, переключаемся).
//
// Криптографию и сокеты сюда НЕ тащим — они уже покрыты своими модулями и
// тестами. Движку дают `connect({relay, exit})`, который поднимает готовую
// цепочку и возвращает ручку {send, recv, close}. Так движок тестируется на
// СВОЁМ уровне: выбор узлов, отказоустойчивость, make-before-break, и главный
// инвариант — НИКОГДА не пускать трафик в обход туннеля.
//
// Состояния: 'off' → 'connecting' → 'up' ↔ 'switching' → 'searching' → 'off'.

import { pickReplacement, switchNotice } from './health.js';
import { neighborsOf } from './countries.js';

const now = () => Date.now();

/**
 * @param {object} p
 * @param {object} p.book — адресная книга «Стаи» (usable/burn/next/needsRefill).
 * @param {function} p.connect — async ({relay, exit}) => {send, recv, close, id}.
 * @param {function} p.rateOf — (nodeId) => рейтинг (для выбора лучшего выхода).
 * @param {function} p.onState — колбэк смены состояния (для UI).
 * @param {function} p.onNotice — колбэк уведомлений (смена страны и т.п.).
 * @param {function} p.onRefill — попросить «Стаю» дослать доли (мессенджер/тайник).
 */
export function makeEngine({ book, connect, rateOf = () => 0, onState = () => {}, onNotice = () => {}, onRefill = () => {} } = {}) {
  let state = 'off';
  let country = null;
  let circuit = null;            // текущая живая цепочка
  let curExit = null;            // текущий выходной узел
  const triedExits = new Set();  // что уже пробовали в этой сессии (для замены)

  // ГЛАВНЫЙ инвариант: пускать трафик устройства наружу можно ТОЛЬКО когда туннель
  // поднят. В любом другом состоянии — нет (лучше нет связи, чем голый IP).
  const trafficAllowed = () => state === 'up';

  const setState = (s) => { state = s; onState(s, { country, exit: curExit && curExit.id, trafficAllowed: trafficAllowed() }); };

  // Живые выходы нужной страны, лучшие по рейтингу, из ещё не пробованных.
  const exitsFor = (c) => book.usable({ role: 'exit', country: c })
    .filter((n) => !triedExits.has(n.id))
    .sort((a, b) => (rateOf(b.id) ?? 0) - (rateOf(a.id) ?? 0));

  const anyRelay = () => book.usable({ role: 'relay' }).sort((a, b) => (rateOf(b.id) ?? 0) - (rateOf(a.id) ?? 0))[0] || null;

  async function establish(exit) {
    const relay = anyRelay();
    if (!relay || !exit) return null;
    try {
      const ch = await connect({ relay, exit });
      return ch ? { ch, exit } : null;
    } catch { return null; }
  }

  return {
    state: () => state,
    country: () => country,
    currentExit: () => curExit && curExit.id,
    trafficAllowed,

    /** Включить маскировку в выбранной стране. */
    async mask(targetCountry) {
      country = targetCountry;
      triedExits.clear();
      setState('connecting');
      if (book.needsRefill({ role: 'exit' })) onRefill({ role: 'exit', country });

      for (const exit of exitsFor(country)) {
        triedExits.add(exit.id);
        const r = await establish(exit);
        if (r) { circuit = r.ch; curExit = r.exit; setState('up'); return true; }
        book.burn(exit.id);   // не поднялся — считаем сожжённым на эту сессию
      }
      // В выбранной стране не вышло — состояние «ищу», трафик НЕ пускаем.
      setState('searching');
      onRefill({ role: 'exit', country });
      return false;
    },

    /** Выключить маскировку. Трафик устройства идёт напрямую (пользователь так решил). */
    async maskOff() {
      if (circuit) { try { await circuit.close(); } catch {} }
      circuit = null; curExit = null; country = null;
      setState('off');
    },

    /**
     * Сменить страну на лету по правилу «сначала подключись, потом отключись»:
     * поднимаем новый выход, и только когда он готов — рвём старый.
     */
    async switchCountry(newCountry) {
      const prev = { circuit, exit: curExit, country };
      country = newCountry;
      triedExits.clear();
      setState('switching');
      for (const exit of exitsFor(newCountry)) {
        triedExits.add(exit.id);
        const r = await establish(exit);
        if (r) {
          // Новый готов — гасим старый (make-before-break).
          if (prev.circuit) { try { await prev.circuit.close(); } catch {} }
          circuit = r.ch; curExit = r.exit; setState('up'); return true;
        }
        book.burn(exit.id);
      }
      // Не вышло — откатываемся на прежнюю страну, старую цепочку НЕ рвали.
      country = prev.country; circuit = prev.circuit; curExit = prev.exit;
      setState(prev.circuit ? 'up' : 'searching');
      return false;
    },

    /**
     * Текущий выход умер/деградировал (сигнал от «Живучести»). Подхватываем:
     * другой узел той же страны → соседняя страна → ничего.
     */
    async onExitFailed() {
      if (curExit) { book.burn(curExit.id); triedExits.add(curExit.id); }
      if (circuit) { try { await circuit.close(); } catch {} circuit = null; }
      setState('switching');

      const res = pickReplacement({
        nodes: book.usable({ role: 'exit' }).map((n) => ({ ...n, rating: rateOf(n.id) })),
        country, tried: triedExits, neighbors: { [country]: neighborsOf(country) },
      });
      const notice = switchNotice(res);
      if (!res) {
        curExit = null; setState('searching'); onNotice(notice); onRefill({ role: 'exit', country });
        return false;   // трафик в обход туннеля НЕ пускаем
      }
      triedExits.add(res.node.id);
      const r = await establish(res.node);
      if (r) {
        if (res.countryChanged) country = res.node.country;
        circuit = r.ch; curExit = r.exit; setState('up');
        if (res.countryChanged) onNotice(notice);   // смену СТРАНЫ показываем; смену узла — тихо
        return true;
      }
      book.burn(res.node.id);
      return this.onExitFailed();   // пробуем дальше по списку
    },

    /** Отправить данные приложения (только когда туннель поднят). */
    send(bytes) {
      if (!trafficAllowed() || !circuit) throw new Error('туннель не поднят — трафик наружу не выпускаем');
      return circuit.send(bytes);
    },
    recv(bytes) { return circuit ? circuit.recv(bytes) : null; },
  };
}
