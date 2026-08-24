// features-relogin-test.js — повторный вход восстанавливает личность из
// зашифрованной резервной копии, поэтому входящие сообщения расшифровываются
// (регрессия на баг «invalid tag» после релогина/переустановки).
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));

const PORT = 8993, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true });
line();

const mk = async (n, pass) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(pass); return c; };

const ALICE_PASS = 'alice-pass-123';
const alice = await mk('alice', ALICE_PASS);
const bob = await mk('bob', 'bob-pass-123');

// Боб пишет Алисе (первое сообщение с handshake) — она расшифровывает.
await bob.send('alice:chat.org', 'привет-1');
let inbox = await alice.receive();
assert(inbox.some((m) => m.kind === 'text' && m.text === 'привет-1'), 'Алиса расшифровала первое сообщение');
line();

// Алиса ПЕРЕЗАХОДИТ на «новом устройстве»: свежий клиент + login(пароль).
// Свежий init() сгенерировал новые ключи, но login должен восстановить исходную
// личность из бэкапа — иначе опубликованный bundle не совпадёт с приватными.
const alice2 = await new PrizrakClient({ name: 'alice', userId: 'alice:chat.org', baseUrl: URL }).init();
const freshFp = alice2.identity.fingerprint;
await alice2.login(ALICE_PASS);
assert(freshFp !== alice.identity.fingerprint, 'Свежий init() сгенерировал ДРУГИЕ ключи (как при релогине)');
assert(alice2.identity.fingerprint === alice.identity.fingerprint, 'login() восстановил ИСХОДНУЮ личность из резервной копии');
line();

// Новый контакт (Carol) начинает переписку с восстановленной Алисой.
const carol = await mk('carol', 'carol-pass-123');
await carol.send('alice:chat.org', 'привет-после-релогина');
inbox = await alice2.receive();
assert(inbox.some((m) => m.kind === 'text' && m.text === 'привет-после-релогина'),
  'После релогина Алиса расшифровывает новое сообщение (нет invalid tag)');
// И историческое первое сообщение тоже читается тем же ключом.
assert(inbox.some((m) => m.kind === 'text' && m.text === 'привет-1'),
  'Восстановленная личность читает и историю до релогина');
line();

// Неверный пароль на входе НЕ ломает и НЕ подменяет личность (бэкап не открылся).
const imp = await new PrizrakClient({ name: 'alice', userId: 'alice:chat.org', baseUrl: URL }).init();
let denied = false;
try { await imp.login('totally-wrong-pass'); } catch { denied = true; }
assert(denied, 'Вход с неверным паролем отклонён сервером');
line();

console.log('🎉 Тест повторного входа (резервная копия личности) пройден.');
srv.server.close();
