// MD4: синхро прочтения. Пометка «прочитано» с одного устройства доходит до других
// своих устройств служебным sync-read (обнуляют непрочитанные).
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8985, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'm.org', port: P, storePath: null, storagePaths: ['/tmp/mMD4'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n, dev, mode = 'register') => {
  const c = await new PrizrakClient({ name: n, userId: `${n}:m.org`, baseUrl: U, bankBase: U, deviceId: dev }).init();
  if (mode === 'register') await c.register(`${n}-pass-123`); else await c.login(`${n}-pass-123`);
  if (dev) await c.publishDevice();
  return c;
};

const aliceA = await mk('alice', 'devA', 'register');
const aliceB = await mk('alice', 'devB', 'login');

// Устройство A помечает чат с Бобом прочитанным → устройство B получает sync-read.
await aliceA.markReadSync('bob:m.org');
const evs = await aliceB.receive();
const rd = evs.find((m) => m.kind === 'sync-read');
ok(rd && rd.peer === 'bob:m.org', 'устройство B получило sync-read для чата с Бобом');

// Одно-девайсный клиент markReadSync не падает.
const carol = await new PrizrakClient({ name: 'carol', userId: 'carol:m.org', baseUrl: U, bankBase: U }).init();
await carol.register('carol-pass-123');
await carol.markReadSync('bob:m.org');
ok(true, 'одно-девайсный markReadSync не падает (некому синкать)');

console.log('🎉 синхро прочтения (MD4) — ок');
s.server.close();
