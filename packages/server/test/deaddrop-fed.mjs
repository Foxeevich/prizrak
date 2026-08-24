// deaddrop-fed.mjs — сквозной тест федерации через тайники (Фаза 3):
// сервер A шлёт пакет серверу B через РЕАЛЬНЫЙ узел-тайник; B поллит, расшифровывает,
// переинжектит и подтверждает; блоб на узле удаляется. Узел не может прочитать пакет.
import { startNode } from '../../deaddrop/src/node.js';
import { DeaddropFed, loadServerIdentity, publicKeys, open } from '../src/deaddrop-fed.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nodeDir = mkdtempSync(join(tmpdir(), 'ddnode-'));
const dirA = mkdtempSync(join(tmpdir(), 'srvA-')), dirB = mkdtempSync(join(tmpdir(), 'srvB-'));
const NODE = 'http://127.0.0.1:8971';
const node = startNode({ dataDir: nodeDir, port: 8971, host: '127.0.0.1', publicUrl: NODE, gossip: false, heal: false, sweepMs: 3600000 });
await sleep(200);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

try {
  const idA = loadServerIdentity(join(dirA, 'srv.json'));
  const idB = loadServerIdentity(join(dirB, 'srv.json'));
  const keys = { 'a.org': publicKeys(idA), 'b.org': publicKeys(idB) };
  const resolvePubkeys = async (d) => keys[d] || null;

  const received = [];
  const fedA = new DeaddropFed({ identity: idA, domain: 'a.org', seeds: [NODE], rf: 4, resolvePubkeys });
  const fedB = new DeaddropFed({ identity: idB, domain: 'b.org', seeds: [NODE], rf: 4, resolvePubkeys, onReceive: (path, body, from) => { received.push({ path, body, from }); } });

  ok((await fedA.refreshNodes()) === 1, 'сервер видит узел-тайник через реестр');

  // Отправка неизвестному (нет ключа) — отклоняется.
  ok((await fedA.send('zzz.org', '/x', {})).ok === false, 'send без ключа получателя отклонён');

  // A → B через тайник.
  const env = { to: 'bob:b.org', from: 'alice:a.org', msgId: 'm-123', type: 'message', ciphertext: 'E2E…' };
  const r = await fedA.send('b.org', '/_prizrak/federation/v1/send', env);
  ok(r.ok && r.replicas >= 1, `A разложил пакет по тайнику (${r.replicas} реплик)`);

  // Узел хранит зашифрованный блоб и НЕ может его прочитать (расшифровка только ключом B).
  const h1 = await (await fetch(NODE + '/dd/health')).json();
  ok(h1.blobs >= 1, 'на узле лежит зашифрованный блоб');
  const rawBlob = new Uint8Array(await (await fetch(NODE + '/dd/get/' + r.msgId)).arrayBuffer());
  let leaked = false; try { JSON.parse(Buffer.from(rawBlob).toString()); leaked = true; } catch {}
  ok(!leaked, 'сырой блоб на узле — не читаемый JSON (зашифрован)');
  let wrongKeyFail = false; try { open(idA.xPriv, rawBlob); } catch { wrongKeyFail = true; }
  ok(wrongKeyFail, 'чужим ключом (A) блоб не расшифровывается');

  // B поллит → принимает, переинжектит, подтверждает.
  const got = await fedB.pollOnce();
  ok(got.got === 1, 'B забрал 1 пакет из своего ящика');
  ok(received.length === 1 && received[0].path === '/_prizrak/federation/v1/send' && received[0].from === 'a.org', 'B переинжектил правильный path и from');
  ok(received[0].body && received[0].body.msgId === 'm-123' && received[0].body.to === 'bob:b.org', 'тело конверта дошло без искажений');

  await sleep(100);
  const h2 = await (await fetch(NODE + '/dd/health')).json();
  ok(h2.blobs === 0 && h2.acks >= 1, 'после ACK от B блоб удалён с узла (доставлено)');

  // Повторный поллинг B — пусто (уже доставлено/удалено).
  ok((await fedB.pollOnce()).got === 0, 'повторный поллинг B пуст');

  // Чужой сервер (A) со своим ящиком ничего не видит (слепой ящик).
  ok((await fedA.pollOnce()).got === 0, 'A в своём ящике пакета для B не видит');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  node.stop();
  for (const d of [nodeDir, dirA, dirB]) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
