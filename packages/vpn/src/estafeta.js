// estafeta.js — «Эстафета»: два прыжка со слоистым шифрованием.
//
// Один прыжок — это «выход видит и кто ты, и куда идёшь». Мы разрываем связь
// между «кто» и «куда» вторым прыжком и луковичным шифрованием:
//
//   клиент(РФ) ──сессия A──► приманка/реле(РФ) ──сессия B──► выход(за границей) ──► сайт
//                └────────────────── сессия C (насквозь, клиент↔выход) ──────────────┘
//
// Три сессии «Тени», вложенные луковицей:
//   A: клиент ↔ реле      — то, что видит провайдер клиента (обычный сайт-личина).
//   B: реле  ↔ выход      — то, что видит провайдер реле (тоже обычный сайт).
//   C: клиент ↔ выход     — НАСТОЯЩИЙ туннель, едет ВНУТРИ A, потом внутри B.
//
// Кто что знает:
//   • реле  — IP клиента и адрес выхода. НЕ знает назначение и НЕ может прочесть C.
//   • выход — адрес назначения и IP реле. НЕ знает IP клиента.
//   • провайдеры на обоих плечах — только «человек ходит на сайт».
//
// Ключевое: реле пересылает кадры сессии C как непрозрачные байты. Ключей C у
// него нет — расшифровать нельзя даже теоретически.

import { clientHandshake, nodeHandshake, clientComplete } from './shadow.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Управляющие кадры внутри сессии A (клиент↔реле) ───────────────────────────
export const OP = {
  LINK: 0x01,     // клиент→реле: «свяжи меня с выходом X», + первое сообщение C
  LINK_OK: 0x02,  // реле→клиент: ответ выхода (эфемер C)
  LINK_FAIL: 0x03,
  DATA: 0x04,     // обе стороны: непрозрачный кадр сессии C (реле только пересылает)
  CLOSE: 0x05,
};

export function packCtrl(op, payload) {
  const body = payload == null ? new Uint8Array(0)
    : (payload instanceof Uint8Array ? payload : enc.encode(JSON.stringify(payload)));
  const out = new Uint8Array(1 + body.length);
  out[0] = op; out.set(body, 1);
  return out;
}
export function readCtrl(buf) {
  return { op: buf[0], body: buf.subarray(1) };
}
const asJson = (b) => { try { return JSON.parse(dec.decode(b)); } catch { return null; } };

// ── Клиент: строит цепочку ────────────────────────────────────────────────────
/**
 * Открыть двухпрыжковую цепочку.
 * Возвращает пошаговый строитель — транспорт (несущая/«Личина») снаружи.
 *
 * @param {object} p
 * @param {string} p.relayPub — публичный ключ реле (hex).
 * @param {string} p.exitPub  — публичный ключ выхода (hex).
 * @param {object} p.exitAddr — {host, port} выхода — это увидит реле, чтобы дозвониться.
 */
export function openCircuit({ relayPub, exitPub, exitAddr }) {
  // Внешнее рукопожатие с реле (сессия A).
  const a = clientHandshake(relayPub);
  let sessA = null;   // клиент↔реле
  let sessC = null;   // клиент↔выход (внутренняя)
  let innerState = null;

  return {
    /** То, что уходит на реле первым (через «Личину»): рукопожатие сессии A. */
    outerHandshake: a.message,

    /** Реле ответило на A — достраиваем A и готовим LINK с внутренним рукопожатием. */
    onOuterReply(reply) {
      sessA = clientComplete(a.state, reply);
      // Внутреннее рукопожатие с выходом (сессия C) — поедет ВНУТРИ A.
      const c = clientHandshake(exitPub);
      innerState = c.state;
      const link = packCtrl(OP.LINK, { exit: exitAddr, hs: [...c.message] });
      return sessA.seal(link);            // шифруем в A: провайдер клиента видит просто трафик к сайту
    },

    /** Реле принесло ответ выхода (LINK_OK) — достраиваем сквозную сессию C. */
    onLinkOk(sealedFromA) {
      const { op, body } = readCtrl(sessA.open(sealedFromA));
      if (op !== OP.LINK_OK) throw new Error('ожидали LINK_OK');
      const msg = asJson(body);
      sessC = clientComplete(innerState, Uint8Array.from(msg.hs));
      return true;
    },

    /** Данные приложения → наружу. Двойная упаковка: сперва C (для выхода), потом A (для провода). */
    send(appBytes) {
      if (!sessC) throw new Error('цепочка не готова');
      const inner = sessC.seal(appBytes);                 // видит только выход
      return sessA.seal(packCtrl(OP.DATA, inner));         // видит провод; реле — только пересылает inner
    },

    /** Пришло из сети (через реле) → данные приложения. */
    recv(sealedFromA) {
      const { op, body } = readCtrl(sessA.open(sealedFromA));
      if (op !== OP.DATA) return null;
      return sessC.open(body);                             // расшифровать может только клиент (ключи C)
    },

    _debug: () => ({ hasA: !!sessA, hasC: !!sessC }),
  };
}

