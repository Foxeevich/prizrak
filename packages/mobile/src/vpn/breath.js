// breath.js — «Дыхание» в движении: форма трафика поверх живого транспорта.
//
// В shaping.js лежат кирпичи (профили, нарезка, паддинг, джиттер). Здесь они
// собраны в насос, через который проходит весь поток сессии:
//
//   • кадры «Тени» заворачиваются в служебную рамку с типом (DATA/PAD/KEEP),
//   • поток режется «Дыханием» на куски естественного размера — границы кадров
//     наружу НЕ проступают (это и есть защита от TLS-in-TLS),
//   • в паузах насос сам «дышит»: шлёт KEEP-кадры, чтобы сессия не висела молча
//     (молчащий часами TLS — сам по себе подозрителен),
//   • профиль (сёрфинг/видео/тихий фон) выбирается по нагрузке НА ЛЕТУ.
//
// Приёмник разбирает рамки обратно: DATA отдаёт наверх, PAD/KEEP выбрасывает.
// Паддинг обратим именно потому, что это отдельный тип кадра, а не «мусор в
// хвосте» — иначе он ломал бы разбор следующих кадров.

import { padLen, jitterMs, idleMs, pickProfile, makeReshaper } from './shaping.js';

// Типы служебной рамки. 1 байт типа + 3 байта длины + тело.
export const WT = { DATA: 0, PAD: 1, KEEP: 2 };

export function packWire(type, payload = new Uint8Array(0)) {
  const out = new Uint8Array(4 + payload.length);
  out[0] = type;
  out[1] = (payload.length >>> 16) & 0xff;
  out[2] = (payload.length >>> 8) & 0xff;
  out[3] = payload.length & 0xff;
  out.set(payload, 4);
  return out;
}

/** Разобрать поток в рамки. Хвост недокачанной рамки — в rest. */
export function readWire(buf) {
  const frames = [];
  let o = 0;
  while (o + 4 <= buf.length) {
    const len = (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];
    if (o + 4 + len > buf.length) break;
    frames.push({ type: buf[o], payload: buf.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
  }
  return { frames, rest: buf.subarray(o) };
}

const rnd = (n) => Math.floor(Math.random() * n);

/**
 * Насос «Дыхания» для одной стороны сессии.
 *
 * @param {object} p
 * @param {string} p.profile — стартовый профиль ('surf' по умолчанию).
 * @param {boolean} p.autoProfile — переключать профиль по нагрузке (по умолчанию да).
 * @param {function} p.now — источник времени в мс (для тестов).
 */
export function makeBreath({ profile = 'surf', autoProfile = true, now } = {}) {
  const clock = () => (now ? now() : Date.now());
  let prof = profile;
  let reshaper = makeReshaper(prof);
  let lastSendAt = clock();
  let nextIdleAt = lastSendAt + idleMs(prof);

  // Счётчик нагрузки за скользящую секунду — для автопрофиля.
  let winStart = clock(), winBytes = 0, winFrames = 0;
  const meter = (bytes) => {
    winBytes += bytes; winFrames += 1;
    const t = clock();
    if (t - winStart >= 1000) {
      if (autoProfile) {
        const want = pickProfile({ bytesPerSec: winBytes, framesPerSec: winFrames });
        if (want !== prof) { prof = want; reshaper.setProfile(prof); }
      }
      winStart = t; winBytes = 0; winFrames = 0;
    }
  };

  // Собрать рамки → нарезать «Дыханием» → отдать куски для провода.
  const emit = (wireFrames) => {
    const out = [];
    for (const wf of wireFrames) for (const chunk of reshaper.push(wf)) out.push(chunk);
    return out;
  };

  const rx = { buf: new Uint8Array(0) };

  return {
    profile: () => prof,

    /**
     * Отправить кадр «Тени». Возвращает куски для провода (уже перемешанной формы).
     * Мелкий кадр добивается PAD'ом, чтобы объём не выдавал точную длину полезного.
     */
    send(sealedFrame) {
      meter(sealedFrame.length);
      lastSendAt = clock();
      nextIdleAt = lastSendAt + idleMs(prof);
      const frames = [packWire(WT.DATA, sealedFrame)];
      const pad = padLen(sealedFrame.length, prof);
      if (pad > 0) frames.push(packWire(WT.PAD, new Uint8Array(pad)));
      return emit(frames);
    },

    /**
     * Тик времени. Если давно молчим — «дышим» KEEP-кадром, чтобы сессия
     * выглядела как открытая вкладка, а не мёртвый коннект. Возвращает куски
     * для провода или пустой массив.
     */
    tick() {
      const t = clock();
      if (t < nextIdleAt) return [];
      lastSendAt = t;
      nextIdleAt = t + idleMs(prof);
      // KEEP несёт немного случайного «шума», чтобы размер не был константой.
      // Дышим — значит кадр должен реально уйти на провод, а не осесть в буфере,
      // поэтому за emit сразу flush.
      return [...emit([packWire(WT.KEEP, new Uint8Array(rnd(48)))]), ...reshaper.flush()];
    },

    /**
     * Дослать остаток из переупаковщика. Зовётся, когда очередь отправки
     * опустела (аналог «данных больше нет прямо сейчас»): хвост нельзя держать
     * вечно, иначе последний кадр не доедет. Отдельные flush'и формы не выдают —
     * границы всё равно плавают от нарезки.
     */
    flush() { return reshaper.flush(); },

    /** Пауза перед отправкой — убирает машинную регулярность. */
    nextDelayMs: () => jitterMs(prof),

    /**
     * Пришли байты с провода. Возвращает массив кадров «Тени» (только DATA),
     * PAD и KEEP молча выброшены.
     */
    recv(wireChunk) {
      const merged = new Uint8Array(rx.buf.length + wireChunk.length);
      merged.set(rx.buf, 0); merged.set(wireChunk, rx.buf.length);
      const { frames, rest } = readWire(merged);
      rx.buf = rest;
      const out = [];
      for (const f of frames) if (f.type === WT.DATA) out.push(f.payload);
      return out;
    },

    /** Явно сменить профиль (например, по подсказке приложения). */
    setProfile(p) { prof = p; reshaper.setProfile(p); },
  };
}
