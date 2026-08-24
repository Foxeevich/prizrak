// bridges-6c.mjs — Фаза 6c: приватные bridge-узлы на стороне сервера.
// Мост НЕ виден в общем реестре, раздаётся билетом доверенным серверам; доставка A→B идёт
// ЧЕРЕЗ приватный мост (публичных узлов нет вовсе), а ключи/директория тоже разносятся мостом.
import { startNode } from '../../deaddrop/src/node.js';
import { DeaddropFed, loadServerIdentity, verifyBridgeTicket } from '../src/deaddrop-fed.js';
import { newKeypair, bytesToHex } from '../../deaddrop/src/crypto.js';
import { makeRecord } from '../../deaddrop/src/registry.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const mkId = () => { const { priv, pub } = newKeypair(); return { priv, nodeId: bytesToHex(pub) }; };

const nb = mkdtempSync(join(tmpdir(), 'brg-'));
const dA = mkdtempSync(join(tmpdir(), 'sA-')), dB = mkdtempSync(join(tmpdir(), 'sB-'));
const BR = 'http://127.0.0.1:8991';
// Приватный (bridge) узел: себя в реестр не пишет.
const bridge = startNode({ dataDir: nb, port: 8991, host: '127.0.0.1', publicUrl: BR, private: true, gossip: false, heal: false, sweepMs: 3600000 });
await sleep(180);

try {
  ok(bridge.registry.size() === 0, 'мост не зарегистрировал себя (в общий реестр не попадёт)');
  const ticket = bridge.ticket;
  ok(verifyBridgeTicket(ticket), 'билет-мост проходит проверку подписи');

  // Подделка билета (чужой relayId) отвергается.
  const forged = { ...ticket, relayId: mkId().nodeId };
  ok(!verifyBridgeTicket(forged), 'подделанный билет (чужой relayId) отвергнут');

  const idA = loadServerIdentity(join(dA, 'srv.json'));
  const idB = loadServerIdentity(join(dB, 'srv.json'));
  const received = [];
  const brCacheA = join(dA, 'bridges.json');
  // seeds ПУСТЫЕ — публичных узлов нет. Оба сервера получили ОДИН И ТОТ ЖЕ мост билетом.
  const fedA = new DeaddropFed({ identity: idA, domain: 'a.invalid', seeds: [], bridges: [ticket], ownEndpoints: ['https://a.invalid'], peersCachePath: join(dA, 'peers.json'), bridgesCachePath: brCacheA });
  const fedB = new DeaddropFed({ identity: idB, domain: 'b.invalid', seeds: [], bridges: [ticket], ownEndpoints: ['https://b.invalid'], peersCachePath: join(dB, 'peers.json'), bridgesCachePath: join(dB, 'bridges.json'), onReceive: (p, b, f) => received.push({ p, b, f }) });

  const n = await fedA.refreshNodes();
  ok(n === 1 && fedA.nodes[0].relayId === ticket.relayId, 'сервер включил приватный мост в набор узлов (без реестра/сидов)');

  // Директория серверов разносится ЧЕРЕЗ мост.
  await fedA.syncDirectory(); await fedB.syncDirectory(); await fedA.syncDirectory();
  ok(fedA.serverDir.has('b.invalid'), 'ключи сервера B узнаны через приватный мост (без discovery/конфига)');

  // Доставка A→B строго через приватный мост.
  const r = await fedA.send('b.invalid', '/_prizrak/federation/v1/send', { to: 'bob:b.invalid', msgId: 'brg1' });
  ok(r.ok && r.replicas >= 1, 'A отправил пакет через приватный мост');
  const g = await fedB.pollOnce();
  ok(g.got === 1 && received.length === 1 && received[0].b.msgId === 'brg1', 'B принял пакет через приватный мост');

  // addBridges: дедуп по relayId и приём формата {relayId, endpoint}.
  const before = fedA.bridges.length;
  const add0 = fedA.addBridges([ticket]);
  ok(add0 === 0 && fedA.bridges.length === before, 'повторный билет того же моста не дублируется');
  const extra = mkId();
  const add1 = fedA.addBridges([{ relayId: extra.nodeId, endpoint: 'http://127.0.0.1:8992' }]);
  ok(add1 === 1 && fedA.bridges.some((b) => b.relayId === extra.nodeId), 'мост в формате {relayId,endpoint} добавлен');
  const add2 = fedA.addBridges([forged]);
  ok(add2 === 0, 'подделанный билет-мост отклонён addBridges');

  // Кэш мостов переживает рестарт: новый экземпляр без bridges-параметра поднимает мост из кэша.
  const fedC = new DeaddropFed({ identity: idA, domain: 'a.invalid', seeds: [], bridgesCachePath: brCacheA });
  ok(existsSync(brCacheA) && fedC.bridges.some((b) => b.relayId === ticket.relayId), 'приватные мосты подняты из кэша (переживают рестарт, не конфиг)');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  bridge.stop();
  for (const d of [nb, dA, dB]) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
