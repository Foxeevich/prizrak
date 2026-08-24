// Восстановление списка личных чатов на новом устройстве: GET /chats отдаёт
// собеседников по метаданным истории (from/lastAt/count), содержимое — E2E.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8985, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'm.org', port: P, storePath: null, storagePaths: ['/tmp/mCHATS'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };

const ann = await new PrizrakClient({ name: 'ann', userId: 'ann:m.org', baseUrl: U, bankBase: U, deviceId: 'a1' }).init();
await ann.register('ann-pass-123'); await ann.publishDevice();
const bob = await new PrizrakClient({ name: 'bob', userId: 'bob:m.org', baseUrl: U, bankBase: U, deviceId: 'b1' }).init();
await bob.register('bob-pass-123'); await bob.publishDevice();
const cid = await new PrizrakClient({ name: 'cid', userId: 'cid:m.org', baseUrl: U, bankBase: U, deviceId: 'c1' }).init();
await cid.register('cid-pass-123'); await cid.publishDevice();

// bob и cid пишут ann
await bob.send('ann:m.org', 'привет от боба');
await cid.send('ann:m.org', 'привет от сида');
await bob.send('ann:m.org', 'ещё раз бob');

// ann входит с НОВОГО устройства → списка чатов локально нет, но /chats его отдаёт
const ann2 = await new PrizrakClient({ name: 'ann', userId: 'ann:m.org', baseUrl: U, bankBase: U, deviceId: 'a2' }).init();
await ann2.login('ann-pass-123'); await ann2.publishDevice();
const chats = await ann2.listChats();
ok(Array.isArray(chats) && chats.length === 2, `у ann два собеседника (${chats.length})`);
const peers = chats.map((c) => c.peer);
ok(peers.includes('bob:m.org') && peers.includes('cid:m.org'), 'собеседники: bob и cid');
const bobChat = chats.find((c) => c.peer === 'bob:m.org');
ok(bobChat.count === 2 || bobChat.count === 3, `счётчик сообщений от bob разумный (${bobChat.count})`); // hs-конверты могут добавиться
ok(chats[0].lastAt >= chats[1].lastAt, 'сортировка по последней активности');

// группы/каналы восстанавливаются через /rooms (создадим и проверим)
const room = await ann._post('/_prizrak/client/v1/rooms/create', { type: 'group', name: 'Тест-группа' });
const rooms2 = await ann2.listRooms();
ok(rooms2.some((r) => r.id === room.id), 'группа видна с нового устройства через /rooms');

console.log('🎉 восстановление списка чатов на новом устройстве — ок');
s.server.close();
process.exit(0);
