// health.js — живучесть: следим за узлом и выбираем замену.
//
// Пинга нет намеренно. ICMP режут на половине маршрутов, он ходит мимо
// туннеля (мерил бы не то) и рисует цензору отдельный узор «клиент стучится
// на адрес». Служебных портов статуса на узлах тоже нет — открытый порт это
// подарок сканеру.
//
// Меряем ИЗНУТРИ уже поднятой сессии: пассивно по живому потоку, а в тишине —
// по кадрам-дыханиям (см. shaping.js), которые узел и так шлёт. Ответ формирует
// ВЫХОДНОЙ узел, не приманка: иначе «всё живо» показывало бы первый прыжок при
// мёртвом втором.

/** Пороги. Меняются политикой из реестра — поэтому вынесены отдельно. */
export const LIMITS = {
  missedBeats: 3,          // подряд не отвеченных кадров-дыханий → мёртв
  beatTimeoutMs: 3500,     // сколько ждём ответ на один кадр
  slowRttMs: 2000,         // средняя задержка круга выше — узел «медленный»
  slowWindowMs: 30000,     // окно усреднения
  speedDropRatio: 3,       // обвал скорости во столько раз от своего среднего
  reconnectTries: 1,       // попыток поднять несущую заново перед сменой узла
};

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * Наблюдатель за одной сессией.
 * Кормим его событиями, спрашиваем состояние: 'ok' | 'slow' | 'dead'.
 */
export function makeWatcher(limits = {}) {
  const L = { ...LIMITS, ...limits };
  let missed = 0;
  let carrierDown = false;
  let tries = 0;
  const rtts = [];        // [{t, ms}]
  const rates = [];       // [{t, bps}]

  const trim = (arr, now) => { while (arr.length && now - arr[0].t > L.slowWindowMs) arr.shift(); };

  return {
    /** Пришёл ответ (любой кадр от выходного узла). */
    onReply(rttMs, now = Date.now()) {
      missed = 0; carrierDown = false; tries = 0;
      rtts.push({ t: now, ms: rttMs }); trim(rtts, now);
    },
    /** Кадр-дыхание остался без ответа в отведённое время. */
    onMissedBeat() { missed++; },
    /** Несущая закрылась (TCP/H2 разорвался). */
    onCarrierClose() { carrierDown = true; },
    /** Замер скорости за интервал. */
    onThroughput(bps, now = Date.now()) { rates.push({ t: now, bps }); trim(rates, now); },
    /** Разрешено ли ещё разок поднять несущую, не меняя узел. */
    mayReconnect() { return carrierDown && tries++ < L.reconnectTries; },

    state() {
      if (missed >= L.missedBeats) return 'dead';
      if (carrierDown && tries >= L.reconnectTries) return 'dead';
      const r = avg(rtts.map((x) => x.ms));
      if (rtts.length >= 3 && r > L.slowRttMs) return 'slow';
      if (rates.length >= 4) {
        const mean = avg(rates.map((x) => x.bps));
        const last = rates[rates.length - 1].bps;
        if (mean > 0 && last * L.speedDropRatio < mean) return 'slow';
      }
      return 'ok';
    },
    stats: () => ({ missed, carrierDown, rttAvg: avg(rtts.map((x) => x.ms)), samples: rtts.length }),
  };
}

/**
 * Выбор замены.
 *
 * Порядок строгий:
 *   1) другой узел ТОЙ ЖЕ страны — лучший по рейтингу, из непробованных;
 *   2) соседняя страна из таблицы близости реестра — в её порядке;
 *   3) ничего → null, и клиент остаётся в состоянии «ищу узел».
 *      Молча пускать трафик мимо туннеля нельзя: лучше нет связи, чем голый IP.
 *
 * @param {object} p
 * @param {Array}  p.nodes     [{id, country, rating, alive}]
 * @param {string} p.country   выбранная пользователем страна
 * @param {Set}    p.tried     что уже пробовали в этой сессии
 * @param {object} p.neighbors { FR: ['DE','NL','BE'], ... } — из реестра
 */
export function pickReplacement({ nodes = [], country, tried = new Set(), neighbors = {} } = {}) {
  const usable = (c) => nodes
    .filter((n) => n.country === c && n.alive !== false && !tried.has(n.id))
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));

  const same = usable(country);
  if (same.length) return { node: same[0], countryChanged: false };

  for (const c of neighbors[country] || []) {
    const alt = usable(c);
    if (alt.length) return { node: alt[0], countryChanged: true, from: country };
  }
  // Соседей не задали или они пусты — берём лучшее из живого вообще.
  const rest = nodes
    .filter((n) => n.alive !== false && !tried.has(n.id) && n.country !== country)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  if (rest.length) return { node: rest[0], countryChanged: true, from: country };

  return null;
}

/**
 * Что показать пользователю.
 * Смена узла внутри страны — тихо, только в журнал. Смена СТРАНЫ — уведомлением:
 * человек мог выбрать её осознанно.
 */
export function switchNotice(res) {
  if (!res) return { level: 'error', text: 'Не нашёл доступных узлов — ищу дальше. Трафик в обход туннеля не пускаю.' };
  if (!res.countryChanged) return { level: 'log', text: `Переключился на другой узел (${res.node.id}).` };
  return { level: 'notice', text: `${res.from} недоступна — переключил на ${res.node.country}.`, canChoose: true };
}
