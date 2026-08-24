// lichina.mjs — тест несущего слоя: сайт-личина, привратник, укладка кадров.
import { makeSite } from '../src/site.js';
import { makeDoorman } from '../src/lichina.js';
import { makeCarrierPicker, packFrames, readFrames, makeFrameReader, CARRIERS } from '../src/carrier.js';
import { generateNodeKeys, clientHandshake, clientComplete } from '../src/shadow.js';
import { makeReshaper } from '../src/shaping.js';
import { randomBytes } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const utf8 = (s) => new TextEncoder().encode(s);
const str = (u8) => new TextDecoder().decode(u8);

// ── Сайт-личина: это настоящий сайт ──────────────────────────────────────────
const site = makeSite();
const home = site.handle('GET', '/', null);
ok(home.status === 200 && /Последние заметки/.test(home.body), 'главная отдаёт осмысленный контент');
ok(/text\/html/.test(home.handle ? '' : home.headers['content-type']), 'заголовок content-type как у сайта');
ok(site.handle('GET', '/assets/style.css', null).status === 200, 'статика (css) отдаётся');
ok(site.handle('GET', '/p/nginx-tuning', null).status === 200, 'статья открывается');
ok(site.handle('GET', '/p/несуществует', null).status === 404, 'несуществующая страница — честный 404');
const form = site.handle('POST', site.ingestPath, utf8('обычное сообщение из формы'));
ok(form.status === 200 && /Спасибо/.test(form.body), 'форма обратной связи принимает сообщение');

// ── Привратник: турист и зонд получают сайт ──────────────────────────────────
const node = generateNodeKeys();
const seen = new Map();
const door = makeDoorman({ nodePriv: node.privateKey, seen });

ok(door.handle({ method: 'GET', path: '/', body: null }).kind === 'site', 'обычный GET → сайт');
const probe = door.handle({ method: 'POST', path: site.ingestPath, body: randomBytes(200) });
ok(probe.kind === 'site' && /Спасибо/.test(probe.response.body),
  'зонд с мусором в форму получает то же «Спасибо», что и человек');
ok(door.handle({ method: 'POST', path: site.ingestPath, body: randomBytes(10) }).kind === 'site',
  'короткий мусор тоже уводится на сайт (не роняет узел)');
ok(door.handle({ method: 'POST', path: '/other', body: randomBytes(200) }).kind === 'site',
  'POST не на ingest-путь — просто 404 сайта, дверь не трогаем');

// ── Привратник: наш клиент проходит ──────────────────────────────────────────
const c = clientHandshake(node.publicKey);
const opened = door.handle({ method: 'POST', path: site.ingestPath, body: c.message });
ok(opened.kind === 'tunnel', 'клиент с валидным рукопожатием в теле POST → туннель');

const cs = clientComplete(c.state, opened.reply);
const ns = opened.session;
const secret = utf8('GET https://target.example/ HTTP/2');
ok(str(ns.open(cs.seal(secret))) === str(secret), 'после «Личины» «Тень» работает end-to-end');

// Тот же зонд, что подсмотрел тело нашего клиента и переиграл его — отлетает.
ok(door.handle({ method: 'POST', path: site.ingestPath, body: c.message }).kind === 'site',
  'повтор перехваченного тела туннель НЕ открывает (антиповтор) → сайт');

// ── Укладка кадров в тело HTTP ───────────────────────────────────────────────
const cts = [randomBytes(100), randomBytes(1400), randomBytes(37)];
const packed = packFrames(cts);
const { frames, rest } = readFrames(packed);
ok(frames.length === 3 && rest.length === 0, 'кадры упаковались и распарсились без остатка');
ok(frames.every((f, i) => f.length === cts[i].length), 'длины кадров сохранены');

// Частичный приход: половина потока — часть кадров ждёт хвоста
const half = packed.subarray(0, 120);
const r1 = readFrames(half);
ok(r1.frames.length === 1 && r1.rest.length > 0, 'недокачанный кадр остаётся в хвосте, не теряется');

// Потоковый сборщик склеивает куски произвольной нарезки
const reader = makeFrameReader();
let collected = [];
for (let o = 0; o < packed.length; o += 7) collected = collected.concat(reader(packed.subarray(o, o + 7)));
ok(collected.length === 3, 'потоковый сборщик собрал все кадры из мелкой нарезки');

// Кадры едут внутри «Дыхания»: наружу — куски другого размера. Берём поток
// покрупнее (как в реальной сессии), чтобы переупаковка гарантированно сработала.
const bigStream = packFrames(Array.from({ length: 40 }, () => randomBytes(1400)));
const re = makeReshaper('surf');
const wireSizes = [];
for (const ch of re.push(bigStream)) wireSizes.push(ch.length);
for (const ch of re.flush()) wireSizes.push(ch.length);
ok(!wireSizes.includes(bigStream.length), 'на проводе тело нарезано «Дыханием», а не одним куском кадров');
ok(wireSizes.length > 10 && new Set(wireSizes).size > 8, 'кусков много и они разного размера (не однобайтовые, не константа)');

// ── Выбор несущей ────────────────────────────────────────────────────────────
const pick = makeCarrierPicker();
ok(pick.current() === 'h2', 'несущая по умолчанию — H2');
const d1 = pick.degrade();
ok(d1.switched && d1.to === 'h3', 'H2 деградировала — уходим на следующую (H3)');
// Есть проверенная рабочая, на которой мы не сидим → возвращаемся на неё,
// а не тычемся в неизвестную вслепую.
const p2 = makeCarrierPicker();
p2.markGood('ws');                     // WS раньше отработала
const back = p2.degrade('h2');         // текущая H2 сбоит
ok(back.to === 'ws' && /рабочую/.test(back.reason), 'возвращаемся на проверенную рабочую несущую');
// Сеть, где всё по очереди отваливается — в конце сбрасываем память.
const p3 = makeCarrierPicker();
p3.degrade(); p3.degrade();
const r = p3.degrade();
ok(r.reset && r.to === 'h2', 'все несущие сбоили — сброс и заход по новой');

const noUdp = makeCarrierPicker({ udpBlocked: true });
ok(!noUdp.list().includes('h3'), 'при заблокированном UDP несущую H3 не предлагаем');
ok(noUdp.current() === 'h2' && noUdp.list().join() === 'h2,ws', 'остаются H2 и WS');

ok(Object.keys(CARRIERS).length === 3, 'три несущие описаны');

console.log(`\n«Личина»: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
