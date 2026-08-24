// carrier.js — несущие «Личины» и укладка туннеля в HTTP.
//
// «Тень» даёт нам зашифрованные кадры. «Личина» должна пронести их так, чтобы
// на проводе это выглядело как обычная работа с сайтом. Здесь — две вещи:
//
//  1. Выбор несущей (H2 / H3 / WS) и переключение при деградации.
//  2. Укладка кадров туннеля в тело HTTP-запроса/ответа с длинами-префиксами,
//     поверх которой работает «Дыхание» (переупаковка под естественные размеры).
//
// Никакого магического байта здесь тоже нет: тело POST это просто байты,
// которые для стороннего наблюдателя ничем не отличаются от загрузки файла.

export const CARRIERS = {
  // HTTP/2 внутри TLS — основная. Самый обычный трафик; ClientHello копируем с Chrome.
  h2: { transport: 'tcp', needsUdp: false, note: 'по умолчанию' },
  // HTTP/3 (QUIC) — где не режут UDP. Труднее для DPI, но ломается при блоке UDP.
  h3: { transport: 'udp', needsUdp: true,  note: 'меньше следов, нужен UDP' },
  // WebSocket — проходит через HTTP-прокси корпоративных сетей.
  ws: { transport: 'tcp', needsUdp: false, note: 'через прокси, чуть заметнее' },
};

export const CARRIER_ORDER = ['h2', 'h3', 'ws'];

// ── Кадры в теле HTTP ────────────────────────────────────────────────────────
// [3 байта длины][шифртекст «Тени»]. 3 байта = до 16 МБ на кадр, с запасом.

export function packFrames(cts) {
  let total = 0;
  for (const ct of cts) total += 3 + ct.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const ct of cts) {
    out[o] = (ct.length >>> 16) & 0xff;
    out[o + 1] = (ct.length >>> 8) & 0xff;
    out[o + 2] = ct.length & 0xff;
    out.set(ct, o + 3);
    o += 3 + ct.length;
  }
  return out;
}

/** Разбор потока в кадры. Возвращает {frames, rest} — хвост докопится следующим куском. */
export function readFrames(buf) {
  const frames = [];
  let o = 0;
  while (o + 3 <= buf.length) {
    const len = (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
    if (o + 3 + len > buf.length) break;      // кадр ещё не дошёл целиком
    frames.push(buf.subarray(o + 3, o + 3 + len));
    o += 3 + len;
  }
  return { frames, rest: buf.subarray(o) };
}

/** Сборщик входящего потока: копим байты, отдаём готовые кадры. */
export function makeFrameReader() {
  let buf = new Uint8Array(0);
  return (chunk) => {
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf, 0); merged.set(chunk, buf.length);
    const { frames, rest } = readFrames(merged);
    buf = rest;
    return frames;
  };
}

// ── Выбор несущей и переключение ─────────────────────────────────────────────
/**
 * Держит текущую несущую, помнит что работает в этой сети, переключается при
 * деградации. Логика намеренно похожа на health.js: несущая тоже может «залипнуть».
 *
 * @param {object} p
 * @param {boolean} p.udpBlocked — в этой сети UDP не ходит (тогда H3 пропускаем).
 * @param {string[]} p.order — порядок предпочтения (по умолчанию CARRIER_ORDER).
 */
export function makeCarrierPicker({ udpBlocked = false, order = CARRIER_ORDER } = {}) {
  const usable = order.filter((c) => !(CARRIERS[c].needsUdp && udpBlocked));
  const bad = new Set();            // сбоившие в этой сети
  const good = new Set();           // проверенные рабочими
  let idx = 0;

  const current = () => usable[idx];
  const goTo = (c) => { idx = usable.indexOf(c); };

  return {
    current,
    list: () => usable.slice(),
    /** Несущая работает — запоминаем как проверенную. */
    markGood(c = current()) { good.add(c); bad.delete(c); },
    /** Несущая деградировала (рост потерь, разрывы) — уходим на другую. */
    degrade(c = current()) {
      good.delete(c); bad.add(c);
      // Приоритет: уже проверенная рабочая, на которой мы сейчас не сидим.
      const backToGood = usable.find((x) => good.has(x) && !bad.has(x));
      if (backToGood) { goTo(backToGood); return { switched: true, to: backToGood, reason: 'вернулись на рабочую' }; }
      // Иначе — любая ещё не сбоившая.
      const fresh = usable.find((x) => !bad.has(x));
      if (fresh) { goTo(fresh); return { switched: true, to: fresh, reason: 'пробуем другую несущую' }; }
      // Все сбоили — сбрасываем память и заходим по новой (сеть могла измениться).
      bad.clear(); good.clear(); idx = 0;
      return { switched: true, to: usable[0], reason: 'все несущие сбоили — начинаем заново', reset: true };
    },
    remembered: () => ({ good: [...good], bad: [...bad] }),
  };
}
