// Серверный ключ канала: ключ хранится на домашнем сервере канала и выдаётся любому
// участнику — подписчик читает БЕЗ владельца-онлайн. Владелец управляет (перевыпуск).
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const A = 8949, B = 8950, UA = `http://127.0.0.1:${A}`, UB = `http://127.0.0.1:${B}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'a.org': UA, 'b.org': UB });
const sA = await createServer({ domain: 'a.org', port: A, storePath: null, storagePaths: ['/tmp/mSkA'], registrationEnabled: true });
const sB = await createServer({ domain: 'b.org', port: B, storePath: null, storagePaths: ['/tmp/mSkB'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n, d, u) => { const c = await new PrizrakClient({ name: n, userId: `${n}:${d}`, baseUrl: u, bankBase: u }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };

const owner = await mk('owner', 'a.org', UA);
const ch = await owner.createChannel('Канал');
ok(Object.keys(sA.store.getChannelSecrets(ch.id)).length > 0, 'ключ канала сохранён на сервере при создании');

await owner.invite(ch.id, 'bob:b.org');
await owner.postChannel(ch.id, 'первый пост');

// bob появляется ПОЗЖЕ и на другом сервере — читает, забирая ключ с сервера канала.
// Владелец при этом не делает никаких live-грантов.
const bob = await mk('bob', 'b.org', UB);
let hist = await bob.getChannelHistory(ch.id);
ok(hist.some((h) => h.text === 'первый пост' && !h.error), 'подписчик с другого сервера читает БЕЗ владельца-онлайн');

// Локальный подписчик, приглашённый уже после поста, тоже читает.
const fox = await mk('fox', 'a.org', UA);
await owner.invite(ch.id, 'fox:a.org');
await owner.postChannel(ch.id, 'второй пост');
hist = await fox.getChannelHistory(ch.id);
ok(hist.some((h) => h.text === 'второй пост' && !h.error), 'локальный подписчик читает через серверный ключ');

// Перевыпуск ключа владельцем (ротация) — новый ключ тоже уходит на сервер.
const epochBefore = (await owner.getRoom(ch.id)).keyEpoch;
await owner.rotateChannel(ch.id);
const epochAfter = (await owner.getRoom(ch.id)).keyEpoch;
ok(epochAfter > epochBefore, 'владелец перевыпустил ключ (эпоха выросла)');
await owner.postChannel(ch.id, 'после перевыпуска');
// bob со свежим клиентом (без кэша ключей) читает новый пост
const bob2 = await new PrizrakClient({ name: 'bob', userId: 'bob:b.org', baseUrl: UB, bankBase: UB }).init();
await bob2.login('bob-pass-123'); await bob2.serverConfig();
hist = await bob2.getChannelHistory(ch.id);
ok(hist.some((h) => h.text === 'после перевыпуска' && !h.error), 'после перевыпуска подписчик читает новый ключ с сервера');

console.log('🎉 серверный ключ канала — ок');
sA.server.close(); sB.server.close();
