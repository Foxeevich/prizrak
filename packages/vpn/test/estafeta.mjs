// estafeta.mjs — тест двух прыжков и слоистого шифрования.
//
// Собираем полную луковицу в памяти: клиент ↔ реле ↔ выход. Проверяем не только
// «данные дошли», но и приватность: реле не может прочитать назначение, выход не
// видит клиента, ключи сессий разделены.

import { openCircuit, makeRelayPump, makeExitEnd, OP, packCtrl, readCtrl } from '../src/estafeta.js';
import { generateNodeKeys, clientHandshake, nodeHandshake, clientComplete } from '../src/shadow.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const utf8 = (s) => new TextEncoder().encode(s);
const str = (u8) => new TextDecoder().decode(u8);

// ── Три узла ──────────────────────────────────────────────────────────────────
const relay = generateNodeKeys();   // приманка в РФ
const exit = generateNodeKeys();    // выход за границей
const relaySeen = new Map(), exitBseen = new Map(), exitCseen = new Map();

// Что реально «увидел» выход в открытом виде — сюда сложим, чтобы проверить,
// что там нет ничего про клиента. И что реле переслало вслепую.
let exitSawPlaintext = null;
let relayForwarded = null;   // непрозрачный кадр C, который реле переслало
const exitEnd = makeExitEnd({
  exitPriv: exit.privateKey, seen: exitCseen,
  openUpstream: async (app) => { exitSawPlaintext = str(app); return utf8('200 OK от ' + str(app).split(' ')[1]); },
});

// Сессия B (реле↔выход) — тоже «Тень». Реле поднимает её, дозваниваясь до выхода.
function dialExitFactory() {
  // Реле как клиент к выходу:
  const b = clientHandshake(exit.publicKey);
  // Выход как узел принимает B:
  const bNode = nodeHandshake(exit.privateKey, b.message, { seen: exitBseen });
  const relaySideB = clientComplete(b.state, bNode.reply); // реле↔выход у реле
  const exitSideB = bNode.session;                          // реле↔выход у выхода

  return async ({ host, port }) => ({
    // Прокинуть внутреннее рукопожатие C к выходу через B (реле не читает C).
    async sendInnerHandshake(innerMsg) {
      const overB = relaySideB.seal(innerMsg);              // реле заворачивает в B
      const got = exitSideB.open(overB);                    // выход разворачивает B → сырой C-хендшейк
      const cReply = exitEnd.innerHandshake(got, { nowSec: Math.floor(Date.now() / 1000) });
      return relaySideB.open(exitSideB.seal(cReply));       // ответ C назад через B
    },
    // Переслать непрозрачный кадр C туда-обратно.
    async forward(innerCt) {
      relayForwarded = innerCt;                             // ровно то, что доступно реле
      const overB = relaySideB.seal(innerCt);
      const atExit = exitSideB.open(overB);                 // выход достаёт кадр C (но не его содержимое до onData)
      const reply = await exitEnd.onData(atExit);
      return relaySideB.open(exitSideB.seal(reply));
    },
    close() {},
    _relaySideB: relaySideB, _exitSideB: exitSideB, _bNode: bNode,
  });
}

// ── Поднимаем цепочку ─────────────────────────────────────────────────────────
const circuit = openCircuit({
  relayPub: relay.publicKey, exitPub: exit.publicKey,
  exitAddr: { host: 'exit.example', port: 443 },
});

// 1) Клиент → реле: внешнее рукопожатие A (через «Личину» реле)
const aNode = nodeHandshake(relay.privateKey, circuit.outerHandshake, { seen: relaySeen });
ok(aNode.ok, 'реле приняло внешнее рукопожатие (сессия A)');
const sessA_relay = aNode.session;
const linkSealed = circuit.onOuterReply(aNode.reply);   // клиент достроил A и шлёт LINK

// 2) Реле обрабатывает LINK: дозванивается до выхода, прокидывает рукопожатие C
const relayPump = makeRelayPump({ sessA: sessA_relay, dialExit: dialExitFactory() });
const linkOk = await relayPump.onClientFrame(linkSealed);
ok(relayPump.linkedExit().host === 'exit.example', 'реле знает адрес ВЫХОДА (это неизбежно и нормально)');

// 3) Клиент достраивает сквозную сессию C
ok(circuit.onLinkOk(linkOk) === true, 'клиент достроил сквозную сессию C с выходом');
ok(circuit._debug().hasC, 'у клиента есть сессия C');

// ── Данные насквозь ───────────────────────────────────────────────────────────
const req = circuit.send(utf8('GET https://secret-destination.example/page'));
const backSealed = await relayPump.onClientFrame(req);
const answer = circuit.recv(backSealed);
ok(str(answer) === '200 OK от https://secret-destination.example/page', 'запрос дошёл до выхода и ответ вернулся клиенту');
ok(exitSawPlaintext === 'GET https://secret-destination.example/page', 'назначение видит ТОЛЬКО выход');

// ── Приватность: что видит реле ───────────────────────────────────────────────
// Реле расшифровало A и переслало внутренний кадр C вслепую. В том, что ему
// доступно, открытого назначения быть не должно — это шифртекст сессии C.
ok(relayForwarded && relayForwarded.length > 0, 'реле реально что-то переслало');
ok(!str(relayForwarded).includes('secret-destination'),
  'в доступном реле кадре назначения НЕТ (шифртекст сессии C)');
// Реле физически не может открыть C: у него только ключи сессии A. Его же
// настоящая сессия A внутренний C-кадр не расшифрует.
let relayCantRead = false;
try { sessA_relay.open(relayForwarded); } catch { relayCantRead = true; }
ok(relayCantRead, 'реле не может расшифровать внутренний кадр (нет ключей сессии C)');

// ── Приватность: что видит выход ──────────────────────────────────────────────
// Ни в одном кадре, доходящем до выхода, нет сетевого адреса клиента: в LINK
// есть только адрес ВЫХОДА и внутреннее рукопожатие, в DATA — шифртекст C.
// Проверяем структуру LINK на свежесобранном кадре (счётчики не трогаем).
const freshCircuit = openCircuit({ relayPub: relay.publicKey, exitPub: exit.publicKey, exitAddr: { host: 'exit.example', port: 443 } });
const aN2 = nodeHandshake(relay.privateKey, freshCircuit.outerHandshake, { seen: new Map() });
const linkFrame = freshCircuit.onOuterReply(aN2.reply);
const linkSeen = JSON.parse(new TextDecoder().decode(readCtrl(aN2.session.open(linkFrame)).body));
ok('exit' in linkSeen && 'hs' in linkSeen, 'LINK несёт адрес выхода и рукопожатие');
ok(!('ip' in linkSeen) && !('client' in linkSeen) && !('addr' in linkSeen), 'в LINK нет адреса клиента — выходу его взять неоткуда');

// ── Стойкость: подмена внешнего рукопожатия ───────────────────────────────────
const tampered = new Uint8Array(circuit.outerHandshake); tampered[40] ^= 0xff;
ok(!nodeHandshake(relay.privateKey, tampered, { seen: new Map() }).ok, 'подмена внешнего рукопожатия ломает A');

// ── Повтор LINK (перехваченного) не открывает второй канал ────────────────────
// Тот же outerHandshake, поданный повторно на реле — антиповтор «Тени».
ok(!nodeHandshake(relay.privateKey, circuit.outerHandshake, { seen: relaySeen }).ok,
  'повтор внешнего рукопожатия отвергнут (антиповтор)');

console.log(`\n«Эстафета»: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
