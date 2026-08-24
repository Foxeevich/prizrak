// shaping.js — «Дыхание»: форма трафика на проводе.
//
// Зачем: современный DPI ловит не только сигнатуры, но и СТАТИСТИКУ — размеры
// пакетов, их ритм, соотношение направлений. Два известных провала:
//
//  1. TLS-in-TLS. Если внутри нашего TLS едет ещё один TLS, границы внутренних
//     записей проступают наружу характерным узором (записи по 16 КБ + мелкие
//     хендшейковые). Именно так сейчас детектируют VLESS/Trojan/Reality.
//     Лечение: РЕЖЕМ И СКЛЕИВАЕМ поток так, чтобы наши кадры не совпадали с
//     внутренними границами.
//
//  2. Ровные размеры. Поток из одинаковых кусков по 1400 байт — сам по себе
//     отпечаток. Лечение: размеры берём из распределения, похожего на обычный
//     сайт (много мелких, изредка крупные).
//
// Профили подбираются под характер нагрузки: сёрфинг, видео, тихий фон.

const rnd = (n) => Math.floor(Math.random() * n);

export const PROFILES = {
  // Сёрфинг: много мелких запросов, редкие крупные ответы (картинки, скрипты).
  surf:  { min: 120,  max: 1400, big: 0.12, bigMax: 8 * 1024,  jitterMs: [0, 12], idleMs: [8000, 20000] },
  // Видео: ровный поток крупных кусков с редкими управляющими.
  video: { min: 900,  max: 1400, big: 0.55, bigMax: 16 * 1024, jitterMs: [0, 4],  idleMs: [15000, 30000] },
  // Тихий фон: сессия открыта, но почти молчит — изредка «дышим».
  quiet: { min: 60,   max: 400,  big: 0.02, bigMax: 2 * 1024,  jitterMs: [0, 40], idleMs: [20000, 45000] },
};

/**
 * Разрезать поток на куски «естественного» размера.
 * Ключевая деталь: границы кусков НЕ связаны с границами входных данных —
 * поэтому внутренний TLS наружу не проступает.
 */
export function chunkSizes(totalLen, profile = 'surf') {
  const out = [];
  let left = totalLen;
  while (left > 0) {
    const take = Math.min(left, nextChunk(profile));
    out.push(take);
    left -= take;
  }
  return out;
}

/**
 * Один «естественный» размер куска — не привязан к остатку данных.
 * Нужен переупаковщику: брать размер через chunkSizes(1,…) НЕЛЬЗЯ — там он
 * обрезается до 1 байта (min(1, size)), и поток вырождается в однобайтовые
 * куски, что само по себе отпечаток.
 */
export function nextChunk(profile = 'surf') {
  const p = PROFILES[profile] || PROFILES.surf;
  const big = Math.random() < p.big;
  return big
    ? p.max + rnd(Math.max(1, p.bigMax - p.max))
    : p.min + rnd(Math.max(1, p.max - p.min));
}

/** Сколько мусора добавить к кадру, чтобы размер не выдавал полезную длину. */
export function padLen(payloadLen, profile = 'surf') {
  const p = PROFILES[profile] || PROFILES.surf;
  if (payloadLen >= p.max) return rnd(64);           // и так крупный — хватит мелкого хвоста
  const target = p.min + rnd(Math.max(1, p.max - p.min));
  return Math.max(0, target - payloadLen) + rnd(32);
}

/** Пауза перед отправкой — убирает машинную регулярность. */
export function jitterMs(profile = 'surf') {
  const [a, b] = (PROFILES[profile] || PROFILES.surf).jitterMs;
  return a + rnd(Math.max(1, b - a));
}

/** Когда слать поддерживающий кадр, если данных нет (сессия не должна «висеть молча»). */
export function idleMs(profile = 'surf') {
  const [a, b] = (PROFILES[profile] || PROFILES.surf).idleMs;
  return a + rnd(Math.max(1, b - a));
}

/**
 * Автовыбор профиля по недавней нагрузке.
 * Много байт ровным потоком → видео; редкие мелкие → сёрфинг; тишина → фон.
 */
export function pickProfile({ bytesPerSec = 0, framesPerSec = 0 } = {}) {
  if (bytesPerSec > 200 * 1024 && framesPerSec > 20) return 'video';
  if (bytesPerSec < 2 * 1024 && framesPerSec < 2) return 'quiet';
  return 'surf';
}

/**
 * Переупаковщик потока: принимает произвольные куски, отдаёт куски «правильных»
 * размеров. Именно он ломает узор TLS-in-TLS.
 */
export function makeReshaper(profile = 'surf') {
  let buf = new Uint8Array(0);
  let want = nextChunk(profile);
  return {
    /** Скормить данные, забрать готовые куски. */
    push(chunk) {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0); merged.set(chunk, buf.length);
      buf = merged;
      const out = [];
      while (buf.length >= want) {
        out.push(buf.subarray(0, want));
        buf = buf.subarray(want);
        want = nextChunk(profile);
      }
      return out;
    },
    /** Дослать остаток (например, перед закрытием). */
    flush() { const rest = buf; buf = new Uint8Array(0); return rest.length ? [rest] : []; },
    pending: () => buf.length,
    setProfile(p) { profile = p; },
  };
}
