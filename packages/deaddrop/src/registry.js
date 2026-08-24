// registry.js — реестр узлов сети тайников БЕЗ единой точки.
// Запись узла подписана его же ключом (relayId), распространяется госсипом: узлы обмениваются
// списками (announce/list). Это «карта кластера» для детерминированного размещения (HRW).
// Скоринг по аптайму/свежести даёт вес узлу при выборе реплик.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sign, verify, hexToBytes, bytesToHex } from './crypto.js';

const enc = new TextEncoder();
// Канонические байты записи (без подписи) — над ними Ed25519-подпись владельца relayId.
// Фаза 6: опциональный `group` (домен отказа: оператор/ASN/страна) подписывается ВМЕСТЕ с записью,
// чтобы diversity нельзя было подделать. Для совместимости пустой group в подпись не входит.
function recordBytes(r) {
  const base = { relayId: r.relayId, endpoints: r.endpoints, addedAt: r.addedAt };
  if (r.group) base.group = r.group;
  return enc.encode(JSON.stringify(base));
}

/** Подписанная запись собственного узла. endpoints — публичные URL; group — метка домена отказа. */
export function makeRecord(identity, endpoints, addedAt, group) {
  const base = { relayId: identity.nodeId, endpoints: [...endpoints], addedAt: addedAt || Date.now() };
  if (group) base.group = String(group);
  return { ...base, sig: bytesToHex(sign(identity.priv, recordBytes(base))) };
}
/** Проверка подписи записи её же ключом (relayId). */
export function verifyRecord(r) {
  if (!r || typeof r.relayId !== 'string' || !Array.isArray(r.endpoints) || typeof r.addedAt !== 'number' || typeof r.sig !== 'string') return false;
  if (r.group !== undefined && typeof r.group !== 'string') return false;
  try { return verify(hexToBytes(r.relayId), hexToBytes(r.sig), recordBytes(r)); } catch { return false; }
}

export class Registry {
  constructor(path, opts = {}) {
    this.path = path;
    this.maxAgeMs = opts.maxAgeMs ?? 3600000;   // узел «живой», если виден за последний час
    this.map = new Map();                       // relayId → { record, firstSeen, lastSeen }
    this._load();
  }
  _load() {
    try { for (const e of JSON.parse(readFileSync(this.path, 'utf8'))) if (verifyRecord(e.record)) this.map.set(e.record.relayId, e); } catch {}
  }
  _save() {
    try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify([...this.map.values()])); } catch {}
  }

  /** Принять запись (из announce/list). Возвращает true, если валидна и учтена. */
  upsert(record) {
    if (!verifyRecord(record)) return false;
    const now = Date.now();
    const cur = this.map.get(record.relayId);
    if (!cur) this.map.set(record.relayId, { record, firstSeen: now, lastSeen: now });
    else { if (record.addedAt >= cur.record.addedAt) cur.record = record; cur.lastSeen = now; }
    this._save();
    return true;
  }
  upsertMany(records) { let n = 0; for (const r of records || []) if (this.upsert(r)) n++; return n; }

  list() { return [...this.map.values()].map((e) => e.record); }
  size() { return this.map.size; }

  /**
   * Живые узлы: { relayId, endpoints, group, score }.
   * ВАЖНО: `score` — ЛОКАЛЬНАЯ оценка (по своим наблюдениям аптайма), для приоритизации
   * отправителем «в каком порядке пробовать». В `placement()` его НЕ передаём как weight —
   * размещение считаем по равномерному весу, чтобы ВСЕ узлы получили ОДИН набор реплик
   * (иначе получатель поллил бы не те тайники). group (домен отказа) одинаков у всех.
   */
  nodes() {
    const now = Date.now();
    const out = [];
    for (const e of this.map.values()) {
      if (now - e.lastSeen >= this.maxAgeMs) continue;
      out.push({ relayId: e.record.relayId, endpoints: e.record.endpoints, group: this._group(e.record), score: this._score(e, now) });
      // (group берётся из подписанной записи, если оператор её задал — см. _group)
    }
    return out;
  }
  // Вес: дольше известен и недавно виден → выше. (Аптайм-скоринг; уточним метрики в фазе 6.)
  _score(e, now) {
    const knownMin = (now - e.firstSeen) / 60000;
    const fresh = Math.max(0, 1 - (now - e.lastSeen) / this.maxAgeMs);
    return (0.5 + Math.min(1, knownMin / 1440)) * fresh; // 0..~1.5
  }
  // Домен отказа для diversity (Фаза 6): приоритет — ПОДПИСАННАЯ метка group (оператор/ASN/страна),
  // иначе суффикс хоста первого endpoint. Подписанная метка не даёт «сибил»-узлам притвориться
  // разными доменами отказа — все копии одного оператора считаются одной группой.
  _group(record) {
    if (record.group) return record.group;
    try { return new URL(record.endpoints[0]).hostname.split('.').slice(-2).join('.'); }
    catch { return record.relayId.slice(0, 6); }
  }
}
