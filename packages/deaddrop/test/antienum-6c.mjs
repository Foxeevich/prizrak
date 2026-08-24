// antienum-6c.mjs — Фаза 6c: анти-энумерация листингов + приватные (bridge) узлы.
import { RateLimiter, sampleSubset, clientKey } from '../src/antienum.js';
import { startNode } from '../src/node.js';
import { makeRecord } from '../src/registry.js';
import { newKeypair, bytesToHex } from '../src/crypto.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const mkId = () => { const { priv, pub } = newKeypair(); return { priv, nodeId: bytesToHex(pub) }; };

const dPriv = mkdtempSync(join(tmpdir(), 'ndp-')), dPub = mkdtempSync(join(tmpdir(), 'ndu-'));
let priv, pub;
try {
  // ── RateLimiter (token-bucket) ──
  const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 });
  const t0 = 1_000_000;
  ok(rl.allow('ip', t0) && rl.allow('ip', t0) && rl.allow('ip', t0), 'burst до capacity=3 разрешён');
  ok(!rl.allow('ip', t0), '4-й запрос подряд отклонён (корзина пуста)');
  ok(rl.allow('ip', t0 + 1000), 'через 1с долилось ~1 токен → снова разрешён');
  ok(rl.allow('other', t0), 'другой IP имеет свою корзину (независим)');

  // ── sampleSubset ──
  ok(sampleSubset([1,2,3,4,5,6,7,8,9,10], 3).length === 3, 'подмножество ограничено n=3');
  ok(sampleSubset([1,2], 5).length === 2, 'если элементов меньше n — вернуть все');
  const sub = sampleSubset([1,2,3,4,5,6,7,8,9,10], 4);
  ok(sub.every((x) => [1,2,3,4,5,6,7,8,9,10].includes(x)) && new Set(sub).size === 4, 'подмножество без дублей и из исходных');

  // ── clientKey учитывает x-forwarded-for ──
  ok(clientKey({ headers: { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' }, socket: {} }) === '9.9.9.9', 'clientKey берёт первый XFF');

  // ── Приватный (bridge) узел: НЕ в реестре, НЕ в /registry/list ──
  const priv0 = startNode({ dataDir: dPriv, port: 8971, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:8971', private: true, gossip: false, heal: false, sweepMs: 3600000 });
  await sleep(150);
  ok(priv0.isPrivate === true, 'узел поднят в приватном режиме');
  ok(priv0.registry.size() === 0, 'приватный узел НЕ зарегистрировал себя в реестре');
  ok(priv0.ticket && priv0.ticket.relayId === priv0.identity.nodeId && priv0.ticket.sig, 'приватный узел отдаёт подписанный билет-мост');
  const lp = await (await fetch('http://127.0.0.1:8971/registry/list')).json();
  ok(Array.isArray(lp.records) && lp.records.length === 0, '/registry/list приватного узла пуст (его не выкачать)');

  // ── Публичный узел: /registry/list throttle + частичное представление ──
  const pub0 = startNode({ dataDir: dPub, port: 8972, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:8972', gossip: false, heal: false, sweepMs: 3600000, listPageMax: 3, listRate: { capacity: 8, refillPerSec: 0.1 } });
  await sleep(120);
  for (let i = 0; i < 10; i++) pub0.registry.upsert(makeRecord(mkId(), ['http://127.0.0.1:' + (9000 + i)]));
  const j1 = await (await fetch('http://127.0.0.1:8972/registry/list')).json();
  ok(j1.records.length <= 3 && j1.total >= 10 && j1.partial === true, 'листинг отдаёт лишь частичное подмножество (≤ pageMax), total раскрывает объём');

  // Быстрый перебор упирается в rate-limit (429) — цензору дорого выкачивать всё.
  let got429 = false;
  for (let i = 0; i < 20; i++) { const r = await fetch('http://127.0.0.1:8972/registry/list'); if (r.status === 429) { got429 = true; break; } }
  ok(got429, 'частые запросы листинга упираются в rate-limit (429)');

  priv0.stop(); pub0.stop();
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  for (const d of [dPriv, dPub]) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