// ── Реле: слепой пересыльщик ──────────────────────────────────────────────────
/**
 * Обработчик реле. Внешнюю сессию A даёт «Личина» (doorman). Дальше реле:
 *   • на LINK — дозванивается до выхода (dialExit) и прокидывает внутреннее
 *     рукопожатие, НЕ читая его;
 *   • на DATA — пересылает непрозрачные кадры C туда-обратно.
 *
 * @param {object} p
 * @param {object} p.sessA — сессия A (клиент↔реле) из doorman.
 * @param {function} p.dialExit — async ({host,port}) → канал к выходу:
 *     { sendToExit(bytes):Promise<replyBytes>, close() }.
 *     Канал сам поднимает сессию B (реле↔выход) через «Личину» выхода.
 */
export function makeRelayPump({ sessA, dialExit }) {
  let exitChan = null;
  let linkedExit = null;

  return {
    /** Обработать входящий кадр от клиента (уже расшифрованный из A снаружи? нет — сырой sealed). */
    async onClientFrame(sealedFromA) {
      const { op, body } = readCtrl(sessA.open(sealedFromA));

      if (op === OP.LINK) {
        const j = asJson(body);
        linkedExit = j.exit;                         // реле ЗНАЕТ адрес выхода — это неизбежно
        exitChan = await dialExit(j.exit);           // поднять сессию B к выходу
        // Прокинуть внутреннее рукопожатие C к выходу, не читая его.
        const exitReply = await exitChan.sendInnerHandshake(Uint8Array.from(j.hs));
        return sessA.seal(packCtrl(OP.LINK_OK, { hs: [...exitReply] }));
      }

      if (op === OP.DATA) {
        if (!exitChan) throw new Error('DATA до LINK');
        // body — кадр сессии C. Реле его НЕ расшифровывает: ключей нет.
        const back = await exitChan.forward(body);
        return back == null ? null : sessA.seal(packCtrl(OP.DATA, back));
      }

      if (op === OP.CLOSE) { exitChan && exitChan.close(); return null; }
      return null;
    },
    linkedExit: () => linkedExit,
  };
}

// ── Выход: конец цепочки ──────────────────────────────────────────────────────
/**
 * На выходе внешнюю сессию B (реле↔выход) поднимает его же «Личина». Внутри B
 * приходят: сперва внутреннее рукопожатие C, затем кадры данных C. Выход держит
 * сквозную сессию C с КЛИЕНТОМ (не с реле) и только он видит назначение.
 *
 * @param {string} exitPriv — приватный ключ выхода (hex).
 * @param {Map} seen — антиповтор.
 */
export function makeExitEnd({ exitPriv, seen = new Map(), openUpstream } = {}) {
  let sessC = null;                 // выход↔клиент (сквозная)
  let upstream = null;              // реальное соединение к назначению

  return {
    /** Пришло внутреннее рукопожатие C (реле переслало вслепую). */
    innerHandshake(innerMsg, { nowSec } = {}) {
      const r = nodeHandshake(exitPriv, innerMsg, { seen, nowSec });
      if (!r.ok) throw new Error('внутреннее рукопожатие не прошло: ' + r.reason);
      sessC = r.session;
      return r.reply;               // эфемер выхода — уедет клиенту через реле
    },

    /** Кадр данных C: расшифровать, выполнить, ответить (тоже в C). */
    async onData(innerCt) {
      if (!sessC) throw new Error('нет сессии C');
      const app = sessC.open(innerCt);              // ТОЛЬКО здесь виден открытый запрос
      const reply = openUpstream
        ? await openUpstream(app, (u) => { upstream = u; })
        : app;                                       // без реальной сети — эхо (для тестов)
      return sessC.seal(reply);
    },

    hasC: () => !!sessC,
  };
}
