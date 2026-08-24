// botapi.mjs — боевой тест Bot API: настоящий homeserver + botapi + живой пользователь.
// Проверяем весь цикл: createBot → getMe → юзер пишет боту (E2E) → getUpdates
// (включая подтверждение offset'ом) → бот отвечает sendMessage → юзер получает.
import { createServer } from '../../server/src/server.js';
import { PrizrakClient } from '../../client/src/client.js';
import { startBotApi } from '../src/botapi-server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const dir = mkdtempSync(join(tmpdir(), 'botapi-'));
const HS_PORT = 8993, API_PORT = 8994, DOMAIN = 'x.invalid';
const BASE = `http://127.0.0.1:${HS_PORT}`;

let hs, api;
try {
  hs = await createServer({ domain: DOMAIN, port: HS_PORT, ports: [HS_PORT], storePath: join(dir, 'store.json'),
    resolver: { [DOMAIN]: BASE } });
  api = await startBotApi({ port: API_PORT, dbPath: join(dir, 'botapi.sqlite'), adminToken: 'test-admin', domain: DOMAIN, baseUrl: BASE });
  const A = `http://127.0.0.1:${API_PORT}`;

  // ── Создание бота (BotFather = админ с токеном) ──
  let r = await (await fetch(A + '/admin/createBot', { method: 'POST', headers: { 'x-admin-token': 'WRONG' }, body: '{}' })).json();
  ok(r.ok === false && r.error_code === 401, 'создание бота без админ-токена отклонено');
  r = await (await fetch(A + '/admin/createBot', { method: 'POST', headers: { 'x-admin-token': 'test-admin' },
    body: JSON.stringify({ login: 'echobot', name: 'Эхо-бот' }) })).json();
  ok(r.ok === true && /^\d+:[0-9a-f]{32}$/.test(r.result.token), 'бот создан, токен формата <id>:<секрет>');
  const TOKEN = r.result.token, BOT_ID = r.result.user_id;

  // ── getMe и конверт ошибок ──
  r = await (await fetch(`${A}/bot${TOKEN}/getMe`)).json();
  ok(r.ok === true && r.result.is_bot === true && r.result.username === 'echobot', 'getMe отвечает как Telegram');
  r = await (await fetch(`${A}/botWRONG/getMe`)).json();
  ok(r.ok === false && r.error_code === 401, 'неверный токен → {ok:false, 401}');
  r = await (await fetch(`${A}/bot${TOKEN}/unknownMethod`)).json();
  ok(r.ok === false && r.error_code === 404, 'неизвестный метод → {ok:false, 404}');

  // ── Живой пользователь пишет боту (полный E2E-путь) ──
  const user = await new PrizrakClient({ name: 'fox', userId: `fox:${DOMAIN}`, baseUrl: BASE, deviceId: 'test-dev' }).init();
  await user.register('pw-123-secret');
  await user.publishDevice(); // как настоящий клиент (мультиустройство) — ловит багу «нет сессии»
  await user.send(BOT_ID, 'привет, бот!');
  await sleep(1500); // botapi поллит/слушает — даём доехать

  r = await (await fetch(`${A}/bot${TOKEN}/getUpdates?timeout=5`)).json();
  ok(r.ok === true && r.result.length === 1, 'getUpdates: пришёл один update');
  const u = r.result[0];
  ok(u.message?.text === 'привет, бот!' && u.message?.chat?.type === 'private', 'текст и чат в стиле Telegram');
  ok(u.message?.from?.id === `fox:${DOMAIN}` && u.message?.from?.username === 'fox', 'from: отправитель');

  // ── Подтверждение offset'ом ──
  r = await (await fetch(`${A}/bot${TOKEN}/getUpdates?offset=${u.update_id + 1}`)).json();
  ok(r.ok === true && r.result.length === 0, 'после offset очередь пуста (подтверждение как у Telegram)');

  // ── Бот отвечает; юзер получает E2E-сообщение ──
  r = await (await fetch(`${A}/bot${TOKEN}/sendMessage`, { method: 'POST',
    body: JSON.stringify({ chat_id: `fox:${DOMAIN}`, text: 'эхо: привет!' }) })).json();
  ok(r.ok === true && r.result.text === 'эхо: привет!', 'sendMessage отвечает message-объектом');
  await sleep(800);
  const inbox = await user.receive();
  const got = inbox.find((m) => m.kind === 'text' && m.from === BOT_ID);
  ok(!!got && got.text === 'эхо: привет!', 'пользователь получил ответ бота (расшифровался)');

  // ── sendMessage без параметров ──
  r = await (await fetch(`${A}/bot${TOKEN}/sendMessage`, { method: 'POST', body: '{}' })).json();
  ok(r.ok === false && r.error_code === 400, 'sendMessage без chat_id/text → 400');

  // ── 👻 PrizrakFather: создание бота диалогом в чате ──
  const FATHER = `prizrakfather:${DOMAIN}`;
  const askFather = async (text) => { await user.send(FATHER, text); await sleep(1200); const inb = await user.receive(); return inb.filter((m) => m.kind === 'text' && m.from === FATHER).map((m) => m.text).join('\n'); };
  let a = await askFather('/start');
  ok(a.includes('/newbot'), 'PrizrakFather отвечает справкой');
  a = await askFather('/newbot');
  ok(a.includes('имя'), 'PrizrakFather спрашивает имя');
  a = await askFather('Новостной бот');
  ok(a.toLowerCase().includes('логин'), 'PrizrakFather спрашивает логин');
  a = await askFather('news_bot');
  const tokM = a.match(/(\d+:[0-9a-f]{32})/);
  ok(!!tokM, 'PrizrakFather выдал токен нового бота');
  const TOKEN2 = tokM ? tokM[1] : '';
  a = await askFather('/mybots');
  ok(a.includes('news_bot'), '/mybots показывает созданного бота');

  // ── Пост в группу через API (первая задача) ──
  const g = await user.createGroup('Новости');
  await user.invite(g.roomId || g.id, `news_bot:${DOMAIN}`);
  const roomId = g.roomId || g.id;
  r = await (await fetch(`${A}/bot${TOKEN2}/sendMessage`, { method: 'POST',
    body: JSON.stringify({ chat_id: roomId, text: 'Первый пост из API!' }) })).json();
  ok(r.ok === true && r.result.chat.type === 'group', 'бот запостил в группу через API');
  await sleep(900);
  const inbox2 = await user.receive();
  const gotRoom = inbox2.find((m) => m.kind === 'text' && m.roomId === roomId);
  ok(!!gotRoom && gotRoom.text === 'Первый пост из API!', 'участник группы получил пост бота');

  // ── /revoke: старый токен отзывается ──
  a = await askFather('/revoke news_bot');
  const tok3 = (a.match(/(\d+:[0-9a-f]{32})/) || [])[1];
  ok(!!tok3 && tok3 !== TOKEN2, '/revoke выдал новый токен');
  r = await (await fetch(`${A}/bot${TOKEN2}/getMe`)).json();
  ok(r.ok === false && r.error_code === 401, 'старый токен больше не работает');
  r = await (await fetch(`${A}/bot${tok3}/getMe`)).json();
  ok(r.ok === true && r.result.username === 'news_bot', 'новый токен работает');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.message);
} finally {
  try { api?.server?.close(); } catch {}
  try { for (const cl of api?.clients?.values() || []) cl.disconnectRealtime?.(); } catch {}
  try { hs?.close?.(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(`\nBot API: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
