// wire.js — перенос «Тени» по реальному сокету поверх «Дыхания».
//
// Соединяет тестируемые модули (shadow/breath) с настоящим net/tls-сокетом:
//   • исходящие байты (рукопожатие или зашифрованный кадр) заворачиваются
//     «Дыханием» (рамки + нарезка под естественный размер + keepalive в тишине);
//   • входящие байты собираются обратно в кадры и отдаются наверх.
//
// На проводе — ни одного магического байта: только поток, неотличимый по форме
// от обычной веб-сессии. Интерпретацию (рукопожатие vs зашифрованный кадр)
// решает вызывающий по фазе соединения, не сам wire.

import { makeBreath } from './breath.js';

/**
 * Обернуть сокет. onFrame(bytes) вызывается на каждый пришедший кадр.
 * Возвращает { send(bytes), close() }.
 */
export function attachBreath(socket, { onFrame, onClose, onDrain, profile = 'surf' } = {}) {
  const tx = makeBreath({ profile });
  const rx = makeBreath({});
  let writable = true;   // ложно, когда буфер сокета переполнен (нужен backpressure)
  const write = (chunk) => {
    try { const ok = socket.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)); if (ok === false) writable = false; } catch {}
  };
  socket.on('drain', () => { writable = true; try { onDrain && onDrain(); } catch {} });

  // Keepalive: в тишине «дышим», чтобы долгая сессия не висела молча.
  const ka = setInterval(() => { for (const c of tx.tick()) write(c); }, 5000);
  if (ka.unref) ka.unref();

  socket.on('data', (buf) => {
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    for (const f of rx.recv(u8)) { try { onFrame && onFrame(f); } catch {} }
  });
  const done = () => { clearInterval(ka); onClose && onClose(); };
  socket.on('close', done);
  socket.on('error', () => {});

  return {
    /** Отправить кадр (рукопожатие или зашифрованный) — уйдёт в форме «Дыхания».
     *  Возвращает false, если сокет-буфер переполнен (сигнал притормозить аплоад). */
    send(bytes) { for (const c of tx.send(bytes)) write(c); for (const c of tx.flush()) write(c); return writable; },
    writable: () => writable,
    close() { try { socket.end(); } catch {} clearInterval(ka); },
  };
}

/** Похоже ли начало потока на HTTP-запрос (зонд/браузер), а не на наш кадр. */
export function looksHttp(firstByte) {
  // Наши кадры «Дыхания» начинаются с типа 0/1/2. HTTP-глаголы — с заглавной буквы.
  return firstByte >= 0x41 && firstByte <= 0x5a;
}
