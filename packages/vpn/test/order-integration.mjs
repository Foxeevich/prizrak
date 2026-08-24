// order-integration.mjs — платный туннель по ордеру Банка, по настоящим сокетам.
// Узлы созданы с bankPub → пускают ТОЛЬКО по валидному ордеру. Проверяем, что
// оплаченный клиент проходит, а с плохим ордером — отказ.

import net from 'node:net';
import { createRelay } from '../src/relay-node.js';
import { createExit } from '../src/exit-node.js';
import { createSocks } from '../src/socks.js';
import { generateNodeKeys } from '../src/shadow.js';
import { orderBytes } from '../src/order.js';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));

// Банк подписывает ордер.
const bankSk = ed25519.utils.randomPrivateKey();
const bankPub = bytesToHex(ed25519.getPublicKey(bankSk));
function signOrder(o) { return { ...o, sig: bytesToHex(ed25519.sign(orderBytes(o), bankSk)) }; }

async function main() {
  const echo = net.createServer((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('ECHO:'), d]))));
  await listen(echo); const echoPort = echo.address().port;
  const ek = generateNodeKeys(); const exit = createExit({ keys: ek, bankPub, allowPrivate: true });
  await listen(exit.server); const exitPort = exit.server.address().port;
  const rk = generateNodeKeys(); const relay = createRelay({ keys: rk, bankPub });
  await listen(relay.server); const relayPort = relay.server.address().port;

  const mkOrder = (over = {}) => signOrder({
    v: 1, sub: 'fox:prizrak.im', country: 'FR', exp: Math.floor(Date.now() / 1000) + 3600,
    relay: { host: '127.0.0.1', port: relayPort, pub: rk.publicKey, id: 'r1' },
    exit: { host: '127.0.0.1', port: exitPort, pub: ek.publicKey, id: 'e1' },
    ...over,
  });

  // 1) Валидный ордер — туннель работает.
  const okOrder = mkOrder();
  const socks = createSocks({ order: okOrder, port: 0 });
  await new Promise((r) => socks.server.listen(0, '127.0.0.1', r));
  const got = await socksReq(socks.server.address().port, echoPort, 'оплачено');
  ok(got.includes('ECHO:оплачено'), 'оплаченный клиент (валидный ордер) прошёл через реле→выход');
  socks.close();

  // 2) Просроченный ордер — отказ (реле не пускает).
  const expired = mkOrder({ exp: 1 });
  const socks2 = createSocks({ order: expired, port: 0 });
  await new Promise((r) => socks2.server.listen(0, '127.0.0.1', r));
  const got2 = await socksReq(socks2.server.address().port, echoPort, 'просрочка');
  ok(!got2.includes('ECHO'), 'просроченный ордер отклонён — трафик не прошёл');
  ok(relay.stats.denied >= 1, 'реле засчитало отказ по ордеру');
  socks2.close();

  // 3) Подделанный ордер (подменили выход на чужой ключ) — подпись не сходится.
  const forged = mkOrder();
  forged.exit = { ...forged.exit, pub: generateNodeKeys().publicKey };  // ключ поменяли, sig не пересчитали
  const socks3 = createSocks({ order: forged, port: 0 });
  await new Promise((r) => socks3.server.listen(0, '127.0.0.1', r));
  const got3 = await socksReq(socks3.server.address().port, echoPort, 'подделка');
  ok(!got3.includes('ECHO'), 'подделанный ордер отклонён');
  socks3.close();

  echo.close(); relay.close(); exit.close();
  console.log(`\n«Ордер (платный туннель)»: ${pass} ок, ${fail} провалов`);
  process.exit(fail ? 1 : 0);
}

function socksReq(socksPort, destPort, payload) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: socksPort });
    let stage = 0, out = '';
    const to = setTimeout(() => { try { s.destroy(); } catch {} resolve(out); }, 5000);
    s.on('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])));
    s.on('data', (d) => {
      if (stage === 0) { s.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, (destPort >> 8) & 0xff, destPort & 0xff])); stage = 1; return; }
      if (stage === 1) { if (d[1] !== 0x00) { clearTimeout(to); s.destroy(); return resolve(out); } s.write(Buffer.from(payload, 'utf8')); stage = 2; if (d.length > 10) out += d.slice(10).toString(); return; }
      out += d.toString(); if (out.includes('ECHO:' + payload)) { clearTimeout(to); s.end(); resolve(out); }
    });
    s.on('error', () => { clearTimeout(to); resolve(out); });
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
