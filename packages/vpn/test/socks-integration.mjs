// socks-integration.mjs — SOCKS5-клиент → реле → выход → назначение, по сокетам.
// Доказывает, что «прокси-режим» реально гоняет трафик приложения через цепочку.

import net from 'node:net';
import { createRelay } from '../src/relay-node.js';
import { createExit } from '../src/exit-node.js';
import { createSocks } from '../src/socks.js';
import { generateNodeKeys } from '../src/shadow.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const listen = (srv, port = 0) => new Promise((r) => srv.listen(port, '127.0.0.1', r));

async function main() {
  // Назначение: эхо-сервер + «HTTP»-подобный ответ.
  const dest = net.createServer((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('ECHO:'), d]))));
  await listen(dest); const destPort = dest.address().port;

  const ek = generateNodeKeys(); const exit = createExit({ keys: ek, allowPrivate: true });
  await listen(exit.server); const exitPort = exit.server.address().port;
  const rk = generateNodeKeys();
  const relay = createRelay({ keys: rk, exits: [{ id: 'e', host: '127.0.0.1', port: exitPort, pub: ek.publicKey }] });
  await listen(relay.server); const relayPort = relay.server.address().port;

  const socks = createSocks({
    relay: { host: '127.0.0.1', port: relayPort, pub: rk.publicKey },
    exit: { host: '127.0.0.1', port: exitPort, pub: ek.publicKey },
    port: 0,
  });
  await new Promise((r) => socks.server.listen(0, '127.0.0.1', r));
  const socksPort = socks.server.address().port;
  ok(true, `SOCKS слушает 127.0.0.1:${socksPort}`);

  // SOCKS5-клиент: приветствие → CONNECT(dest) → данные.
  const answer = await socksRequest(socksPort, '127.0.0.1', destPort, 'привет-через-socks');
  ok(answer.includes('ECHO:привет-через-socks'), 'трафик приложения прошёл через SOCKS→реле→выход→назначение и вернулся');

  // Вторая независимая цепочка (каждое соединение — свой туннель).
  const answer2 = await socksRequest(socksPort, '127.0.0.1', destPort, 'второе-соединение');
  ok(answer2.includes('ECHO:второе-соединение'), 'второе соединение через ту же прокси-точку работает независимо');

  dest.close(); relay.close(); exit.close(); socks.close();
  console.log(`\n«SOCKS-клиент»: ${pass} ок, ${fail} провалов`);
  process.exit(fail ? 1 : 0);
}

// Минимальный SOCKS5-клиент: коннект, greeting, connect-запрос, обмен.
function socksRequest(socksPort, host, port, payload) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: socksPort });
    let stage = 0, out = '';
    const to = setTimeout(() => { try { s.destroy(); } catch {} resolve(out); }, 15000);
    s.on('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])));   // greeting: v5, 1 method, no-auth
    s.on('data', (d) => {
      if (stage === 0) {                       // выбор метода
        const hb = host.split('.').map(Number);
        const req = Buffer.from([0x05, 0x01, 0x00, 0x01, ...hb, (port >> 8) & 0xff, port & 0xff]);
        s.write(req); stage = 1; return;
      }
      if (stage === 1) {                       // ответ на CONNECT (10 байт), дальше — данные
        if (d[1] !== 0x00) { clearTimeout(to); s.destroy(); return reject(new Error('SOCKS отказал: ' + d[1])); }
        s.write(Buffer.from(payload, 'utf8')); stage = 2;
        if (d.length > 10) out += d.slice(10).toString('utf8');
        return;
      }
      out += d.toString('utf8');
      if (out.includes('ECHO:' + payload)) { clearTimeout(to); s.end(); resolve(out); }
    });
    s.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
