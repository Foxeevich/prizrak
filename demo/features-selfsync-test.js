// MD3: self-sync своих исходящих. Отправил с устройства A — устройство B видит это
// как «моё» сообщение (и вложение) в чате с тем же собеседником.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8986, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'm.org', port: P, storePath: null, storagePaths: ['/tmp/mMD3'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n, dev, mode = 'register') => {
  const c = await new PrizrakClient({ name: n, userId: `${n}:m.org`, baseUrl: U, bankBase: U, deviceId: dev }).init();
  if (mode === 'register') await c.register(`${n}-pass-123`); else await c.login(`${n}-pass-123`);
  if (dev) await c.publishDevice();
  return c;
};

const bob = await mk('bob', 'bobDev');
const aliceA = await mk('alice', 'devA', 'register');
const aliceB = await mk('alice', 'devB', 'login');

// Устройство A отправляет Бобу.
await aliceA.send('bob:m.org', 'моё исходящее');
ok((await bob.receive()).some((m) => m.text === 'моё исходящее' && !m.error), 'Bob получил сообщение');

// Устройство B получает КОПИЮ своего же исходящего (sync-sent) в чат с Бобом.
const syncs = await aliceB.receive();
const sm = syncs.find((m) => m.kind === 'sync-sent');
ok(sm && sm.peer === 'bob:m.org' && sm.inner && sm.inner.body === 'моё исходящее', 'устройство B увидело своё исходящее (текст)');

// Устройство B НЕ должно получить это как чужое входящее (только как sync-sent).
ok(!syncs.some((m) => m.kind === 'text'), 'на устройстве B нет ложного «входящего» от себя');

// Вложение тоже синхронизируется на своё устройство.
const bytes = new Uint8Array(1000).fill(7);
const up = await aliceA.sendAttachment('bob:m.org', bytes, { filename: 'f.bin', mime: 'application/octet-stream' });
await bob.receive();
const syncs2 = await aliceB.receive();
const sa = syncs2.find((m) => m.kind === 'sync-sent' && m.inner && m.inner.t === 'att');
ok(sa && sa.peer === 'bob:m.org' && sa.inner.mediaId === up.mediaId, 'устройство B увидело своё отправленное вложение');

// Одно-девайсный отправитель self-sync не шлёт (некому) — не падает.
const carol = await new PrizrakClient({ name: 'carol', userId: 'carol:m.org', baseUrl: U, bankBase: U }).init();
await carol.register('carol-pass-123');
await carol.send('bob:m.org', 'без устройств');
ok((await bob.receive()).some((m) => m.text === 'без устройств' && !m.error), 'легаси-отправитель работает (self-sync не мешает)');

console.log('🎉 self-sync исходящих (MD3) — ок');
s.server.close();
