// Проверка, что desktop/lib (используемый Electron-клиентом) работает как надо.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/desktop/lib/client.js';

function assert(c, m) { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); }
const PORT = 8911, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'd.org': URL });
const srv = await createServer({ domain: 'd.org', port: PORT, storePath: null, registrationEnabled: true });

const alice = await new PrizrakClient({ name: 'Alice', userId: 'alice:d.org', baseUrl: URL }).init();
const bob = await new PrizrakClient({ name: 'Bob', userId: 'bob:d.org', baseUrl: URL }).init();
await alice.register('alice-pass-123');
await bob.register('bob-pass-123');
assert(alice.token && bob.token, 'desktop/lib: регистрация работает');

await alice.send('bob:d.org', 'Привет из Electron-библиотеки!');
const got = await bob.receive();
assert(got.find((m) => m.text === 'Привет из Electron-библиотеки!'), 'desktop/lib: E2E-сообщение доставлено и расшифровано');

const g = await alice.createGroup('Test');
await alice.invite(g.id, 'bob:d.org');
await alice.sendToRoom(g.id, 'групповое из lib');
const gg = await bob.receive();
assert(gg.find((m) => m.text === 'групповое из lib' && m.roomId === g.id), 'desktop/lib: группа работает');

console.log('🎉 desktop/lib проверен.');
srv.server.close();
