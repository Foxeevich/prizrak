// shadow.mjs — тест ядра протокола «Тень» и слоя формы трафика.
import {
  generateNodeKeys, clientHandshake, nodeHandshake, clientComplete,
  FRESH_WINDOW_SEC, REKEY_BYTES,
} from '../src/shadow.js';
import { chunkSizes, makeReshaper, padLen, pickProfile, PROFILES } from '../src/shaping.js';
import { randomBytes, bytesToHex } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const utf8 = (s) => new TextEncoder().encode(s);
const str = (u8) => new TextDecoder().decode(u8);
// randomBytes отдаёт максимум 64 КБ за вызов — склеиваем для больших объёмов.
const bigRandom = (n) => { const out = new Uint8Array(n); for (let o = 0; o < n; o += 65536) out.set(randomBytes(Math.min(65536, n - o)), o); return out; };

// ── Рукопожатие ──────────────────────────────────────────────────────────────
const node = generateNodeKeys();
ok(node.publicKey.length === 64 && node.privateKey.length === 64, 'ключи узла сгенерированы');

const seen = new Map();
const c = clientHandshake(node.publicKey);
ok(c.message.length === 32 + 24 + 16, 'первое сообщение = эфемер + шифртекст, без магических байтов');

const n = nodeHandshake(node.privateKey, c.message, { seen });
ok(n.ok === true, 'узел принял рукопожатие');

const cs = clientComplete(c.state, n.reply);
const ns = n.session;

// ── Поток в обе стороны ──────────────────────────────────────────────────────
const msg = utf8('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n');
ok(str(ns.open(cs.seal(msg))) === str(msg), 'клиент → узел: расшифровалось');
const back = utf8('HTTP/1.1 200 OK');
ok(str(cs.open(ns.seal(back))) === str(back), 'узел → клиент: расшифровалось');

// Порядок и уникальность nonce: подряд много кадров
let okSeq = true;
for (let i = 0; i < 500; i++) {
  const p = utf8('кадр-' + i);
  if (str(ns.open(cs.seal(p))) !== 'кадр-' + i) { okSeq = false; break; }
}
ok(okSeq, '500 кадров подряд — счётчик nonce не сбивается');

// Разные ключи по направлениям: шифртекст клиента узел не должен «открыть» своим исходящим
let crossFailed = false;
try { cs.open(cs.seal(utf8('x'))); } catch { crossFailed = true; }
ok(crossFailed, 'ключи разные в каждую сторону (свой шифртекст не открывается)');

// ── Защита от повтора ────────────────────────────────────────────────────────
const replay = nodeHandshake(node.privateKey, c.message, { seen });
ok(!replay.ok && /повтор/.test(replay.reason), 'повтор записанного хендшейка отвергнут');

const stale = clientHandshake(node.publicKey, { nowSec: Math.floor(Date.now() / 1000) - FRESH_WINDOW_SEC - 30 });
const staleRes = nodeHandshake(node.privateKey, stale.message, { seen: new Map() });
ok(!staleRes.ok && /несвеж/.test(staleRes.reason), 'старый хендшейк (вне окна свежести) отвергнут');

// ── Чужой/подделанный клиент ─────────────────────────────────────────────────
const other = generateNodeKeys();
const wrong = clientHandshake(other.publicKey); // клиент шёл к другому узлу
ok(!nodeHandshake(node.privateKey, wrong.message, { seen: new Map() }).ok, 'клиент с чужим ключом узла не проходит');

const tampered = new Uint8Array(c.message); tampered[40] ^= 0xff;
ok(!nodeHandshake(node.privateKey, tampered, { seen: new Map() }).ok, 'подменённый байт ломает рукопожатие');

ok(!nodeHandshake(node.privateKey, randomBytes(80), { seen: new Map() }).ok, 'случайный мусор (зонд цензора) не проходит');
ok(!nodeHandshake(node.privateKey, randomBytes(10), { seen: new Map() }).ok, 'короткий мусор не роняет узел');

// ── Прямая секретность и перемотка ключей ────────────────────────────────────
const c2 = clientHandshake(node.publicKey);
const n2 = nodeHandshake(node.privateKey, c2.message, { seen: new Map() });
const cs2 = clientComplete(c2.state, n2.reply);
let leak = false;
try { n2.session.open(cs.seal(utf8('секрет'))); leak = true; } catch {}
ok(!leak, 'новая сессия не расшифровывает трафик прежней (эфемерные ключи)');

// Перемотка по объёму: гоним больше порога и проверяем, что связь не рвётся
const big = bigRandom(1024 * 1024);
let rekeyOk = true;
for (let i = 0; i < Math.ceil(REKEY_BYTES / big.length) + 3; i++) {
  try { if (n2.session.open(cs2.seal(big)).length !== big.length) { rekeyOk = false; break; } }
  catch { rekeyOk = false; break; }
}
const st = cs2.stats();
ok(rekeyOk, 'поток пережил перемотку ключей (>64 МБ) без разрыва');
ok(st.outEpoch >= 1, 'ключи действительно перематывались (эпоха выросла)');

// ── Форма трафика ────────────────────────────────────────────────────────────
const sizes = chunkSizes(200 * 1024, 'surf');
ok(sizes.reduce((a, b) => a + b, 0) === 200 * 1024, 'нарезка не теряет и не добавляет байт');
ok(new Set(sizes).size > 20, 'размеры кусков разные (не ровные 1400)');
ok(sizes.some((s) => s > 1400), 'встречаются крупные куски, как у настоящего сайта');

// Главная проверка: узор TLS-in-TLS не проступает.
// Подаём поток «внутреннего TLS» с характерными границами 16384 и смотрим,
// что на выходе таких границ нет.
const re = makeReshaper('surf');
const outSizes = [];
for (let i = 0; i < 40; i++) {
  const rec = randomBytes(i % 5 === 0 ? 512 : 16384); // типичные размеры TLS-записей
  for (const c3 of re.push(rec)) outSizes.push(c3.length);
}
for (const c3 of re.flush()) outSizes.push(c3.length);
ok(!outSizes.includes(16384), 'границы внутренних TLS-записей НЕ проступают наружу');
ok(outSizes.length > 40, 'поток переупакован в куски другого размера');

// Переупаковка не теряет данные
const re2 = makeReshaper('video');
const src = bigRandom(300 * 1024);
let got = 0;
for (let off = 0; off < src.length; off += 7000) {
  for (const c4 of re2.push(src.subarray(off, off + 7000))) got += c4.length;
}
for (const c4 of re2.flush()) got += c4.length;
ok(got === src.length, 'переупаковка сохраняет все байты');

ok(padLen(50, 'surf') > 0, 'мелкий кадр добивается паддингом');
ok(pickProfile({ bytesPerSec: 500 * 1024, framesPerSec: 60 }) === 'video', 'профиль «видео» выбирается по нагрузке');
ok(pickProfile({ bytesPerSec: 100, framesPerSec: 0 }) === 'quiet', 'профиль «тихий фон» при простое');
ok(Object.keys(PROFILES).length === 3, 'три профиля формы трафика');

console.log(`\n«Тень»: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
