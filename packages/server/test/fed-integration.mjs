// fed-integration.mjs — БОЕВОЙ тест Фазы 3: два homeserver'а + узел-тайник.
// Прямой путь A↔B заблокирован (resolver указывает в «никуда»). Сообщение alice→bob
// должно дойти через тайник: A разложил → B поллит → переинжектил → лежит в истории bob.
import { createServer } from '../src/server.js';
import { startNode } from '../../deaddrop/src/node.js';
import { loadServerIdentity, publicKeys } from '../src/deaddrop-fed.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nodeDir = mkdtempSync(join(tmpdir(), 'ddn-'));
const dirA = mkdtempSync(join(tmpdir(), 'hsA-')), dirB = mkdtempSync(join(tmpdir(), 'hsB-'));
const NODE = 'http://127.0.0.1:8975', PA = 8976, PB = 8977;
const BLOCK = 'http://127.0.0.1:1'; // недостижимо (connection refused) → имитация бана

const node = startNode({ dataDir: nodeDir, port: 8975, host: '127.0.0.1', publicUrl: NODE, gossip: false, heal: false, sweepMs: 3600000 });
await sleep(200);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
let A, B;
try {
  const idA = loadServerIdentity(join(dirA, 'server-identity.json'));
  const idB = loadServerIdentity(join(dirB, 'server-identity.json'));

  A = await createServer({ domain: 'a.invalid', port: PA, ports: [PA], storePath: join(dirA, 'store.json'),
    resolver: { 'a.invalid': `http://127.0.0.1:${PA}`, 'b.invalid': BLOCK }, // прямой путь к B заблокирован
    deaddropNodes: NODE, deaddropKeys: { 'b.invalid': publicKeys(idB) }, deaddropPollMs: 99999999 });
  B = await createServer({ domain: 'b.invalid', port: PB, ports: [PB], storePath: join(dirB, 'store.json'),
    resolver: { 'b.invalid': `http://127.0.0.1:${PB}`, 'a.invalid': BLOCK },
    deaddropNodes: NODE, deaddropKeys: { 'a.invalid': publicKeys(idA) }, deaddropPollMs: 99999999 });
  await sleep(300);

  const disc = await (await fetch(`http://127.0.0.1:${PA}/.well-known/prizrak/server`)).json();
  ok(disc.keys && disc.keys.ed === idA.edPubHex && disc.keys.x === idA.xPubHex, 'discovery публикует ключи сервера');
  ok(disc.deaddrop === true, 'discovery сообщает, что сеть тайников включена');

  // База: на узле уже могут лежать блобы директории серверов (6d — директория поверх overlay,
  // широковещательные записи без ACK). Считаем жизненный цикл СООБЩЕНИЯ/КВИТАНЦИИ относительно неё.
  const base = (await (await fetch(NODE + '/dd/health')).json()).blobs;

  // alice@a → bob@b. Прямой путь заблокирован → уходит через тайник.
  const env = { to: 'bob:b.invalid', from: 'alice:a.invalid', msgId: 'x1', type: 'message', envelope: 'E2E-CIPHERTEXT' };
  const out = await A.deliver(env);
  ok(out.delivered === true, 'A: доставка удалась через тайник (прямой путь заблокирован)');
  const h1 = await (await fetch(NODE + '/dd/health')).json();
  ok(h1.blobs >= base + 1, 'зашифрованный конверт лежит на узле-тайнике');
  ok(!B.store.hasMessage('bob:b.invalid', 'x1', null), 'до поллинга у bob сообщения ещё нет');

  // B поллит свой ящик → забирает, расшифровывает, переинжектит локально.
  const got = await B.ddfed.pollOnce();
  await sleep(200); // loopback-переинжект асинхронный
  ok(got.got === 1, 'B забрал 1 пакет из своего ящика на узле');
  ok(B.store.hasMessage('bob:b.invalid', 'x1', null), 'сообщение alice→bob ДОШЛО и лежит в истории bob (через тайник)');

  // При приёме B шлёт КВИТАНЦИЮ (✓✓) обратно к A — тоже через тайник (прямой путь заблокирован).
  const hMid = await (await fetch(NODE + '/dd/health')).json();
  ok(hMid.blobs === base + 1, 'исходный блоб удалён (ACK), но появилась квитанция для A на узле');
  const gotA = await A.ddfed.pollOnce();
  await sleep(150);
  ok(gotA.got === 1, 'A забрал квитанцию о доставке через тайник (обратный путь тоже работает)');
  const h2 = await (await fetch(NODE + '/dd/health')).json();
  ok(h2.blobs === base, 'сообщение и квитанция доставлены и сняты (директория overlay не считается)');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  try { A && A.closeAll(); } catch {}
  try { B && B.closeAll(); } catch {}
  node.stop();
  for (const d of [nodeDir, dirA, dirB]) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
