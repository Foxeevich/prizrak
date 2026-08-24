// healer.js — самоисцеление реплик (Фазы 4–5, модель Ceph backfill/recovery).
// Для каждого своего блоба узел вычисляет детерминированный набор реплик placement(msgId, RF).
// Роли: primary = первый ЖИВОЙ узел набора — он один доливает недостающие копии (аналог Ceph:
// «с живых реплик долить на ещё один живой»), чтобы не делали все разом. Плюс:
//  • если кто-то из реплик уже доставил (ACK) — применяем проверенный ACK и удаляем блоб;
//  • если наша копия стала ЛИШНЕЙ (размещение сместилось, а живых правильных копий хватает) —
//    снимаем её (recovery/rebalance при возврате узла).
import { placement } from './placement.js';

const RF = 4;
const clean = (u) => String(u || '').replace(/\/$/, '');

export function makeHealer(node, { rf = RF, timeoutMs = 6000 } = {}) {
  const { store, registry, identity } = node;
  const self = identity.nodeId;

  return async function healOnce() {
    const mem = registry.nodes();                    // живые узлы
    const myBlobs = [...store.meta.keys()];
    if (!mem.length || !myBlobs.length) return { checked: myBlobs.length, backfilled: 0, droppedAck: 0, droppedSurplus: 0 };

    const forPlace = mem.map((n) => ({ relayId: n.relayId, group: n.group }));
    const ep = new Map(mem.map((n) => [n.relayId, clean(n.endpoints[0])]));
    const live = new Set(mem.map((n) => n.relayId));

    // Целевой набор реплик для каждого блоба.
    const targetOf = new Map();
    for (const id of myBlobs) targetOf.set(id, placement(id, forPlace, rf));

    // Кого и о чём спросить (/dd/have): пиры из target, живые, не мы.
    const askByPeer = new Map(); // relayId → [msgIds]
    for (const id of myBlobs) for (const rid of targetOf.get(id)) {
      if (rid === self || !live.has(rid)) continue;
      if (!askByPeer.has(rid)) askByPeer.set(rid, []);
      askByPeer.get(rid).push(id);
    }
    const peerHas = new Map(); // relayId → { present:Set, acked:Set, ackRecs } | null
    for (const [rid, ids] of askByPeer) {
      const base = ep.get(rid); if (!base) { peerHas.set(rid, null); continue; }
      try {
        const j = await (await fetch(base + '/dd/have', { method: 'POST', body: JSON.stringify({ msgIds: ids }), signal: AbortSignal.timeout(timeoutMs) })).json();
        peerHas.set(rid, { present: new Set(j.present || []), acked: new Set(j.acked || []), ackRecs: j.ackRecs || {} });
      } catch { peerHas.set(rid, null); }
    }

    let backfilled = 0, droppedAck = 0, droppedSurplus = 0;
    for (const id of myBlobs) {
      if (!store.meta.has(id)) continue;
      const target = targetOf.get(id);
      const liveTarget = target.filter((t) => live.has(t));
      const primary = liveTarget[0];
      const inTarget = target.includes(self);

      // 1) Уже доставлено кем-то из реплик (проверенный ACK) → применяем и удаляем.
      let done = false;
      for (const rid of target) {
        const ph = peerHas.get(rid);
        if (ph && ph.acked.has(id) && ph.ackRecs[id]) {
          const r = store.ack({ msgId: id, pub: ph.ackRecs[id].pub, sig: ph.ackRecs[id].sig });
          if (r.ok) { droppedAck++; done = true; break; }
        }
      }
      if (done) continue;

      // 2) Я primary → доливаю недостающим живым репликам до RF (backfill).
      if (primary === self) {
        const m = store.meta.get(id), ct = store.get(id);
        for (const rid of liveTarget) {
          if (rid === self) continue;
          const ph = peerHas.get(rid);
          const missing = !ph || (!ph.present.has(id) && !ph.acked.has(id));
          if (missing && m && ct && ep.get(rid)) {
            try {
              await fetch(ep.get(rid) + '/dd/put', { method: 'PUT', headers: { 'x-dd-msgid': id, 'x-dd-mailbox': m.mailbox, 'x-dd-epoch': String(m.epoch), 'x-dd-expiry': String(m.expiry) }, body: ct, signal: AbortSignal.timeout(timeoutMs) });
              backfilled++;
            } catch {}
          }
        }
      }

      // 3) Моя копия лишняя (я не в target — размещение сместилось), а живых правильных копий
      //    достаточно → снимаю (rebalance/recovery при возврате узла).
      if (!inTarget) {
        let held = 0;
        for (const rid of liveTarget) { const ph = peerHas.get(rid); if (ph && ph.present.has(id)) held++; }
        if (held >= Math.min(rf, liveTarget.length) && held > 0) { store.drop(id); droppedSurplus++; }
      }
    }
    return { checked: myBlobs.length, backfilled, droppedAck, droppedSurplus };
  };
}
