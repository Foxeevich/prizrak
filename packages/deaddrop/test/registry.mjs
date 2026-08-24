// registry.mjs — тест реестра/госсипа (Фаза 2): два узла находят друг друга и получают
// ОДИНАКОВОЕ детерминированное размещение (общая «карта кластера»).
import { startNode } from '../src/node.js';
import { makeRecord, verifyRecord } from '../src/registry.js';
import { placement } from '../src/placement.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirA = mkdtempSync(join(tmpdir(), 'ddA-')), dirB = mkdtempSync(join(tmpdir(), 'ddB-'));
const A = startNode({ dataDir: dirA, port: 8911, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:8911', gossip: false, sweepMs: 3600000 });
const B = startNode({ dataDir: dirB, port: 8912, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:8912', seeds: 'http://127.0.0.1:8911', gossip: false, sweepMs: 3600000 });
await new Promise((r) => setTimeout(r, 200));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

try {
  ok(A.registry.size() === 1 && B.registry.size() === 1, 'старт: каждый узел знает только себя');

  await B.gossipOnce();                     // B анонсирует себя A и тянет список A
  await new Promise((r) => setTimeout(r, 100));

  ok(B.registry.size() === 2, 'B узнал A (через /registry/list)');
  ok(A.registry.size() === 2, 'A узнал B (через /registry/announce)');

  const ids = new Set(A.registry.list().map((r) => r.relayId));
  ok(ids.has(A.identity.nodeId) && ids.has(B.identity.nodeId), 'реестр A содержит оба relayId');
  ok(A.registry.list().every(verifyRecord), 'все записи в реестре имеют валидную подпись');

  const forged = { ...makeRecord(B.identity, ['http://x'], Date.now()), endpoints: ['http://evil'] };
  ok(!verifyRecord(forged), 'подделанная запись (подменён endpoint) не проходит проверку подписи');
  ok(A.registry.upsert(forged) === false, 'реестр отвергает подделанную запись');

  const nodesA = A.registry.nodes(), nodesB = B.registry.nodes();
  const pA = placement('abc123', nodesA, 2), pB = placement('abc123', nodesB, 2);
  ok(pA.length === 2 && JSON.stringify(pA) === JSON.stringify(pB), 'placement ОДИНАКОВ у A и B (общая карта → согласие о репликах)');

  const h = await (await fetch('http://127.0.0.1:8911/dd/health')).json();
  ok(h.peers === 2, 'health отдаёт peers=2');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.message);
} finally {
  A.stop(); B.stop();
  rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
