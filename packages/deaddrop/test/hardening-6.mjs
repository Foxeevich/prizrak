// hardening-6.mjs — Фаза 6 (базовая закалка): паддинг, PoW-admission, diversity по подписанной group.
import { padTo, unpad, bucketFor, powSolve, powVerify, jitterMs } from '../src/hardening.js';
import { startNode } from '../src/node.js';
import { placement } from '../src/placement.js';
import { Registry, makeRecord } from '../src/registry.js';
import { newKeypair, bytesToHex, msgIdOf, mailboxOf, randomBytes } from '../src/crypto.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const mkId = () => { const { priv, pub } = newKeypair(); return { priv, nodeId: bytesToHex(pub) }; };
const nd = mkdtempSync(join(tmpdir(), 'h6-')), rd = mkdtempSync(join(tmpdir(), 'reg-'));

try {
  // ── Паддинг: разные мелкие длины → одинаковое ведро (длина не утекает) ──
  const a = padTo(new TextEncoder().encode('hi'));
  const b = padTo(new TextEncoder().encode('a much longer but still small message'));
  ok(a.length === b.length && a.length === 256, 'два мелких сообщения → один размер (ведро 256), длина скрыта');
  ok(new TextDecoder().decode(unpad(a)) === 'hi', 'unpad восстанавливает исходные данные');
  ok(bucketFor(10) === 256 && bucketFor(300) === 512 && bucketFor(5000) === 16384, 'вёдра растут ступенями');
  const big = padTo(new Uint8Array(70000));
  ok(big.length === 262144, 'среднее сообщение попадает в следующее ведро (262144)');

  // ── PoW admission ──
  const msgId = 'abc123';
  const nonce = powSolve(msgId, 10);
  ok(powVerify(msgId, nonce, 10), 'найденный nonce проходит проверку PoW (10 бит)');
  ok(!powVerify(msgId, 'not-a-solution', 10), 'случайный nonce НЕ проходит PoW');
  ok(powVerify(msgId, '0', 0), 'при bits=0 PoW отключён (всегда true)');
  ok(jitterMs(100, 200) >= 100 && jitterMs(100, 200) <= 200, 'jitterMs в заданных границах');

  // ── PUT-гейт с PoW на реальном узле ──
  const node = startNode({ dataDir: nd, port: 8941, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:8941', gossip: false, heal: false, sweepMs: 3600000, powBits: 10 });
  await sleep(150);
  const h = await (await fetch('http://127.0.0.1:8941/dd/health')).json();
  ok(h.powBits === 10, 'узел объявляет требуемый PoW в /dd/health');
  const ct = randomBytes(64);
  const mid = msgIdOf(ct);
  const mailbox = mailboxOf(mkId().nodeId, 20000);
  const putHeaders = (extra) => ({ 'x-dd-msgid': mid, 'x-dd-mailbox': mailbox, 'x-dd-epoch': '20000', 'x-dd-expiry': String(Date.now() + 86400000), ...extra });
  const noPow = await fetch('http://127.0.0.1:8941/dd/put', { method: 'PUT', headers: putHeaders({}), body: Buffer.from(ct) });
  const jn = await noPow.json();
  ok(jn.ok === false && jn.reason === 'pow', 'PUT без PoW отвергнут (reason:pow)');
  const good = await fetch('http://127.0.0.1:8941/dd/put', { method: 'PUT', headers: putHeaders({ 'x-dd-pow': powSolve(mid, 10) }), body: Buffer.from(ct) });
  ok((await good.json()).ok === true, 'PUT с валидным PoW принят');
  node.stop();

  // ── Diversity по ПОДПИСАННОЙ group (anti-Sybil) ──
  const reg = new Registry(join(rd, 'r.json'));
  const op1a = mkId(), op1b = mkId(), op2 = mkId();
  reg.upsert(makeRecord(op1a, ['http://a1:8820'], undefined, 'op1'));
  reg.upsert(makeRecord(op1b, ['http://a2:8820'], undefined, 'op1')); // тот же оператор (сибил)
  reg.upsert(makeRecord(op2, ['http://b1:8820'], undefined, 'op2'));
  const nodes = reg.nodes();
  ok(nodes.every((n) => ['op1', 'op2'].includes(n.group)), 'группы взяты из ПОДПИСАННЫХ записей');
  const target = placement('some-msg-id', nodes, 2);
  const gset = new Set(target.map((rid) => nodes.find((n) => n.relayId === rid).group));
  ok(target.length === 2 && gset.size === 2, 'размещение выбрало 2 РАЗНЫХ домена отказа (сибил-узлы одного оператора не занимают обе копии)');

  // Подпись покрывает group: подмена метки ломает проверку.
  const rec = makeRecord(op1a, ['http://a1:8820'], undefined, 'op1');
  const tampered = { ...rec, group: 'op2' };
  ok(reg.upsert(tampered) === false, 'подмена group в подписанной записи отвергнута');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  for (const d of [nd, rd]) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
