// directory-6a.mjs — Фаза 6a: серверы узнают ключи/адреса друг друга через ДИРЕКТОРИЮ на
// тайнике (без конфиг-ключей и без прямого доступа к discovery). + peer-exchange узлов.
import { startNode } from '../../deaddrop/src/node.js';
import { DeaddropFed, loadServerIdentity, publicKeys, makeServerRecord } from '../src/deaddrop-fed.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nd1 = mkdtempSync(join(tmpdir(), 'n1-')), nd2 = mkdtempSync(join(tmpdir(), 'n2-'));
const dA = mkdtempSync(join(tmpdir(), 'sA-')), dB = mkdtempSync(join(tmpdir(), 'sB-'));
const N1 = 'http://127.0.0.1:8981', N2 = 'http://127.0.0.1:8982';
const node1 = startNode({ dataDir: nd1, port: 8981, host: '127.0.0.1', publicUrl: N1, gossip: false, heal: false, sweepMs: 3600000 });
const node2 = startNode({ dataDir: nd2, port: 8982, host: '127.0.0.1', publicUrl: N2, gossip: false, heal: false, sweepMs: 3600000 });
await sleep(200);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

try {
  const idA = loadServerIdentity(join(dA, 'srv.json'));
  const idB = loadServerIdentity(join(dB, 'srv.json'));
  const received = [];
  // ВАЖНО: resolvePubkeys НЕ задаём (null) и deaddropKeys нет — ключи ТОЛЬКО из директории.
  const cacheA = join(dA, 'peers.json'), cacheB = join(dB, 'peers.json');
  const fedA = new DeaddropFed({ identity: idA, domain: 'a.invalid', seeds: [N1], ownEndpoints: ['https://a.invalid'], peersCachePath: cacheA });
  const fedB = new DeaddropFed({ identity: idB, domain: 'b.invalid', seeds: [N1], ownEndpoints: ['https://b.invalid'], peersCachePath: cacheB, onReceive: (p, b, f) => received.push({ p, b, f }) });

  // Обмен директорией через узел: каждый анонсит себя и тянет чужих.
  await fedA.syncDirectory();
  await fedB.syncDirectory();
  await fedA.syncDirectory(); // второй проход — A теперь увидит B

  ok(fedA.serverDir.has('b.invalid'), 'A узнал сервер B через директорию тайника (без конфига/discovery)');
  const bk = fedA.serverDir.get('b.invalid');
  ok(bk && bk.keys.ed === idB.edPubHex && bk.keys.x === idB.xPubHex, 'ключи B в директории совпадают с настоящими');
  ok(bk.endpoints && bk.endpoints[0] === 'https://b.invalid', 'адрес B тоже узнан из директории');

  // Доставка A→B по ключам ИЗ ДИРЕКТОРИИ (resolveFallback вернул бы null).
  const r = await fedA.send('b.invalid', '/_prizrak/federation/v1/send', { to: 'bob:b.invalid', msgId: 'd1' });
  ok(r.ok && r.replicas >= 1, 'A отправил пакет B, взяв ключи из директории');
  const g = await fedB.pollOnce();
  ok(g.got === 1 && received.length === 1 && received[0].b.msgId === 'd1', 'B принял пакет (ключи разошлись через тайник)');

  // Подделка записи директории отклоняется узлом.
  const forged = { ...makeServerRecord(idB, 'evil.invalid', ['https://evil'], Date.now()), domain: 'evil.invalid', keys: { ed: idA.edPubHex, x: idA.xPubHex } };
  const jf = await (await fetch(N1 + '/directory/announce', { method: 'POST', body: JSON.stringify({ records: [forged] }) })).json();
  ok(jf.count === 0, 'подделанная запись сервера (чужие ключи/подпись) отвергнута узлом');

  // Peer-exchange узлов: node1 узнаёт node2 (кросс-реестр) → сервер учит node2 БЕЗ добавления в сиды.
  const recs = [node1.registry.list()[0], node2.registry.list()[0]];
  node1.registry.upsertMany(recs); node2.registry.upsertMany(recs); // как будто узлы сгоссипили
  const cnt = await fedA.refreshNodes();
  ok(cnt === 2, 'сервер узнал ВТОРОЙ узел через реестр первого (peer-exchange, без правки конфига)');
  ok(existsSync(cacheA), 'живой список узлов сохранён в кэш (переживёт рестарт, не конфиг)');

  // Живучесть: даже если сид (node1) исчезнет, сервер знает node2 из кэша и опросит его.
  const fedC = new DeaddropFed({ identity: idA, domain: 'a.invalid', seeds: [], peersCachePath: cacheA });
  ok(fedC.nodes.length === 2, 'новый экземпляр без сидов поднял живой список узлов из кэша');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  node1.stop(); node2.stop();
  for (const d of [nd1, nd2, dA, dB]) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
