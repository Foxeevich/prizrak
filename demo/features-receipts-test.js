// features-receipts-test.js — квитанции доставки/прочтения (галочки):
// delivered (до сервера получателя) → received (в приложение) → read (прочитано).
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8968, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true, startRelay: false });
line();

const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(`${n}-pass-123`); return c; };
const alice = await mk('alice'), bob = await mk('bob');

// 1) delivered — сообщение дошло до сервера получателя (локально — сразу true).
const sent = await alice.send('bob:chat.org', 'привет');
assert(sent.msgId && sent.delivered === true, 'send → delivered=true (дошло до сервера получателя)');
line();

// 2) received — приложение Bob получило сообщение и авто-отправило квитанцию.
const inbox = await bob.receive();
assert(inbox.some((m) => m.kind === 'text' && m.text === 'привет'), 'Bob получил сообщение');
await sleep(60); // дать авто-квитанции долететь
let ar = await alice.receive();
assert(ar.some((m) => m.kind === 'receipt' && m.status === 'received' && m.msgIds.includes(sent.msgId)),
  'Alice получила квитанцию received (левая галочка синеет)');
line();

// 3) read — Bob «прочитал» (открыл чат) → квитанция read.
await bob.markRead('alice:chat.org', [sent.msgId]);
ar = await alice.receive();
assert(ar.some((m) => m.kind === 'receipt' && m.status === 'read' && m.msgIds.includes(sent.msgId)),
  'Alice получила квитанцию read (обе галочки синие)');
line();

// 4) Квитанции переживают офлайн (складываются на сервере и отдаются в inbox).
const sent2 = await alice.send('bob:chat.org', 'ещё');
await bob.receive(); await sleep(60);
// Alice ещё не забирала — но квитанция ждёт в её inbox.
const ar2 = await alice.receive();
assert(ar2.some((m) => m.kind === 'receipt' && m.msgIds.includes(sent2.msgId)), 'Квитанция дождалась Alice в inbox (офлайн-доставка)');
line();

console.log('🎉 Тест квитанций доставки/прочтения пройден.');
srv.server.close();
