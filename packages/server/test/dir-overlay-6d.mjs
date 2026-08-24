// dir-overlay-6d.mjs — Фаза 6d: директория серверов ПОВЕРХ overlay (dogfooding).
// Записи серверов расходятся теми же PUT/POLL/GET, что несут сообщения — так же цензуростойко.
import { startNode } from '../../deaddrop/src/node.js';
import { DeaddropFed, loadServerIdentity, makeServerRecord, directoryMailbox } from '../src/deaddrop-fed.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const nd = mkdtempSync(join(tmpdir(), 'n-'));
const dA = mkdtempSync(join(tmpdir(), 'sA-')), dB = mkdtempSync(join(tmpdir(), 'sB-'));
const N = 'http://127.0.0.1:8961';
const node = startNode({ dataDir: nd, port: 8961, host: '127.0.0.1', publicUrl: N, gossip: false, heal: false, sweepMs: 3600000 });
await sleep(180);

try {
  ok(directoryMailbox(20000) === directoryMailbox(20000) && directoryMailbox(20000) !== directoryMailbox(20001), 'ящик директории детерминирован и меняется по эпохе');

  const idA = loadServerIdentity(join(dA, 'srv.json'));
  const idB = loadServerIdentity(join(dB, 'srv.json'));
  // overlayDirectory включён по умолчанию; НЕ полагаемся на /directory/* — зовём overlay напрямую.
  const fedA = new DeaddropFed({ identity: idA, domain: 'a.invalid', seeds: [N], ownEndpoints: ['https://a.invalid'], peersCachePath: join(dA, 'p.json') });
  const fedB = new DeaddropFed({ identity: idB, domain: 'b.invalid', seeds: [N], ownEndpoints: ['https://b.invalid'], peersCachePath: join(dB, 'p.json') });
  await fedA.refreshNodes(); await fedB.refreshNodes();

  // A публикует свою запись В OVERLAY (широковещательный ящик директории).
  const pub = await fedA.publishDirectoryOverlay();
  ok(pub.replicas >= 1, 'A опубликовал свою запись в директорию поверх overlay (реплик ≥1)');

  // ДЕДУП: повторные публикации в пределах эпохи НЕ плодят новые блобы (стабильный addedAt).
  const blobsBefore = node.store.stats().blobs;
  await fedA.publishDirectoryOverlay();
  await fedA.publishDirectoryOverlay();
  ok(node.store.stats().blobs === blobsBefore, 'повторные publishDirectoryOverlay не плодят блобы (дедуп по эпохе)');

  // B узнаёт A ТОЛЬКО через overlay-poll (никаких /directory/list вызовов).
  const before = fedB.serverDir.size;
  const r = await fedB.pullDirectoryOverlay();
  ok(r.learned >= 1 && fedB.serverDir.has('a.invalid'), 'B узнал сервер A из директории поверх overlay');
  const ak = fedB.serverDir.get('a.invalid');
  ok(ak && ak.keys.ed === idA.edPubHex && ak.keys.x === idA.xPubHex, 'ключи A, пришедшие overlay-путём, совпадают с настоящими');

  // Повторный pull не задваивает (dedup по msgId).
  const r2 = await fedB.pullDirectoryOverlay();
  ok(r2.learned === 0 && fedB.serverDir.size >= before + 1, 'повторный overlay-pull не переучивает то же (dedup)');

  // Подделка: кладём в ящик директории «запись» с чужой подписью — B её не примет.
  const epoch = Math.floor(Date.now() / 86400000);
  const mailbox = directoryMailbox(epoch);
  const forged = { ...makeServerRecord(idB, 'evil.invalid', ['https://evil'], Date.now()), domain: 'evil.invalid', keys: { ed: idA.edPubHex, x: idA.xPubHex } };
  const blob = Buffer.from(JSON.stringify(forged));
  const { msgIdOf } = await import('../src/deaddrop-fed.js');
  const msgId = msgIdOf(new Uint8Array(blob));
  await fetch(N + '/dd/put', { method: 'PUT', headers: { 'x-dd-msgid': msgId, 'x-dd-mailbox': mailbox, 'x-dd-epoch': String(epoch), 'x-dd-expiry': String(Date.now() + 86400000) }, body: blob });
  await fedB.pullDirectoryOverlay();
  ok(!fedB.serverDir.has('evil.invalid'), 'подделанная запись в overlay-директории отвергнута (подпись не сходится)');

  // Полный syncDirectory тоже гоняет overlay-путь без ошибок.
  const s = await fedA.syncDirectory();
  ok(s && typeof s.servers === 'number', 'syncDirectory (control-plane + overlay) отработал');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  node.stop();
  for (const d of [nd, dA, dB]) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
