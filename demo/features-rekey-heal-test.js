// features-rekey-heal-test.js — самолечение E2E-сессии при СМЕНЕ ключей
// собеседника (переустановка/миграция). Без него после смены ключей чат
// навсегда ловил «invalid tag».
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const textOf = (inbox, t) => inbox.some((m) => m.kind === 'text' && m.text === t);

const PORT = 8992, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true });
line();

const mk = async (n, pass) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(pass); return c; };

const alice = await mk('alice', 'alice-pass-123');
const bob = await mk('bob', 'bob-pass-123');

// Обычная переписка — сессия установлена в обе стороны.
await bob.send('alice:chat.org', 'm1');
assert(textOf(await alice.receive(), 'm1'), 'Алиса расшифровала m1 (сессия установлена)');
line();

// Алиса «переустановилась без бэкапа»: на сервере теперь ДРУГИЕ её ключи.
// Симулируем миграцию/re-key: удаляем бэкап и логинимся свежим клиентом.
srv.store.data.users['alice:chat.org'].keyBackup = null;
const alice2 = await new PrizrakClient({ name: 'alice', userId: 'alice:chat.org', baseUrl: URL }).init();
await alice2.login('alice-pass-123'); // легаси-путь: сервер принимает НОВЫЕ ключи alice2
assert(alice2.identity.fingerprint !== alice.identity.fingerprint, 'У Алисы теперь другие ключи (переустановка без бэкапа)');
line();

// Боб пишет снова. У него в кэше старая сессия под старые ключи Алисы, но
// _ensureDirectSession замечает смену identityKey и пересобирает сессию.
await bob.send('alice:chat.org', 'm2');
const inbox2 = await alice2.receive();
assert(textOf(inbox2, 'm2'), 'После смены ключей Алисы Боб авто-пересобрал сессию, Алиса2 расшифровала m2');
line();

// Обратное направление тоже работает: Алиса2 отвечает, Боб читает.
await alice2.send('bob:chat.org', 'r1');
assert(textOf(await bob.receive(), 'r1'), 'Ответ Алисы2 дошёл и расшифрован Бобом (сессия здорова в обе стороны)');
line();

// И дальнейшие сообщения идут нормально (ratchet не «сломался»).
await bob.send('alice:chat.org', 'm3');
assert(textOf(await alice2.receive(), 'm3'), 'Последующие сообщения расшифровываются (сессия стабильна)');
line();

console.log('🎉 Тест самолечения сессии при смене ключей пройден.');
srv.server.close();
