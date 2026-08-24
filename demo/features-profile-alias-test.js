// Профиль (отображаемое имя/ДР) и приватные псевдонимы контактов с синхронизацией
// между устройствами владельца (self-broadcast), собеседник псевдоним не видит.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8993, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'm.org', port: P, storePath: null, storagePaths: ['/tmp/mPROF'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };

// alice на двух устройствах, bob — собеседник.
const aliceA = await new PrizrakClient({ name: 'alice', userId: 'alice:m.org', baseUrl: U, bankBase: U, deviceId: 'a1' }).init();
await aliceA.register('alice-pass-1'); await aliceA.publishDevice();
const aliceB = await new PrizrakClient({ name: 'alice', userId: 'alice:m.org', baseUrl: U, bankBase: U, deviceId: 'a2' }).init();
await aliceB.login('alice-pass-1'); await aliceB.publishDevice();
const bob = await new PrizrakClient({ name: 'bob', userId: 'bob:m.org', baseUrl: U, bankBase: U, deviceId: 'b1' }).init();
await bob.register('bob-pass-1'); await bob.publishDevice();

// 1. Профиль: bob задаёт отображаемое имя и ДР — alice их видит.
await bob.setProfile({ displayName: 'Боб Иванов', birthday: '01.01.2000', bio: 'привет' });
const prof = await aliceA.getProfile('bob:m.org');
ok(prof.displayName === 'Боб Иванов', `отображаемое имя из профиля («${prof.displayName}»)`);
ok(prof.birthday === '01.01.2000', 'день рождения из профиля');

// 2. Псевдоним: alice ставит bob'у приватное имя «Муж» с устройства A → прилетает на устройство B.
await aliceA.setContactAlias('bob:m.org', 'Муж');
const inboxB = await aliceB.receive();
const aliasEv = inboxB.find((m) => m.kind === 'alias');
ok(aliasEv && aliasEv.peer === 'bob:m.org' && aliasEv.name === 'Муж', 'псевдоним синхронизировался на второе устройство alice');

// 3. Псевдоним приватный: bob НЕ получает никакого события про «Муж».
const inboxBob = await bob.receive();
ok(!inboxBob.some((m) => m.kind === 'alias'), 'собеседник псевдоним не видит (приватность)');

console.log('🎉 профиль + приватные псевдонимы с синхронизацией — ок');
s.server.close();
process.exit(0);
