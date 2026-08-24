// MD5: кэш списка устройств. Повторный вызов в пределах TTL не ходит в сеть;
// появление нового устройства (сообщение с новым fromDevice) сбрасывает кэш.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8984, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'm.org', port: P, storePath: null, storagePaths: ['/tmp/mMD5'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n, dev, mode = 'register') => {
  const c = await new PrizrakClient({ name: n, userId: `${n}:m.org`, baseUrl: U, bankBase: U, deviceId: dev }).init();
  if (mode === 'register') await c.register(`${n}-pass-123`); else await c.login(`${n}-pass-123`);
  if (dev) await c.publishDevice();
  return c;
};

const bob = await mk('bob', 'bobDev');
const aliceA = await mk('alice', 'devA', 'register');

// Кэш: bob получил список алисы (1 устройство). Алиса добавляет второе устройство,
// но кэш bob ещё держит старый список.
ok((await bob.deviceList('alice:m.org')).length === 1, 'список алисы: 1 устройство (закэшировано)');
const aliceB = await mk('alice', 'devB', 'login');
ok((await bob.deviceList('alice:m.org')).length === 1, 'в пределах TTL кэш отдаёт прежний список (1)');
ok((await bob.deviceList('alice:m.org', { maxAgeMs: 0 })).length === 2, 'форс-обновление видит 2 устройства');

// Свежесть: сообщение с НОВОГО устройства собеседника сбрасывает кэш у получателя.
const carol = await mk('carol', 'carolDev', 'register');
await carol.deviceList('alice:m.org');                 // закэшировал (2 устройства сейчас)
// Алиса заводит ТРЕТЬЕ устройство и пишет carol с него.
const aliceC = await mk('alice', 'devC', 'login');
await aliceC.send('carol:m.org', 'привет с третьего устройства');
const got = await carol.receive();
ok(got.some((m) => m.text === 'привет с третьего устройства' && !m.error), 'carol получил сообщение с нового устройства алисы');
// Кэш carol на alice сброшен инвалидацией → свежий список включает devC.
ok((await carol.deviceList('alice:m.org')).some((d) => d.deviceId === 'devC'), 'кэш сброшен: новый список включает devC');

console.log('🎉 кэш устройств + свежесть (MD5) — ок');
s.server.close();
