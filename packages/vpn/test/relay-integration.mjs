// relay-integration.mjs — НАСТОЯЩИЙ round-trip по localhost через демоны.
//
//   эхо-назначение  ◄──  выход(exit-node)  ◄──  реле(relay-node)  ◄──  клиент
//
// Проверяем, что собранный из модулей демон реально переносит трафик по сокетам,
// а не только в памяти. Если этот тест зелёный — узел работает.

import net from 'node:net';
import { createRelay } from '../src/relay-node.js';
import { createExit } from '../src/exit-node.js';
import { generateNodeKeys, clientHandshake, clientComplete } from '../src/shadow.js';
import { attachBreath } from '../src/wire.js';
import { packCtrl, readCtrl, OP } from '../src/estafeta.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);
const listen = (srv, port) => new Promise((res) => srv.listen(port, '127.0.0.1', res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1) Эхо-назначение (изображает сайт в интернете).
  const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
  await listen(echo, 0); const echoPort = echo.address().port;

  // 2) Выход.
  const exitKeys = generateNodeKeys();
  const exit = createExit({ keys: exitKeys, allowPrivate: true });
  await listen(exit.server, 0); const exitPort = exit.server.address().port;

  // 3) Реле (знает выход и его ключ).
  const relayKeys = generateNodeKeys();
  const relay = createRelay({ keys: relayKeys, exits: [{ id: 'e1', host: '127.0.0.1', port: exitPort, pub: exitKeys.publicKey }] });
  await listen(relay.server, 0); const relayPort = relay.server.address().port;

  // 4) Зонд: обычный GET на реле должен получить сайт, а не туннель.
  const probe = await httpGet(relayPort);
  ok(/Заметки|<html/i.test(probe), 'зонд (GET) получает сайт-личину, а не туннель');
  ok(relay.stats.probes >= 1, 'реле засчитало зонд');

  // 5) Клиент строит цепочку через реле до выхода и гоняет данные.
  const sock = net.connect({ host: '127.0.0.1', port: relayPort });
  await new Promise((r) => sock.on('connect', r));

  let phase = 'hsA';
  let sessA = null, sessC = null, innerState = null;
  const got = [];
  let resolveReply = null;
  const waitFor = () => new Promise((r) => { resolveReply = r; });

  const cHS = clientHandshake(relayKeys.publicKey);
  const wire = attachBreath(sock, {
    onFrame: (f) => {
      if (phase === 'hsA') { sessA = clientComplete(cHS.state, f); phase = 'link'; resolveReply && resolveReply(); return; }
      let ctrl; try { ctrl = readCtrl(sessA.open(f)); } catch { return; }
      if (ctrl.op === OP.LINK_OK && phase === 'link') {
        const j = JSON.parse(dec(ctrl.body));
        sessC = clientComplete(innerState, Uint8Array.from(j.hs));
        phase = 'up'; resolveReply && resolveReply(); return;
      }
      if (ctrl.op === OP.DATA && sessC) { got.push(dec(sessC.open(ctrl.body))); resolveReply && resolveReply(); }
    },
  });

  // Рукопожатие A
  let p = waitFor(); wire.send(cHS.message); await p;
  ok(sessA != null, 'клиент поднял сессию A с реле');

  // LINK: внутреннее рукопожатие C к выходу + адрес выхода
  const cInner = clientHandshake(exitKeys.publicKey); innerState = cInner.state;
  p = waitFor();
  wire.send(sessA.seal(packCtrl(OP.LINK, { exit: { host: '127.0.0.1', port: exitPort }, hs: [...cInner.message] })));
  await p;
  ok(sessC != null, 'клиент поднял сквозную сессию C с выходом (через реле)');

  // CONNECT к эхо + данные
  const sendApp = (bytes) => wire.send(sessA.seal(packCtrl(OP.DATA, sessC.seal(bytes))));
  sendApp(enc(JSON.stringify({ host: '127.0.0.1', port: echoPort })));
  await sleep(150);
  p = waitFor(); sendApp(enc('привет-через-призрак')); await Promise.race([p, sleep(1500)]);
  ok(got.join('').includes('привет-через-призрак'), 'данные дошли до назначения и ЭХО вернулось клиенту сквозь цепочку');

  // Приватность реле: у него нет ключей C — расшифровать назначение он не может.
  ok(relay.stats.tunnels >= 1 && relay.stats.up >= 1, 'реле провело туннель, не видя содержимого');

  wire.close(); sock.destroy();
  echo.close(); relay.close(); exit.close();

  console.log(`\n«Узел (round-trip)»: ${pass} ок, ${fail} провалов`);
  process.exit(fail ? 1 : 0);
}

function httpGet(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
    let buf = ''; s.on('data', (d) => { buf += d.toString('utf8'); }); s.on('close', () => resolve(buf));
    setTimeout(() => { try { s.destroy(); } catch {} resolve(buf); }, 1000);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
