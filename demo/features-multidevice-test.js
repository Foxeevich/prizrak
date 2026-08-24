// MD2: fan-out на устройства. Личное сообщение доходит до ВСЕХ устройств получателя
// и расшифровывается; ответ доходит отправителю; легаси-собеседник (без устройства)
// работает через fallback; групповое сообщение доходит на оба устройства.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8987, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'm.org', port: P, storePath: null, storagePaths: ['/tmp/mMD2'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n, dev, mode = 'register') => {
  const c = await new PrizrakClient({ name: n, userId: `${n}:m.org`, baseUrl: U, bankBase: U, deviceId: dev }).init();
  if (mode === 'register') await c.register(`${n}-pass-123`); else await c.login(`${n}-pass-123`);
  if (dev) await c.publishDevice();
  return c;
};

const bob = await mk('bob', 'bobDev');
const aliceA = await mk('alice', 'devA', 'register');       // первое устройство алисы (регистрирует аккаунт)
const aliceB = await mk('alice', 'devB', 'login');          // второе устройство того же аккаунта

// 1) Bob → Alice: сообщение приходит на ОБА устройства и расшифровывается.
await bob.send('alice:m.org', 'привет на все устройства');
const rA = await aliceA.receive(), rB = await aliceB.receive();
ok(rA.some((m) => m.kind === 'text' && m.text === 'привет на все устройства' && !m.error), 'устройство A получило и расшифровало DM');
ok(rB.some((m) => m.kind === 'text' && m.text === 'привет на все устройства' && !m.error), 'устройство B получило и расшифровало DM');

// 2) Alice (устройство A) → Bob: ответ доходит.
await aliceA.send('bob:m.org', 'ответ с устройства A');
ok((await bob.receive()).some((m) => m.text === 'ответ с устройства A' && !m.error), 'Bob получил ответ от устройства A');

// 3) Alice (устройство B) → Bob: тоже доходит (независимая сессия устройства B).
await aliceB.send('bob:m.org', 'ответ с устройства B');
ok((await bob.receive()).some((m) => m.text === 'ответ с устройства B' && !m.error), 'Bob получил ответ от устройства B');

// 4) Легаси-собеседник (без deviceId) — fallback на одно-девайсный путь.
const carol = await new PrizrakClient({ name: 'carol', userId: 'carol:m.org', baseUrl: U, bankBase: U }).init();
await carol.register('carol-pass-123'); // без publishDevice — легаси
await bob.send('carol:m.org', 'привет легаси');
ok((await carol.receive()).some((m) => m.text === 'привет легаси' && !m.error), 'легаси-собеседник получает DM (fallback)');
await carol.send('bob:m.org', 'ответ легаси');
ok((await bob.receive()).some((m) => m.text === 'ответ легаси' && !m.error), 'Bob получает ответ от легаси-собеседника');

// 5) Группа: сообщение доходит на ОБА устройства алисы.
const grp = await bob.createGroup('MD2-группа');
await bob.invite(grp.id, 'alice:m.org');
await bob.sendToRoom(grp.id, 'сообщение в группу');
const gA = await aliceA.receive(), gB = await aliceB.receive();
ok(gA.some((m) => m.roomId === grp.id && m.text === 'сообщение в группу' && !m.error), 'устройство A получило групповое сообщение');
ok(gB.some((m) => m.roomId === grp.id && m.text === 'сообщение в группу' && !m.error), 'устройство B получило групповое сообщение');

console.log('🎉 мультидевайс DM + группы (MD2) — ок');
s.server.close();
