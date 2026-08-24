// features-lostsession-test.js — получатель ПОТЕРЯЛ сессию (переустановка/сброс
// кэша), но ключи те же. Отправитель прикладывает handshake к каждому сообщению,
// пока получатель не ответил, поэтому тот пересоберёт сессию (не «нет сессии»).
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const textOf = (inbox, t) => inbox.some((m) => m.kind === 'text' && m.text === t);

const PORT = 8991, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true });
line();

const mk = async (n, pass) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(pass); return c; };
const alice = await mk('alice', 'alice-pass-123');
const bob = await mk('bob', 'bob-pass-123');

await bob.send('alice:chat.org', 'm1');
assert(textOf(await alice.receive(), 'm1'), 'Алиса расшифровала m1');
assert(bob.pendingHandshake.has('alice:chat.org'), 'Боб продолжает прикладывать handshake (Алиса ещё не ответила)');
line();

// Алиса «переустановилась»: локальная сессия потеряна, ключи те же.
alice.sessions.clear();
await bob.send('alice:chat.org', 'm2');
assert(textOf(await alice.receive(), 'm2'), 'Алиса пересобрала сессию из повторного handshake и расшифровала m2 (не «нет сессии»)');
line();

// Алиса отвечает — Боб «подтверждает» сессию и перестаёт слать handshake.
await alice.send('bob:chat.org', 'r1');
assert(textOf(await bob.receive(), 'r1'), 'Ответ Алисы дошёл до Боба');
assert(!bob.pendingHandshake.has('alice:chat.org'), 'После ответа Алисы Боб перестал прикладывать handshake');
line();

console.log('🎉 Тест восстановления потерянной сессии пройден.');
srv.server.close();
