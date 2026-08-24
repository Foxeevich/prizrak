// healing.mjs — тест самоисцеления (Фазы 4–5, модель Ceph). 4 узла, RF=3.
// Проверяем: backfill до RF; ре-репликацию при «падении» узла; ACK-протухание;
// снятие лишней копии (rebalance).
import { startNode } from '../src/node.js';
import { placement } from '../src/placement.js';
import { newKeypair, bytesToHex, msgIdOf, mailboxOf, signAck, randomBytes } from '../src/crypto.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [], nodes = [];
for (let i = 0; i < 4; i++) {
  const d = mkdtempSync(join(tmpdir(), 'ddH' + i + '-')); dirs.push(d);
  nodes.push(startNode({ dataDir: d, port: 8931 + i, host: '127.0.0.1', publicUrl: `http://127.0.0.1:${8931 + i}`, gossip: false, heal: false, rf: 3, sweepMs: 3600000 }));
}
await sleep(200);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const byId = new Map(nodes.map((n) => [n.identity.nodeId, n]));
const memOf = (nd) => nd.registry.nodes().map((x) => ({ relayId: x.relayId, group: x.group }));
const tgt = (nd, id, rf = 3) => placement(id, memOf(nd), rf);
const holds = (nd, id) => nd.store.get(id) != null;

try {
  // Все знают всех (ручной обмен вместо госсипа).
  const allRecs = nodes.map((n) => n.registry.list()[0]);
  for (const n of nodes) n.registry.upsertMany(allRecs);
  ok(nodes.every((n) => n.registry.nodes().length === 4), '4 узла знают друг друга');

  // ── Блоб 1: backfill до RF ────────────────────────────────────────────────
  const rcpt = newKeypair(), rcptPub = bytesToHex(rcpt.pub), epoch = 1;
  const mailbox = mailboxOf(rcptPub, epoch);
  const ct = Buffer.from(randomBytes(1200)), id1 = msgIdOf(ct), expiry = Date.now() + 86400000;
  let target = tgt(nodes[0], id1);
  const primary = byId.get(target[0]);
  primary.store.put({ msgId: id1, mailbox, epoch, expiry, ct }); // положили ТОЛЬКО на primary
  ok(target.filter((t) => holds(byId.get(t), id1)).length === 1, 'старт: блоб только на primary');

  await primary.healOnce(); await sleep(150);
  ok(target.every((t) => holds(byId.get(t), id1)), 'backfill: все 3 реплики набора получили копию');
  const outsider = nodes.find((n) => !target.includes(n.identity.nodeId));
  ok(outsider && !holds(outsider, id1), 'узел вне набора копию НЕ получил');

  // ── Падение узла → ре-репликация на новый живой (Ceph backfill) ───────────
  const offId = target[2];                        // «упал» третий узел набора
  for (const n of nodes) n.registry.map.delete(offId); // выбыл из карты у всех живых
  const newTarget = tgt(nodes[0], id1);
  ok(!newTarget.includes(offId) && newTarget.length === 3, 'после падения набор пересчитался без упавшего');
  const entrant = newTarget.find((t) => !target.includes(t)); // новый узел, вошедший в набор
  ok(entrant && !holds(byId.get(entrant), id1), 'новый узел набора пока без копии');

  const newPrimary = byId.get(newTarget[0]);
  await newPrimary.healOnce(); await sleep(150);
  ok(holds(byId.get(entrant), id1), 'ре-репликация: новый узел набора получил копию (RF восстановлен)');

  // ── ACK-протухание: доставили → распространяем ACK → лишние удаляются ─────
  const holderA = byId.get(newTarget[0]), holderB = byId.get(newTarget[1]);
  holderB.store.ack({ msgId: id1, pub: rcptPub, sig: signAck(rcpt.priv, id1) }); // получатель забрал у B
  ok(!holds(holderB, id1), 'получатель ACKнул у одного узла — там блоб удалён');
  await holderA.healOnce(); await sleep(150);
  ok(!holds(holderA, id1), 'исцеление: узел узнал про ACK у соседа и удалил свою копию (протухло)');

  // ── Лишняя копия (rebalance): узел не в наборе, а копия есть → снять ──────
  for (const n of nodes) n.registry.upsertMany(allRecs); // вернуть полную карту (4 живых узла)
  // Найдём msgId, чей набор НЕ включает nodes[3], и наберём 3 реплики.
  let ct2, id2, target2;
  for (let i = 0; i < 200; i++) {
    ct2 = Buffer.from(randomBytes(800)); id2 = msgIdOf(ct2); target2 = tgt(nodes[0], id2);
    if (!target2.includes(nodes[3].identity.nodeId)) break;
  }
  for (const t of target2) byId.get(t).store.put({ msgId: id2, mailbox, epoch, expiry, ct: ct2 });
  nodes[3].store.put({ msgId: id2, mailbox, epoch, expiry, ct: ct2 }); // лишняя копия на узле вне набора
  ok(holds(nodes[3], id2), 'подготовка: лишняя копия лежит на узле вне набора');
  await nodes[3].healOnce(); await sleep(150);
  ok(!holds(nodes[3], id2), 'исцеление: лишняя копия снята (достаточно правильных живых реплик)');
  ok(target2.every((t) => holds(byId.get(t), id2)), 'при этом копии на правильных узлах набора целы');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  for (const n of nodes) n.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
