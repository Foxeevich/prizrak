// features-presence-test.js — presence (в сети / был недавно) и онлайн-счётчик комнат.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8976, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true });
line();

const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };
const alice = await mk('alice'), bob = await mk('bob');

// Alice онлайн (живой WS).
await alice.connectRealtime(() => {});
await sleep(120);
let p = await bob.presence('alice:chat.org');
assert(p.online === true, 'Presence: Alice онлайн, когда подключена (в сети)');
line();

// Alice ушла — presence показывает «был недавно» + lastSeen.
alice.disconnectRealtime();
await sleep(150);
p = await bob.presence('alice:chat.org');
assert(p.online === false && p.lastSeen > 0, 'Presence: после отключения — офлайн + записан lastSeen');
line();

// Онлайн-счётчик комнаты: считает участников, у кого живой WS на этом сервере.
await alice.connectRealtime(() => {});
await sleep(120);
const g = await alice.createGroup('Тест-группа');
await alice.invite(g.id, 'bob:chat.org');
let room = await alice.getRoom(g.id);
assert(room.online === 1, 'Комната: 1 участник в сети (только Alice подключена)');

await bob.connectRealtime(() => {});
await sleep(150);
room = await alice.getRoom(g.id);
assert(room.online === 2, 'Комната: стало 2 в сети (подключился Bob)');
line();

console.log('🎉 Тест presence (в сети / был недавно + онлайн в комнатах) пройден.');
alice.disconnectRealtime(); bob.disconnectRealtime();
srv.server.close(); try { srv.relay?.server.close(); } catch {}
