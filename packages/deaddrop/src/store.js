// store.js — зашифрованное zero-knowledge хранилище узла-тайника.
// Узел видит ТОЛЬКО шифртекст + маршрутные метаданные (mailbox, epoch, expiry, size).
// Блобы неизменяемы (write-once), удаляются при ACK получателя или по TTL.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { msgIdOf, mailboxOf, verifyAck } from './crypto.js';

export class Store {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.blobsDir = join(dir, 'blobs');
    this.metaDir = join(dir, 'meta');
    this.acksDir = join(dir, 'acks');
    for (const d of [this.blobsDir, this.metaDir, this.acksDir]) mkdirSync(d, { recursive: true });
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024 * 1024;             // общий диск-лимит: 2 ГБ
    this.maxPerMailboxBytes = opts.maxPerMailboxBytes ?? 64 * 1024 * 1024; // на один ящик: 64 МБ
    this.maxBlobBytes = opts.maxBlobBytes ?? 16 * 1024 * 1024;           // на один блоб: 16 МБ
    this.ackTtlMs = opts.ackTtlMs ?? 7 * 86400000;                       // храним ACK 7 дней
    this.meta = new Map();      // msgId → { mailbox, epoch, expiry, size, at }
    this.byMailbox = new Map();  // mailbox → Set<msgId>
    this.acks = new Map();       // msgId → { pub, epoch, sig, mailbox, at }
    this.totalBytes = 0;
    this._load();
  }

  _idxAdd(msgId, m) {
    this.meta.set(msgId, m);
    if (!this.byMailbox.has(m.mailbox)) this.byMailbox.set(m.mailbox, new Set());
    this.byMailbox.get(m.mailbox).add(msgId);
    this.totalBytes += m.size;
  }
  _idxDel(msgId) {
    const m = this.meta.get(msgId); if (!m) return;
    this.meta.delete(msgId);
    const s = this.byMailbox.get(m.mailbox);
    if (s) { s.delete(msgId); if (!s.size) this.byMailbox.delete(m.mailbox); }
    this.totalBytes -= m.size;
  }
  _mailboxBytes(mailbox) {
    let b = 0; const s = this.byMailbox.get(mailbox);
    if (s) for (const id of s) b += this.meta.get(id)?.size || 0;
    return b;
  }

  _load() {
    for (const f of safeReaddir(this.metaDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      try {
        const m = JSON.parse(readFileSync(join(this.metaDir, f), 'utf8'));
        if (existsSync(join(this.blobsDir, id + '.bin'))) this._idxAdd(id, m);
        else rmSync(join(this.metaDir, f), { force: true }); // мета без блоба — мусор
      } catch {}
    }
    for (const f of safeReaddir(this.acksDir)) {
      if (!f.endsWith('.json')) continue;
      try { this.acks.set(f.slice(0, -5), JSON.parse(readFileSync(join(this.acksDir, f), 'utf8'))); } catch {}
    }
  }

  /** PUT: положить блоб. Проверяем контент-адрес, квоты, не доставлен ли уже (ACK). */
  put({ msgId, mailbox, epoch, expiry, ct }) {
    if (!msgId || !mailbox || !ct || !ct.length) return { ok: false, reason: 'bad-args' };
    if (ct.length > this.maxBlobBytes) return { ok: false, reason: 'too-large' };
    if (msgIdOf(ct) !== msgId) return { ok: false, reason: 'bad-msgid' };
    if (this.acks.has(msgId)) return { ok: true, stale: true };  // уже доставлено — хранить незачем
    if (this.meta.has(msgId)) return { ok: true, dup: true };
    if (this.totalBytes + ct.length > this.maxBytes) return { ok: false, reason: 'store-full' };
    if (this._mailboxBytes(mailbox) + ct.length > this.maxPerMailboxBytes) return { ok: false, reason: 'mailbox-quota' };
    const m = { mailbox, epoch: epoch ?? 0, expiry: expiry || (Date.now() + 7 * 86400000), size: ct.length, at: Date.now() };
    writeFileSync(join(this.blobsDir, msgId + '.bin'), ct);
    writeFileSync(join(this.metaDir, msgId + '.json'), JSON.stringify(m));
    this._idxAdd(msgId, m);
    return { ok: true, stored: true };
  }

  /** POLL: список блобов для ящика (новее since). */
  poll(mailbox, since = 0) {
    const s = this.byMailbox.get(mailbox); if (!s) return [];
    const out = [];
    for (const id of s) { const m = this.meta.get(id); if (m && m.at > since) out.push({ msgId: id, size: m.size, at: m.at }); }
    return out.sort((a, b) => a.at - b.at);
  }

  /** GET: шифртекст блоба (или null). */
  get(msgId) {
    const p = join(this.blobsDir, msgId + '.bin');
    return existsSync(p) ? readFileSync(p) : null;
  }

  /** ACK: получатель подтвердил доставку → удаляем блоб, помним ACK до TTL. */
  ack({ msgId, pub, sig }) {
    if (!msgId || !pub || !sig) return { ok: false, reason: 'bad-args' };
    if (this.acks.has(msgId)) return { ok: true, already: true };
    const m = this.meta.get(msgId);
    if (!m) return { ok: false, reason: 'unknown' };                 // MVP: ACK принимаем при наличии блоба
    if (!verifyAck(pub, msgId, sig)) return { ok: false, reason: 'bad-sig' };
    if (mailboxOf(pub, m.epoch) !== m.mailbox) return { ok: false, reason: 'not-your-mailbox' }; // только владелец ящика
    const rec = { pub, epoch: m.epoch, sig, mailbox: m.mailbox, at: Date.now() };
    this.acks.set(msgId, rec);
    writeFileSync(join(this.acksDir, msgId + '.json'), JSON.stringify(rec));
    this._idxDel(msgId);
    rmSync(join(this.blobsDir, msgId + '.bin'), { force: true });
    rmSync(join(this.metaDir, msgId + '.json'), { force: true });
    return { ok: true, deleted: true };
  }

  /** HAVE: по списку msgId — какие доставлены (ACK) и какие ещё лежат. Для реконсиляции/исцеления.
   *  Для доставленных отдаём и сам ACK (pub+sig), чтобы спрашивающий мог ПРОВЕРИТЬ подпись и
   *  тоже применить (распространение ACK → удаление лишних копий). */
  have(msgIds = []) {
    const acked = [], present = [], ackRecs = {};
    for (const id of msgIds) {
      if (this.acks.has(id)) { acked.push(id); const a = this.acks.get(id); ackRecs[id] = { pub: a.pub, sig: a.sig }; }
      else if (this.meta.has(id)) present.push(id);
    }
    return { acked, present, ackRecs };
  }

  /** Снять СВОЮ копию блоба без ACK (для самоисцеления: копия стала лишней при смене размещения). */
  drop(msgId) {
    if (!this.meta.has(msgId)) return false;
    this._idxDel(msgId);
    rmSync(join(this.blobsDir, msgId + '.bin'), { force: true });
    rmSync(join(this.metaDir, msgId + '.json'), { force: true });
    return true;
  }

  /** Уборка: протухшие блобы (expiry) и старые ACK (> ackTtl). */
  sweep() {
    const now = Date.now();
    let delBlobs = 0, delAcks = 0;
    for (const [id, m] of [...this.meta]) if (m.expiry && m.expiry < now) {
      this._idxDel(id);
      rmSync(join(this.blobsDir, id + '.bin'), { force: true });
      rmSync(join(this.metaDir, id + '.json'), { force: true });
      delBlobs++;
    }
    for (const [id, a] of [...this.acks]) if (now - (a.at || 0) > this.ackTtlMs) {
      this.acks.delete(id);
      rmSync(join(this.acksDir, id + '.json'), { force: true });
      delAcks++;
    }
    return { delBlobs, delAcks };
  }

  stats() {
    return { blobs: this.meta.size, mailboxes: this.byMailbox.size, acks: this.acks.size, bytes: this.totalBytes, maxBytes: this.maxBytes };
  }
}

function safeReaddir(d) { try { return readdirSync(d); } catch { return []; } }
