// breath.mjs — тест «Дыхания» в движении: рамки, форма, keepalive, автопрофиль.
import { makeBreath, packWire, readWire, WT } from '../src/breath.js';
import { generateNodeKeys, clientHandshake, nodeHandshake, clientComplete } from '../src/shadow.js';
import { randomBytes } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const utf8 = (s) => new TextEncoder().encode(s);
const str = (u8) => new TextDecoder().decode(u8);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── Служебная рамка ───────────────────────────────────────────────────────────
const w = packWire(WT.DATA, utf8('привет'));
const { frames, rest } = readWire(w);
ok(frames.length === 1 && frames[0].type === WT.DATA && str(frames[0].payload) === 'привет', 'рамка DATA упаковалась и распарсилась');
ok(rest.length === 0, 'хвоста нет');
const two = new Uint8Array([...packWire(WT.DATA, utf8('a')), ...packWire(WT.PAD, new Uint8Array(3))]);
const r2 = readWire(two);
ok(r2.frames.length === 2 && r2.frames[1].type === WT.PAD, 'две рамки подряд: DATA + PAD');

// ── Форма: границы кадров наружу не проступают ────────────────────────────────
let t = 1_000_000;
const tx = makeBreath({ profile: 'surf', now: () => t });
const rxB = makeBreath({ now: () => t });

// Гоним характерные «TLS-записи» по 16384 — на проводе таких кусков быть не должно.
const wireSizes = [];
for (let i = 0; i < 30; i++) {
  const frame = randomBytes(i % 4 === 0 ? 512 : 16384);
  for (const chunk of tx.send(frame)) wireSizes.push(chunk.length);
}
ok(!wireSizes.includes(16384), 'на проводе нет кусков ровно 16384 — узор TLS-in-TLS сломан');
ok(new Set(wireSizes).size > 10, 'размеры кусков разные, а не константа');

// ── Целостность: DATA проходит насквозь, PAD/KEEP выброшены ────────────────────
const tx2 = makeBreath({ profile: 'surf', now: () => t });
const rx2 = makeBreath({ now: () => t });
const originals = [utf8('первый'), randomBytes(1400), utf8('третий-кадр')];
let wire = [];
for (const o of originals) wire = wire.concat(tx2.send(o));
wire = wire.concat(tx2.flush());   // очередь опустела — досылаем хвост
// Провод перемешивает нарезку: склеим всё и подадим приёмнику кусками по 100 байт.
const flat = (() => { let n = 0; for (const c of wire) n += c.length; const a = new Uint8Array(n); let o = 0; for (const c of wire) { a.set(c, o); o += c.length; } return a; })();
let got = [];
for (let o = 0; o < flat.length; o += 100) got = got.concat(rx2.recv(flat.subarray(o, o + 100)));
ok(got.length === originals.length, 'приёмник собрал ровно столько DATA-кадров, сколько отправлено (PAD выброшены)');
ok(originals.every((o, i) => eq(o, got[i])), 'каждый DATA-кадр дошёл байт в байт');

// ── Keepalive: в тишине дышим, но не раньше времени ───────────────────────────
const tx3 = makeBreath({ profile: 'quiet', now: () => t });
ok(tx3.tick().length === 0, 'сразу после старта KEEP не шлём');
t += 5000;
ok(tx3.tick().length === 0, 'через 5 с (в профиле «тихо» окно больше) ещё молчим');
t += 60000;
const beat = tx3.tick();
ok(beat.length > 0, 'после долгой паузы шлём поддерживающий кадр');
// KEEP на приёмнике не превращается в данные
const rx3 = makeBreath({ now: () => t });
let keepData = [];
for (const c of beat) keepData = keepData.concat(rx3.recv(c));
ok(keepData.length === 0, 'KEEP-кадр наверх как данные НЕ отдаётся');

// ── Автопрофиль по нагрузке ───────────────────────────────────────────────────
let tt = 2_000_000;
const tx4 = makeBreath({ profile: 'surf', now: () => tt });
ok(tx4.profile() === 'surf', 'старт в профиле «сёрфинг»');
// Заваливаем крупным потоком больше секунды → должен переключиться на «видео».
for (let i = 0; i < 60; i++) tx4.send(randomBytes(16 * 1024));
tt += 1100;
tx4.send(randomBytes(16 * 1024)); // этот send закрывает окно и пересчитывает профиль
ok(tx4.profile() === 'video', 'под крупным потоком профиль сам стал «видео»');

// ── Джиттер ───────────────────────────────────────────────────────────────────
const d = tx.nextDelayMs();
ok(d >= 0 && d < 100, 'джиттер даёт небольшую случайную паузу');

// ── Интеграция с «Тенью»: форма поверх реального шифра ─────────────────────────
const node = generateNodeKeys();
const c = clientHandshake(node.publicKey);
const n = nodeHandshake(node.privateKey, c.message, { seen: new Map() });
const cs = clientComplete(c.state, n.reply), ns = n.session;
const bTx = makeBreath({ now: () => t }), bRx = makeBreath({ now: () => t });
const secret = utf8('GET https://example/ HTTP/2');
const onWire = [...bTx.send(cs.seal(secret)), ...bTx.flush()];
let sealedBack = [];
for (const chunk of onWire) sealedBack = sealedBack.concat(bRx.recv(chunk));
ok(sealedBack.length === 1 && str(ns.open(sealedBack[0])) === str(secret),
  'кадр «Тени» пережил «Дыхание» и расшифровался у получателя');

console.log(`\n«Дыхание» (в движении): ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
