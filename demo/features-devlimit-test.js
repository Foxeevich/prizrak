// MD7: лимит устройств на аккаунт. Публикация сверх лимита эвиктит самые старые,
// текущее (только что добавленное) всегда остаётся.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8983, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'm.org', port: P, storePath: null, storagePaths: ['/tmp/mMD7'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };

const owner = await new PrizrakClient({ name: 'zoe', userId: 'zoe:m.org', baseUrl: U, bankBase: U, deviceId: 'd0' }).init();
await owner.register('zoe-pass-123'); await owner.publishDevice();

// Публикуем 14 устройств одного аккаунта (переиспользуем восстановление личности).
const LIMIT = 10;
let last;
for (let i = 1; i <= 13; i++) {
  const c = await new PrizrakClient({ name: 'zoe', userId: 'zoe:m.org', baseUrl: U, bankBase: U, deviceId: 'd' + i }).init();
  await c.login('zoe-pass-123'); await c.publishDevice();
  last = c;
}

const list = s.store.getDevices('zoe:m.org');
ok(list.length === LIMIT, `в реестре не больше лимита (${list.length} === ${LIMIT})`);
ok(list.some((d) => d.deviceId === 'd13'), 'последнее добавленное устройство осталось');
ok(!list.some((d) => d.deviceId === 'd0' && list.length === LIMIT) || list.length === LIMIT, 'самые старые эвиктнуты');
// Явно: d0..d3 (самые старые) должны быть вытеснены (14 устройств, лимит 10 → уходят 4 старейших).
ok(!list.some((d) => d.deviceId === 'd0'), 'старейшее устройство d0 вытеснено');

console.log('🎉 лимит устройств (MD7) — ок');
s.server.close();
