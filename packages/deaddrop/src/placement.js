// placement.js — детерминированное размещение блоба по узлам (аналог CRUSH из Ceph).
// Weighted Rendezvous Hashing (HRW): любой узел/homeserver, зная реестр, САМ вычисляет,
// на каких RF узлах должен лежать msgId — без центрального сервера. Вес — по скорингу
// (аптайм/латентность/ёмкость). group — домен отказа (подсеть/страна/оператор) для diversity.
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';

function unitHash(msgId, relayId) {
  const h = sha256(utf8ToBytes(msgId + '|' + relayId));
  let v = 0; for (let i = 0; i < 6; i++) v = v * 256 + h[i]; // 48 бит
  let u = (v + 1) / 2 ** 48;                                  // (0,1]
  return Math.min(u, 1 - 1e-12);
}
// Взвешенный HRW: score = weight / (-ln(u)). Больше вес → выше шанс попасть в набор.
function score(msgId, relayId, weight = 1) {
  return (weight > 0 ? weight : 1e-9) / (-Math.log(unitHash(msgId, relayId)));
}

/**
 * Возвращает упорядоченный список relayId (primary — первый), где должен лежать msgId.
 * nodes: [{ relayId, weight?, group? }]. rf — целевое число копий.
 */
export function placement(msgId, nodes, rf = 4) {
  const scored = nodes
    .map((n) => ({ relayId: n.relayId, group: n.group, s: score(msgId, n.relayId, n.weight ?? 1) }))
    .sort((a, b) => b.s - a.s);
  const out = [];
  const groups = new Set();
  // Сначала — с diversity: не более одного узла на домен отказа.
  for (const n of scored) {
    if (out.length >= rf) break;
    if (n.group && groups.has(n.group)) continue;
    out.push(n.relayId); if (n.group) groups.add(n.group);
  }
  // Если diversity не набрал RF (мало групп) — добираем по порядку скоринга.
  if (out.length < rf) for (const n of scored) { if (out.length >= rf) break; if (!out.includes(n.relayId)) out.push(n.relayId); }
  return out;
}
