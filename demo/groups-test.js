// groups-test.js — проверка v1.1: регистрация с тумблером, группы, каналы, E2E.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

function assert(c, m) { if (!c) { console.error('❌ FAIL:', m); process.exit(1); } console.log('✅', m); }
const line = () => console.log('─'.repeat(64));

const PORT = 8901, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });

// Сервер с ВКЛючённой регистрацией и первым админом «admin».
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true, admin: 'admin' });
line();

// ── Регистрация ────────────────────────────────────────────────────────────
const admin = await new PrizrakClient({ name: 'Admin', userId: 'admin:chat.org', baseUrl: URL }).init();
const alice = await new PrizrakClient({ name: 'Alice', userId: 'alice:chat.org', baseUrl: URL }).init();
const bob = await new PrizrakClient({ name: 'Bob', userId: 'bob:chat.org', baseUrl: URL }).init();
const carol = await new PrizrakClient({ name: 'Carol', userId: 'carol:chat.org', baseUrl: URL }).init();

const a = await admin.register('admin-pass-123');
assert(a.isAdmin === true, 'admin получил флаг администратора');
await alice.register('alice-pass-123');
await bob.register('bob-pass-123');
await carol.register('carol-pass-123');
assert(alice.token && bob.token, 'Alice и Bob зарегистрированы, получили токены');

// Логин повторно тем же паролем
const relog = await new PrizrakClient({ name: 'Alice', userId: 'alice:chat.org', baseUrl: URL }).init();
const l = await relog.login('alice-pass-123');
assert(l.ok, 'Повторный логин Alice по паролю работает');

// Неверный пароль отвергается
try { await new PrizrakClient({ name: 'X', userId: 'alice:chat.org', baseUrl: URL }).init().then((c) => c.login('wrong')); assert(false, 'неверный пароль не должен пускать'); }
catch (e) { assert(/Неверн/i.test(e.message), 'Неверный пароль отвергнут'); }

// Занятое имя
try { await new PrizrakClient({ name: 'Y', userId: 'alice:chat.org', baseUrl: URL }).init().then((c) => c.register('another-pass')); assert(false, 'занятое имя не должно регистрироваться'); }
catch (e) { assert(/занят/i.test(e.message), 'Занятое имя отвергнуто'); }

// Плохой формат id (со «собакой» вместо двоеточия)
try { await new PrizrakClient({ name: 'Z', userId: 'zoe@chat.org', baseUrl: URL }).init().then((c) => c.register('pass1234')); assert(false, 'формат @ не должен приниматься'); }
catch (e) { assert(/user:domain/i.test(e.message), 'Формат user:domain обязателен (не @)'); }
line();

// ── Группа: Alice создаёт, зовёт Bob и Carol, все переписываются E2E ─────────
const group = await alice.createGroup('Друзья');
assert(group.type === 'group', 'Группа создана');
await alice.invite(group.id, 'bob:chat.org');
await alice.invite(group.id, 'carol:chat.org');

await alice.sendToRoom(group.id, 'Привет, это зашифрованная группа!');
let bi = await bob.receive(); let ci = await carol.receive();
assert(bi.find((m) => m.text === 'Привет, это зашифрованная группа!' && m.roomId === group.id), 'Bob получил групповое сообщение (E2E)');
assert(ci.find((m) => m.text === 'Привет, это зашифрованная группа!'), 'Carol получила групповое сообщение (E2E)');

await bob.sendToRoom(group.id, 'И тебе привет, Alice и Carol!');
let ai = await alice.receive(); ci = await carol.receive();
assert(ai.find((m) => m.text === 'И тебе привет, Alice и Carol!'), 'Alice получила ответ Bob в группе');
assert(ci.find((m) => m.text === 'И тебе привет, Alice и Carol!'), 'Carol получила ответ Bob в группе');
line();

// ── Канал: admin вещает, подписчики читают, посторонний писать не может ──────
const channel = await admin.createChannel('Объявления');
assert(channel.type === 'channel', 'Канал создан');
await admin.invite(channel.id, 'alice:chat.org'); // добавляем подписчиков
await admin.invite(channel.id, 'bob:chat.org');
await admin.sendToRoom(channel.id, '📢 Первое объявление канала'); // канал: общий ключ + история
const ah = await alice.getChannelHistory(channel.id); const bh = await bob.getChannelHistory(channel.id);
assert(ah.some((m) => m.text === '📢 Первое объявление канала'), 'Alice-подписчик получила пост канала (история)');
assert(bh.some((m) => m.text === '📢 Первое объявление канала'), 'Bob-подписчик получил пост канала (история)');

// Подписчик НЕ может писать в канал
let denied = false;
try { await alice.sendToRoom(channel.id, 'я не должна мочь писать'); } catch (e) { denied = /нельзя писать/i.test(e.message); }
assert(denied, 'Подписчику канала запрещено вещать (только админ)');
line();

// ── Тумблер регистрации: выключаем и проверяем отказ ───────────────────────
srv.cfg.registrationEnabled = false;
let regBlocked = false;
try { await new PrizrakClient({ name: 'Late', userId: 'late:chat.org', baseUrl: URL }).init().then((c) => c.register('late-pass-123')); }
catch (e) { regBlocked = /отключена/i.test(e.message); }
assert(regBlocked, 'При выключенном тумблере регистрация запрещена');

// Сервер видит только шифртекст в комнатных конвертах
const store = srv.store;
const anyEnc = Object.values(store.data.history).flat().some((e) => e.envelope?.payload?.ciphertext);
assert(anyEnc, 'Комнатные сообщения лежат на сервере как шифртекст');

line();
console.log('🎉 Все тесты v1.1 (регистрация, группы, каналы, E2E) пройдены.');
srv.server.close();
