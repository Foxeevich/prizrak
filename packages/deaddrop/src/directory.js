// directory.js — директория СЕРВЕРОВ (homeserver'ов), которую несут тайники (Фаза 6a).
// Запись сервера {domain, keys:{ed,x}, endpoints, addedAt, sig} подписана СВОИМ ed-ключом
// (keys.ed). Серверы анонсят себя тайникам, тайники разносят директорию госсипом и отдают её
// серверам. Так серверы узнают домены/ключи/адреса друг друга БЕЗ конфига и без прямого доступа
// к discovery получателя. Подпись = целостность (отравить нельзя).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { hexToBytes } from '@noble/hashes/utils';

const enc = new TextEncoder();
export function serverRecordBytes(r) { return enc.encode(JSON.stringify({ domain: r.domain, keys: r.keys, endpoints: r.endpoints, addedAt: r.addedAt })); }

export function verifyServerRecord(r) {
  if (!r || typeof r.domain !== 'string' || !r.keys || typeof r.keys.ed !== 'string' || typeof r.keys.x !== 'string'
      || !Array.isArray(r.endpoints) || typeof r.addedAt !== 'number' || typeof r.sig !== 'string') return false;
  try { return ed25519.verify(hexToBytes(r.sig), serverRecordBytes(r), hexToBytes(r.keys.ed)); } catch { return false; }
}

export class Directory {
  constructor(path, opts = {}) {
    this.path = path;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 86400000; // серверы живут дольше узлов
    this.map = new Map();                            // domain → { record, firstSeen, lastSeen }
    this._load();
  }
  _load() { try { for (const e of JSON.parse(readFileSync(this.path, 'utf8'))) if (verifyServerRecord(e.record)) this.map.set(e.record.domain, e); } catch {} }
  _save() { try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify([...this.map.values()])); } catch {} }

  upsert(record) {
    if (!verifyServerRecord(record)) return false;
    const now = Date.now();
    const cur = this.map.get(record.domain);
    if (!cur) this.map.set(record.domain, { record, firstSeen: now, lastSeen: now });
    else { if (record.addedAt >= cur.record.addedAt) cur.record = record; cur.lastSeen = now; }
    this._save();
    return true;
  }
  upsertMany(recs) { let n = 0; for (const r of recs || []) if (this.upsert(r)) n++; return n; }
  list() { return [...this.map.values()].map((e) => e.record); }
  size() { return this.map.size; }
}
