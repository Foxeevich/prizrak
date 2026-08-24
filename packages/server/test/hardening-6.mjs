// hardening-6.mjs — Фаза 6 на стороне сервера: паддинг скрывает длину, PoW-admission в send.
import { startNode } from '../../deaddrop/src/node.js';
import { DeaddropFed, loadServerIdentity } from '../src/deaddrop-fed.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const nd = mkdtempSync(join(tmpdir(), 'sh-'));
const dA = mkdtempSync(join(tmpdir(), 'sA-')), dB = mkdtempSync(join(tmpdir(), 'sB-'));
const N = 'http://127.0.0.1:8931';
const node = startNode({ dataDir: nd, port: 8931, host: '127.0.0.1', publicUrl: N, gossip: false, heal: false, sweepMs: 3600000, powBits: 10 });
await sleep(180);

try {
  const idA = loadServerIdentity(join(dA, 'srv.json'));
  const idB = loadServerIdentity(join(dB, 'srv.json'));
  const bk = { ed: idB.edPubHex, x: idB.xPubHex };
  const received = [];
  const fedA = new DeaddropFed({ identity: idA, domain: 'a.invalid', seeds: [N], powBits: 10, peersCachePath: join(dA, 'p.json'), resolvePubkeys: async () => bk });
  const fedB = new DeaddropFed({ identity: idB, domain: 'b.invalid', seeds: [N], peersCachePath: join(dB, 'p.json'), onReceive: (p, b, f) => received.push({ p, b, f }) });

  // Паддинг: короткое и заметно более длинное (но в пределах одного ведра) сообщения → блобы РАВНОЙ длины.
  const r1 = await fedA.send('b.invalid', '/p', { to: 'bob:b.invalid', msgId: 'm1', note: 'hi' });
  const r2 = await fedA.send('b.invalid', '/p', { to: 'bob:b.invalid', msgId: 'm2', note: 'x'.repeat(120) });
  ok(r1.ok && r2.ok, 'оба сообщения отправлены через узел с PoW (nonce приложен автоматически)');
  const b1 = new Uint8Array(await (await fetch(N + '/dd/get/' + r1.msgId)).arrayBuffer());
  const b2 = new Uint8Array(await (await fetch(N + '/dd/get/' + r2.msgId)).arrayBuffer());
  ok(b1.length === b2.length, `блобы разного по длине текста РАВНЫ (${b1.length}Б) — длина сообщения скрыта паддингом`);

  // Доставка с паддингом прозрачна: B получает и корректно разбирает.
  const g = await fedB.pollOnce();
  ok(g.got === 2 && received.length === 2, 'B принял оба (unpad прозрачен на приёме)');
  ok(received.some((x) => x.b.note === 'hi') && received.some((x) => x.b.note.length === 120), 'полезная нагрузка восстановлена точно (паддинг снят)');

  // PoW обязателен: сервер БЕЗ PoW не может положить блоб на узел, требующий PoW.
  const fedNo = new DeaddropFed({ identity: idA, domain: 'a.invalid', seeds: [N], powBits: 0, peersCachePath: join(dA, 'p2.json'), resolvePubkeys: async () => bk });
  const rNo = await fedNo.send('b.invalid', '/p', { to: 'bob:b.invalid', msgId: 'm3' });
  ok(rNo.replicas === 0, 'сервер без PoW не смог доставить на узел с обязательным PoW (флуд отсечён)');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  node.stop();
  for (const d of [nd, dA, dB]) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
