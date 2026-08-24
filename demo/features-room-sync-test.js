// Синхронизация ГРУППОВЫХ сообщений между устройствами одного пользователя
// (десктоп ↔ телефон): свои исходящие в группу должны появляться на всех
// устройствах автора (MD3-style self-sync для комнат), а сообщения собеседника —
// доходить на все устройства.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8987, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'm.org', port: P, storePath: null, storagePaths: ['/tmp/mRSYNC'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };

// ann: два устройства (десктоп d1 + «телефон» m1); bob: одно.
const annD = await new PrizrakClient({ name: 'ann', userId: 'ann:m.org', baseUrl: U, bankBase: U, deviceId: 'd1' }).init();
await annD.register('ann-pass-123'); await annD.publishDevice();
const annM = await new PrizrakClient({ name: 'ann', userId: 'ann:m.org', baseUrl: U, bankBase: U, deviceId: 'm1' }).init();
await annM.login('ann-pass-123'); await annM.publishDevice();
const bob = await new PrizrakClient({ name: 'bob', userId: 'bob:m.org', baseUrl: U, bankBase: U, deviceId: 'b1' }).init();
await bob.register('bob-pass-123'); await bob.publishDevice();

// Группа: ann создаёт, приглашает bob.
const room = await annD._post('/_prizrak/client/v1/rooms/create', { type: 'group', name: 'Синхро-группа' });
await annD._post('/_prizrak/client/v1/rooms/invite', { roomId: room.id, userId: 'bob:m.org' });
await bob._post('/_prizrak/client/v1/rooms/join', { roomId: room.id });

const flat = (msgs) => msgs.filter((m) => m.kind === 'text').map((m) => `${m.roomId ? 'R' : 'D'}:${m.text}`);

// 1. bob пишет в группу → ОБА устройства ann получают.
await bob.sendToRoom(room.id, 'привет группа от боба');
const a1 = await annD.receive(); const a2 = await annM.receive();
ok(a1.some((m) => m.kind === 'text' && m.roomId === room.id && m.text.includes('от боба')), 'десктоп ann получил групповое от боба');
ok(a2.some((m) => m.kind === 'text' && m.roomId === room.id && m.text.includes('от боба')), 'телефон ann получил групповое от боба');

// 2. ann пишет в группу С ДЕСКТОПА → bob получает, и ТЕЛЕФОН ann видит копию своего исходящего.
await annD.sendToRoom(room.id, 'привет с десктопа');
const b1 = await bob.receive();
ok(b1.some((m) => m.kind === 'text' && m.roomId === room.id && m.text.includes('с десктопа')), 'bob получил групповое от ann');
const m2 = await annM.receive();
const roomSync = m2.find((m) => m.kind === 'sync-sent' && m.roomId === room.id);
ok(roomSync && roomSync.inner && roomSync.inner.body === 'привет с десктопа', 'телефон ann получил копию своего группового (room self-sync)');

// 3. ann пишет в группу С ТЕЛЕФОНА → десктоп ann видит копию.
await annM.sendToRoom(room.id, 'привет с телефона');
const d2 = await annD.receive();
const roomSync2 = d2.find((m) => m.kind === 'sync-sent' && m.roomId === room.id);
ok(roomSync2 && roomSync2.inner && roomSync2.inner.body === 'привет с телефона', 'десктоп ann получил копию группового с телефона');
const b2 = await bob.receive();
ok(b2.some((m) => m.kind === 'text' && m.roomId === room.id && m.text.includes('с телефона')), 'bob получил групповое с телефона ann');

// 4. Контроль: личка ann(десктоп) → bob; телефон ann видит sync-sent (MD3, было и раньше).
await annD.send('bob:m.org', 'личка с десктопа');
const m3 = await annM.receive();
ok(m3.some((m) => m.kind === 'sync-sent' && m.peer === 'bob:m.org' && m.inner?.body === 'личка с десктопа'), 'личный self-sync (MD3) работает');

console.log('🎉 синхронизация групповых сообщений между устройствами — ок');
s.server.close();
process.exit(0);
