// features-delete-both-test.js — «удалить у всех» удаляет сообщение у ОБОИХ
// участников, включая автора-собеседника, и переживает офлайн (tombstone).
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const has = (list, id) => list.some((m) => m.kind === 'delete' && m.msgId === id);

const PORT = 8967, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true, startRelay: false });
line();

const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(`${n}-pass-123`); return c; };
const alice = await mk('alice'), bob = await mk('bob');

// Bob отправил Alice; Alice удаляет «у всех». Автор (Bob) должен получить удаление,
// хотя серверная копия лежала только в истории Alice.
const m1 = (await bob.send('alice:chat.org', 'сообщение Боба')).msgId;
await alice.receive(); // Alice забрала (и авто-ack)
await alice.deleteMessage(m1);
const bobEvents = await bob.receive();
assert(has(bobEvents, m1), 'Автор (Bob) получил команду удаления своего сообщения (удалено у обоих)');
line();

// Alice отправила Bob; Bob офлайн; Alice удаляет «у всех» → Bob догоняет tombstone.
const m2 = (await alice.send('bob:chat.org', 'сообщение Алисы')).msgId;
// Bob НЕ забирает (офлайн)
await alice.deleteMessage(m2);
const bobLater = await bob.receive(); // придёт и сообщение, и его удаление
assert(has(bobLater, m2), 'Офлайн-получатель (Bob) догнал удаление при следующем заходе (tombstone)');
// После обработки сообщения m2 уже нет на сервере — повторный inbox пуст по нему.
line();

console.log('🎉 Тест «удалить у всех» (у обоих + офлайн) пройден.');
srv.server.close();
