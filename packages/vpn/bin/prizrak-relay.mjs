#!/usr/bin/env node
// prizrak-relay.mjs — запуск промежуточного узла (реле) «Призрак-Транспорта».
//
// Команды:
//   prizrak-relay genkey                 — сгенерировать ключи узла
//   prizrak-relay start [config.json]    — запустить реле
//   prizrak-relay selftest               — проверить сборку локально (эхо-round-trip)
//
// Конфиг (config.json):
//   {
//     "port": 8443,               // порт, который слушает реле
//     "host": "0.0.0.0",
//     "keys": { "privateKey": "...", "publicKey": "..." },
//     "exits": [                  // разрешённые выходы (куда форвардим)
//       { "id": "fr-1", "host": "203.0.113.10", "port": 8443, "pub": "<hex X25519>" }
//     ]
//   }

import fs from 'node:fs';
import net from 'node:net';
import { generateNodeKeys, clientHandshake, clientComplete } from '../src/shadow.js';
import { createRelay } from '../src/relay-node.js';
import { createExit } from '../src/exit-node.js';
import { attachBreath } from '../src/wire.js';
import { packCtrl, readCtrl, OP } from '../src/estafeta.js';

const [cmd, arg] = process.argv.slice(2);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[${now()}] ${m}`);

if (cmd === 'genkey') {
  const k = generateNodeKeys();
  console.log(JSON.stringify(k, null, 2));
  process.exit(0);
}

if (cmd === 'start') {
  const path = arg || 'config.json';
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { console.error('Не читается конфиг ' + path + ': ' + e.message); process.exit(1); }
  if (!cfg.keys || !cfg.keys.privateKey) { console.error('В конфиге нет keys.privateKey — сгенерируйте: prizrak-relay genkey'); process.exit(1); }

  const relay = createRelay({ keys: cfg.keys, exits: cfg.exits || [], log });
  const port = cfg.port || 8443, host = cfg.host || '0.0.0.0';
  relay.listen(port, host, () => {
    log(`реле слушает ${host}:${port}`);
    log(`публичный ключ узла: ${cfg.keys.publicKey}`);
    log(`разрешённых выходов: ${(cfg.exits || []).length}`);
    if (!(cfg.exits || []).length) log('⚠ выходы не заданы — реле обслуживает только сайт-личину; форвардить некуда');
  });
  // Периодически печатаем статистику — видно, что узел живёт.
  setInterval(() => log(`статистика: соединений ${relay.stats.conns}, туннелей ${relay.stats.tunnels}, зондов ${relay.stats.probes}`), 300000);
  process.on('SIGTERM', () => { log('останов'); relay.close(() => process.exit(0)); });
  process.on('SIGINT', () => { log('останов'); relay.close(() => process.exit(0)); });
}

else if (cmd === 'selftest') {
  // Локальная проверка: поднимаем эхо + выход + реле на 127.0.0.1 и гоняем данные
  // сквозь всю цепочку. Ничего наружу не ходит — проверяем именно сборку узла.
  selftest().then((okAll) => {
    console.log(okAll ? '\n✅ Самопроверка пройдена: узел собирает и переносит трафик.' : '\n❌ Самопроверка не прошла.');
    process.exit(okAll ? 0 : 1);
  });
}

else {
  console.log('Использование:\n  prizrak-relay genkey\n  prizrak-relay start [config.json]\n  prizrak-relay selftest');
  process.exit(cmd ? 1 : 0);
}

async function selftest() {
  const enc = (s) => new TextEncoder().encode(s), dec = (u) => new TextDecoder().decode(u);
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
  await listen(echo); const echoPort = echo.address().port;
  const ek = generateNodeKeys(); const exit = createExit({ keys: ek, allowPrivate: true });
  await listen(exit.server); const exitPort = exit.server.address().port;
  const rk = generateNodeKeys();
  const relay = createRelay({ keys: rk, exits: [{ id: 'self', host: '127.0.0.1', port: exitPort, pub: ek.publicKey }] });
  await listen(relay.server); const relayPort = relay.server.address().port;

  log(`эхо :${echoPort}, выход :${exitPort}, реле :${relayPort}`);

  const sock = net.connect({ host: '127.0.0.1', port: relayPort });
  await new Promise((r) => sock.on('connect', r));
  let phase = 'hsA', sessA = null, sessC = null, innerState = null; const got = [];
  let wake = null; const waitFor = () => new Promise((r) => { wake = r; });
  const cHS = clientHandshake(rk.publicKey);
  const wire = attachBreath(sock, { onFrame: (f) => {
    if (phase === 'hsA') { sessA = clientComplete(cHS.state, f); phase = 'link'; wake && wake(); return; }
    let ctrl; try { ctrl = readCtrl(sessA.open(f)); } catch { return; }
    if (ctrl.op === OP.LINK_OK) { sessC = clientComplete(innerState, Uint8Array.from(JSON.parse(dec(ctrl.body)).hs)); phase = 'up'; wake && wake(); return; }
    if (ctrl.op === OP.DATA && sessC) { got.push(dec(sessC.open(ctrl.body))); wake && wake(); }
  } });

  let p = waitFor(); wire.send(cHS.message); await p;
  const ci = clientHandshake(ek.publicKey); innerState = ci.state;
  p = waitFor(); wire.send(sessA.seal(packCtrl(OP.LINK, { exit: { host: '127.0.0.1', port: exitPort }, hs: [...ci.message] }))); await p;
  const send = (b) => wire.send(sessA.seal(packCtrl(OP.DATA, sessC.seal(b))));
  send(enc(JSON.stringify({ host: '127.0.0.1', port: echoPort }))); await sleep(150);
  p = waitFor(); send(enc('prizrak-selftest-ping')); await Promise.race([p, sleep(1500)]);

  const okAll = got.join('').includes('prizrak-selftest-ping');
  log(okAll ? 'эхо вернулось сквозь реле+выход' : 'ответ не получен');
  wire.close(); sock.destroy(); echo.close(); relay.close(); exit.close();
  return okAll;
}
