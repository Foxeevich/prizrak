// flock.js — «Стая»: раздача адресов приманок без единого списка.
//
// Блокируют не протокол, а АДРЕСА. Поэтому единого публичного списка приманок
// нет вовсе. Устроено так:
//
//   • Каждому клиенту выдаётся свой небольшой НАБОР адресов, а не весь пул.
//     «Сожжённый» цензором адрес выдаёт лишь малую группу клиентов, а не всех.
//   • Кому какие адреса — считает директория по СЕКРЕТНОМУ ключу. Клиент не
//     может ни предугадать чужой набор, ни перечислить пул из алгоритма.
//   • Наборы РОТИРУЮТСЯ по эпохам: сожжённое естественно вымывается.
//   • Раздаются адреса поштучно через сам мессенджер (E2E) или сеть тайников —
//     их в проекте уже есть (deaddrop). Здесь — только логика набора и доверия.
//
// Приём против перечисления (как у мостов Tor): выдаём мало (k) и по секретному
// хешу. Цензор, поднявший M ложных клиентов, узнаёт не больше, чем видят эти M
// клиентов, а пересечения малы — весь пул так не собрать.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

const enc = new TextEncoder();
const dec = new TextDecoder();

// Эпоха — неделя по умолчанию. В новой эпохе набор меняется.
export const EPOCH_LEN_SEC = 7 * 24 * 3600;
export function epochFor(nowSec = Math.floor(Date.now() / 1000), epochLen = EPOCH_LEN_SEC) {
  return Math.floor(nowSec / epochLen);
}

/**
 * Какие узлы выдать этому клиенту в эту эпоху. Считается на стороне ДИРЕКТОРИИ
 * по её секрету. Детерминировано, но без секрета не воспроизводимо.
 *
 * Идея: каждому узлу — псевдослучайный «балл» от секрета+клиента+эпохи, берём k
 * с наименьшим баллом. Стабильно внутри эпохи, меняется между эпохами, у разных
 * клиентов — разные наборы с малым пересечением.
 *
 * @param {object} p
 * @param {string[]} p.pool — id всех узлов-приманок (у директории).
 * @param {string} p.clientId — непрозрачный id клиента.
 * @param {number} p.epoch — номер эпохи.
 * @param {number} p.k — сколько адресов на клиента (по умолчанию 3).
 * @param {string} p.secret — секрет директории (hex).
 */
export function assignSet({ pool, clientId, epoch, k = 3, secret }) {
  if (!secret) throw new Error('нужен секрет директории');
  const scored = pool.map((id) => {
    const h = sha256(concatBytes(hexToBytes(secret), utf8ToBytes(`${clientId}|${epoch}|${id}`)));
    return { id, score: bytesToHex(h) };
  });
  scored.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : 0));
  return scored.slice(0, Math.min(k, pool.length)).map((x) => x.id);
}

// ── Доля (share): один узел, пригодный для передачи по E2E / тайнику ──────────
/**
 * Каноничные байты доли — то, что подписывает директория.
 * node: { id, pub, addrs:[...], roles:[...], country, epoch }
 */
export function shareBytes(node) {
  return utf8ToBytes(JSON.stringify({
    v: 1, id: node.id, pub: node.pub, addrs: node.addrs || [],
    roles: node.roles || [], country: node.country || '', epoch: node.epoch,
  }));
}

/** Подписать долю ключом директории (Ed25519 seed hex). */
export function packShare(secretHex, node) {
  const body = shareBytes(node);
  const sig = ed25519.sign(body, hexToBytes(secretHex));
  return concatBytes(utf8ToBytes('SH1'), sig, body); // без «магии» протокола — это E2E-контент внутри мессенджера
}

/** Разобрать и проверить долю. trustedPubs — доверенные ключи директорий (hex). */
export function readShare(bytes, trustedPubs = []) {
  try {
    if (dec.decode(bytes.subarray(0, 3)) !== 'SH1') return { ok: false, error: 'не доля' };
    const sig = bytes.subarray(3, 3 + 64);
    const body = bytes.subarray(3 + 64);
    const okSig = trustedPubs.some((p) => { try { return ed25519.verify(sig, body, hexToBytes(p)); } catch { return false; } });
    if (!okSig) return { ok: false, error: 'подпись директории не подтверждена' };
    return { ok: true, node: JSON.parse(dec.decode(body)) };
  } catch { return { ok: false, error: 'битая доля' }; }
}

// ── Клиентская адресная книга: хранение, отжиг, ротация ────────────────────────
/**
 * Книга адресов у клиента. Хранит выданные узлы, помнит сожжённые, отдаёт
 * следующий пригодный, сигналит когда пора просить новые доли.
 */
export function makeAddressBook({ trustedPubs = [], k = 3 } = {}) {
  const nodes = new Map();   // id → node
  const burned = new Set();  // id сожжённых
  let epoch = null;

  return {
    /** Принять долю (из мессенджера или тайника). Возвращает id или null. */
    accept(shareBytesOrNode) {
      const node = shareBytesOrNode instanceof Uint8Array
        ? (() => { const r = readShare(shareBytesOrNode, trustedPubs); return r.ok ? r.node : null; })()
        : shareBytesOrNode;
      if (!node) return null;
      nodes.set(node.id, node);
      if (node.epoch != null) epoch = node.epoch;
      return node.id;
    },

    /** Пометить адрес сожжённым (узел перестал отвечать / попал под блок). */
    burn(id) { burned.add(id); },

    /** Все пригодные (не сожжённые) узлы, опционально фильтр по роли/стране. */
    usable({ role, country } = {}) {
      return [...nodes.values()].filter((n) =>
        !burned.has(n.id) &&
        (!role || (n.roles || []).includes(role)) &&
        (!country || n.country === country));
    },

    /** Следующий пригодный (первый живой) — для автозамены. */
    next(filter) { return this.usable(filter)[0] || null; },

    /** Нужны новые доли: пригодных почти не осталось (сожгли большинство). */
    needsRefill({ role } = {}) {
      const alive = this.usable({ role }).length;
      return alive === 0 || alive < Math.ceil(k / 2);
    },

    /** Сменилась эпоха — стоит запросить свежий набор (старое вымывается). */
    staleEpoch(nowSec) { return epoch != null && epochFor(nowSec) !== epoch; },

    stats: () => ({ known: nodes.size, burned: burned.size, epoch }),
  };
}
