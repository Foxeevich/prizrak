// claim-7.mjs — Фаза 7: код привязки узла к аккаунту оператора (самообслуживание).
import { startNode } from '../src/node.js';
import { signNodeClaim, verify, hexToBytes, nodeClaimMsg } from '../src/crypto.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const nd = mkdtempSync(join(tmpdir(), 'cl-'));

try {
  const node = startNode({ dataDir: nd, port: 8829, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:8829', gossip: false, heal: false, sweepMs: 3600000 });
  await sleep(150);
  const relayId = node.identity.nodeId;

  // /dd/claim отдаёт код для валидного ника.
  const j = await (await fetch('http://127.0.0.1:8829/dd/claim?user=alice:a.org')).json();
  ok(j.ok && j.relayId === relayId, '/dd/claim вернул код для узла');
  const dec = JSON.parse(Buffer.from(j.code.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  ok(dec.relayId === relayId && dec.userId === 'alice:a.org' && dec.sig, 'код декодируется в {relayId,userId,sig}');
  ok(verify(hexToBytes(relayId), hexToBytes(dec.sig), nodeClaimMsg(relayId, 'alice:a.org')), 'подпись узла в коде проверяется ключом узла');
  ok(!verify(hexToBytes(relayId), hexToBytes(dec.sig), nodeClaimMsg(relayId, 'mallory:evil.org')), 'подпись не подходит для чужого ника (нельзя переклеить)');

  // невалидный ник отвергается.
  const bad = await (await fetch('http://127.0.0.1:8829/dd/claim?user=not-a-nick')).json();
  ok(bad.ok === false, 'некорректный ник → отказ');

  // /dd/claim только с localhost (проверяем через x-forwarded вручную нельзя — сокет локальный);
  // здесь достаточно, что endpoint не отдаёт код без user.
  const none = await (await fetch('http://127.0.0.1:8829/dd/claim')).json();
  ok(none.ok === false, 'без ника код не выдаётся');

  node.stop();
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  rmSync(nd, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
