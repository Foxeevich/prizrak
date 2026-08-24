// features-media-progress-test.js — чанковая передача файла между серверами
// с прогрессом на обеих сторонах (push-status у отправителя, media/head у получателя).
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = 9291, B = 9292, UA = `http://127.0.0.1:${A}`, UB = `http://127.0.0.1:${B}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'a.org': UA, 'b.org': UB });
const sA = await createServer({ domain: 'a.org', port: A, storePath: null, storagePaths: ['/tmp/prz-mA'], registrationEnabled: true });
const sB = await createServer({ domain: 'b.org', port: B, storePath: null, storagePaths: ['/tmp/prz-mB'], registrationEnabled: true });

const mk = async (n, d, u) => { const c = await new PrizrakClient({ name: n, userId: `${n}:${d}`, baseUrl: u }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };
const alice = await mk('alice', 'a.org', UA), bob = await mk('bob', 'b.org', UB);

const N = 5 * 1024 * 1024 + 77; // >4МБ и не кратно чанку — 6 чанков
const bytes = new Uint8Array(N); for (let i = 0; i < N; i++) bytes[i] = (i * 9) & 0xff;
const up = await alice.sendAttachment('bob:b.org', bytes, { filename: 'big.bin', mime: 'application/octet-stream' });
const att = (await bob.receive()).find((m) => m.kind === 'attachment')?.attachment;
assert(att && att._origin === 'a.org', 'Bob получил конверт (origin=a.org)');
assert(!sB.storage.has(up.mediaId), 'До переноса файла на сервере получателя нет');

// Запускаем перенос (как делает клиент отправителя после отправки).
const fr = await alice.federateMedia(up.mediaId, 'b.org');
assert(fr && fr.started, 'Перенос запущен в фоне (started)');

let present = false, doneStatus = null, sawTotal = false;
for (let i = 0; i < 200; i++) {
  const ps = await alice.pushStatus(up.mediaId).catch(() => ({}));
  if (ps && ps.total > 0) sawTotal = true;
  if (ps && ps.done) doneStatus = ps;
  const h = await bob.mediaHead(att).catch(() => ({}));
  if (h && h.present) present = true;
  if (present && doneStatus) break;
  await sleep(50);
}
assert(sawTotal, 'push-status отдаёт total (прогресс отслеживается у отправителя)');
assert(doneStatus && doneStatus.ok, 'Перенос завершился успешно (push-status done+ok)');
assert(present, 'media/head у получателя показал present (файл на его сервере)');
assert(sB.storage.has(up.mediaId), 'Блоб реально лёг в хранилище сервера получателя');
const got = await bob.fetchAttachment(att);
assert(got && got.length === N && got[123456] === bytes[123456], 'Файл скачивается целым');

console.log('🎉 Чанковая передача с прогрессом на обеих сторонах — ок.');
sA.server.close(); sB.server.close();
try { sA.relay?.server.close(); sB.relay?.server.close(); } catch {}
