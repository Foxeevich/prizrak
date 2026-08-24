// MD1: реестр устройств. Два устройства одного аккаунта публикуют РАЗНЫЕ per-device
// bundle'ы под ОБЩИМ PGP-корнем; собеседник получает проверенный список; отзыв работает.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8988, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'm.org', port: P, storePath: null, storagePaths: ['/tmp/mDev'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n, dev) => new PrizrakClient({ name: n, userId: `${n}:m.org`, baseUrl: U, bankBase: U, deviceId: dev }).init();

// Устройство A регистрирует аккаунт; устройство B входит тем же аккаунтом.
// publishDevice вызывается хостом (main/afterAuth) — в тесте зовём вручную.
const aliceA = await mk('alice', 'devA'); await aliceA.register('alice-pass-123'); await aliceA.publishDevice();
const aliceB = await mk('alice', 'devB'); await aliceB.login('alice-pass-123'); await aliceB.publishDevice();
const bob = await mk('bob', 'devBob'); await bob.register('bob-pass-123'); await bob.publishDevice();

// Собеседник видит оба устройства алисы, оба bundle прошли проверку подписи.
const list = await bob.deviceList('alice:m.org');
ok(list.length === 2, 'в реестре 2 устройства алисы (оба с валидной подписью)');
ok(list.map((d) => d.deviceId).sort().join(',') === 'devA,devB', 'deviceId устройств: devA, devB');

// У устройств РАЗНЫЕ per-device identity-ключи, но ОБЩИЙ PGP-корень (паспорт).
ok(new Set(list.map((d) => d.bundle.identityKey)).size === 2, 'у устройств разные device identity-ключи');
ok(new Set(list.map((d) => d.bundle.pgpPublicKey)).size === 1, 'общий PGP-корень у всех устройств');
ok(list.every((d) => d.bundle.pgpPublicKey === aliceA.identity.pgp.publicKey), 'PGP-корень совпадает с паспортом алисы');

// Восстановленная личность на устройстве B — та же (fingerprint), корень общий.
ok(aliceB.fingerprint === aliceA.fingerprint, 'устройство B восстановило ту же личность (fingerprint)');

// Отзыв устройства B — в списке остаётся только A.
await aliceB.revokeDevice('devB');
const list2 = await bob.deviceList('alice:m.org', { maxAgeMs: 0 }); // MD5: форсим свежий список
ok(list2.length === 1 && list2[0].deviceId === 'devA', 'после отзыва devB остаётся только devA');

// Одно-девайсный режим (без deviceId) реестр не трогает.
const solo = await mk('carol', null); await solo.register('carol-pass-123');
ok((await bob.deviceList('carol:m.org')).length === 0, 'без deviceId устройство в реестр не публикуется (легаси-режим)');

console.log('🎉 реестр устройств (MD1) — ок');
s.server.close();
