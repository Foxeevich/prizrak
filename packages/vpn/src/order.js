// order.js — «ордер на подключение», подписанный Банком.
//
// Клиент оплатил подписку → Банк выдал ордер: какой реле и выход использовать,
// до какого времени валидно, подпись Банка (Ed25519). Реле и выход проверяют
// подпись ЛОКАЛЬНО (знают публичный ключ Банка) — в Банк на каждое подключение
// не ходят. Так «оплачено» доказывается без раскрытия личности клиента узлам.
//
// Каноничная форма для подписи ДОЛЖНА совпадать с той, что подписал Банк (PHP
// json_encode с UNESCAPED_UNICODE|UNESCAPED_SLASHES, порядок ключей фиксирован).

import { ed25519 } from '@noble/curves/ed25519';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

/** Каноничные байты ордера (без поля sig), порядок ключей как в Банке. */
export function orderBytes(o) {
  const node = (n) => ({ host: n.host, port: n.port, pub: n.pub, id: n.id });
  const canon = { v: o.v, sub: o.sub, country: o.country, exp: o.exp, relay: node(o.relay), exit: node(o.exit) };
  return utf8ToBytes(JSON.stringify(canon));
}

/**
 * Проверить ордер: подпись Банка + срок + (опц.) что он про наш узел.
 * @param {object} order — {v,sub,country,exp,relay,exit,sig}
 * @param {string} bankPub — публичный ключ Банка (hex).
 * @param {object} opts — { nowSec, expectPub, role } expectPub: наш pub, role: 'relay'|'exit'.
 */
export function verifyOrder(order, bankPub, { nowSec = Math.floor(Date.now() / 1000), expectPub = null, role = null } = {}) {
  try {
    if (!order || !order.sig || !order.relay || !order.exit) return { ok: false, reason: 'нет ордера' };
    if (!Number.isFinite(order.exp) || order.exp < nowSec) return { ok: false, reason: 'ордер просрочен' };
    const ok = ed25519.verify(hexToBytes(order.sig), orderBytes(order), hexToBytes(bankPub));
    if (!ok) return { ok: false, reason: 'подпись Банка неверна' };
    if (expectPub && role) {
      const mine = role === 'relay' ? order.relay.pub : order.exit.pub;
      if (mine !== expectPub) return { ok: false, reason: 'ордер не про этот узел' };
    }
    return { ok: true, order };
  } catch (e) { return { ok: false, reason: 'сбой проверки ордера' }; }
}
