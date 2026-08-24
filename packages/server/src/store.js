// store.js — хранилище homeserver'а на SQLite (WAL). Тот же публичный API, что и прежняя
// файловая версия, но данные лежат в НАСТОЯЩИХ таблицах с индексами: нет переписывания всего
// файла на каждое сообщение и нет держания всей истории в оперативке. Масштабируется на миллионы
// строк на одной машине. Хранит: prekey-bundle, устройства, аккаунты, токены, кошельки 👻,
// комнаты, ЗАШИФРОВАННУЮ историю (E2E-конверты), каналы/реакции, очереди доставки. Открытого
// текста переписки нет. Медиа-блобы по-прежнему у StorageManager (файлы на диске).
//
// Движок — встроенный node:sqlite (Node 22+/24+), без нативных зависимостей и без флагов на
// проде (в 22.x печатает один ExperimentalWarning — глушим его точечно ниже).
// Автоперенос: если рядом есть старый <path>.json, при первом старте он импортируется в базу.
import { existsSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Точечно гасим единственный шумный ворнинг node:sqlite (не трогаем прочие предупреждения).
(() => {
  const orig = process.emitWarning.bind(process);
  process.emitWarning = (w, ...a) => {
    try { const s = typeof w === 'string' ? w : (w && w.message) || ''; if (s.includes('SQLite is an experimental')) return; } catch {}
    return orig(w, ...a);
  };
})();
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (e) {
  const v = process.versions.node;
  throw new Error(`Хранилищу нужен встроенный node:sqlite (Node ≥ 22.5, лучше 22 LTS или 24). У вас Node ${v}. Обновите Node на сервере. (${e.message})`);
}

const j = (v) => JSON.stringify(v);
const p = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));

// Путь к БД: <storePath без .json>.sqlite. path=null → in-memory (тесты).
function dbPathFor(path) {
  if (!path) return ':memory:';
  return path.endsWith('.json') ? path.replace(/\.json$/, '.sqlite') : (/\.(sqlite|db)$/.test(path) ? path : path + '.sqlite');
}

export class Store {
  constructor(path) {
    this.path = path;                       // историческое имя (json) — для миграции и совместимости
    this.dbPath = dbPathFor(path);
    if (path) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=5000;');
    this._schema();
    this._stmts = new Map();
    this.outbox = p(this._meta('outbox'), []) || [];   // очередь федерации — небольшая, держим в памяти
    // Глобальный монотонный курсор seq (общий для истории и постов каналов).
    this.seq = Math.max(
      num(this._p('SELECT COALESCE(MAX(seq),0) s FROM history').get().s),
      num(this._p('SELECT COALESCE(MAX(seq),0) s FROM channel_posts').get().s),
      num(p(this._meta('seq'), 0)) || 0,
    );
    this._migrateLegacy();
  }

  _p(sql) { let st = this._stmts.get(sql); if (!st) { st = this.db.prepare(sql); this._stmts.set(sql, st); } return st; }
  _tx(fn) { this.db.exec('BEGIN'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; } }
  _meta(k, v) {
    if (v === undefined) { const r = this._p('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : null; }
    this._p('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
  }

  _schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users(userId TEXT PRIMARY KEY, publicBundle TEXT, keyBackup TEXT, seedBackup TEXT, updatedAt INTEGER);
      CREATE TABLE IF NOT EXISTS devices(userId TEXT, deviceId TEXT, bundle TEXT, name TEXT, addedAt INTEGER, updatedAt INTEGER, revoked INTEGER DEFAULT 0, PRIMARY KEY(userId,deviceId));
      CREATE TABLE IF NOT EXISTS accounts(userId TEXT PRIMARY KEY, data TEXT, isAdmin INTEGER DEFAULT 0, createdAt INTEGER, updatedAt INTEGER);
      CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, userId TEXT, createdAt INTEGER);
      CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(userId);
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY, userId TEXT, at INTEGER, roomId TEXT, msgId TEXT, toDevice TEXT, envelope TEXT);
      CREATE INDEX IF NOT EXISTS idx_hist_user ON history(userId, seq);
      CREATE INDEX IF NOT EXISTS idx_hist_msg ON history(msgId);
      CREATE INDEX IF NOT EXISTS idx_hist_room ON history(userId, roomId, seq);
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, data TEXT, updatedAt INTEGER);
      CREATE TABLE IF NOT EXISTS room_members(userId TEXT, roomId TEXT, PRIMARY KEY(userId,roomId));
      CREATE INDEX IF NOT EXISTS idx_rm_room ON room_members(roomId);
      CREATE TABLE IF NOT EXISTS wallets(userId TEXT PRIMARY KEY, balance INTEGER DEFAULT 0, tx TEXT);
      CREATE TABLE IF NOT EXISTS profiles(userId TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE IF NOT EXISTS queues(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, userId TEXT, dedup TEXT, rec TEXT, at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_q ON queues(kind, userId, id);
      CREATE TABLE IF NOT EXISTS channel_keys(roomId TEXT, userId TEXT, epoch TEXT, wrapped TEXT, PRIMARY KEY(roomId,userId,epoch));
      CREATE TABLE IF NOT EXISTS channel_secrets(roomId TEXT, epoch TEXT, keyHex TEXT, PRIMARY KEY(roomId,epoch));
      CREATE TABLE IF NOT EXISTS channel_posts(seq INTEGER PRIMARY KEY, roomId TEXT, at INTEGER, data TEXT);
      CREATE INDEX IF NOT EXISTS idx_cp ON channel_posts(roomId, seq);
      CREATE TABLE IF NOT EXISTS channel_reactions(roomId TEXT, msgId TEXT, data TEXT, PRIMARY KEY(roomId,msgId));
      CREATE TABLE IF NOT EXISTS last_seen(userId TEXT PRIMARY KEY, ts INTEGER);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS privacy(userId TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE IF NOT EXISTS peers(userId TEXT, peer TEXT, PRIMARY KEY(userId,peer));
    `);
  }

  // ── Автоперенос старого store.json (однократно) ──────────────────────────────
  _migrateLegacy() {
    if (!this.path || !existsSync(this.path)) return;
    if (this._meta('migrated_from_json')) return;
    let data; try { data = JSON.parse(readFileSync(this.path, 'utf8')); } catch { return; }
    const D = { users: {}, devices: {}, accounts: {}, tokens: {}, history: {}, rooms: {}, wallets: {}, profiles: {}, channelKeys: {}, channelSecrets: {}, channelPosts: {}, channelReactions: {}, receipts: {}, deletions: {}, invites: {}, keyReqs: {}, outbox: [], lastSeen: {}, seq: 0, ...data };
    this._tx(() => {
      for (const [u, r] of Object.entries(D.users)) this._p('INSERT OR REPLACE INTO users(userId,publicBundle,keyBackup,seedBackup,updatedAt) VALUES(?,?,?,?,?)').run(u, r.publicBundle ? j(r.publicBundle) : null, r.keyBackup ? j(r.keyBackup) : null, r.seedBackup ? j(r.seedBackup) : null, num(r.updatedAt));
      for (const [u, devs] of Object.entries(D.devices)) for (const [dev, e] of Object.entries(devs)) this._p('INSERT OR REPLACE INTO devices(userId,deviceId,bundle,name,addedAt,updatedAt,revoked) VALUES(?,?,?,?,?,?,?)').run(u, dev, j(e.bundle), e.name || '', num(e.addedAt), num(e.updatedAt), e.revoked ? 1 : 0);
      for (const [u, a] of Object.entries(D.accounts)) this._p('INSERT OR REPLACE INTO accounts(userId,data,isAdmin,createdAt,updatedAt) VALUES(?,?,?,?,?)').run(u, j(a), a.isAdmin ? 1 : 0, num(a.createdAt), num(a.updatedAt));
      for (const [t, r] of Object.entries(D.tokens)) this._p('INSERT OR REPLACE INTO tokens(token,userId,createdAt) VALUES(?,?,?)').run(t, r.userId, num(r.createdAt));
      for (const [u, list] of Object.entries(D.history)) for (const e of list) this._p('INSERT OR REPLACE INTO history(seq,userId,at,roomId,msgId,toDevice,envelope) VALUES(?,?,?,?,?,?,?)').run(num(e.seq), u, num(e.at), e.roomId || null, e.msgId || null, e.toDevice || null, j(e.envelope));
      for (const [id, r] of Object.entries(D.rooms)) { this._p('INSERT OR REPLACE INTO rooms(id,data,updatedAt) VALUES(?,?,?)').run(id, j(r), Date.now()); for (const m of new Set([...(r.members || []), ...(r.subscribers || [])])) this._p('INSERT OR IGNORE INTO room_members(userId,roomId) VALUES(?,?)').run(m, id); }
      for (const [u, w] of Object.entries(D.wallets)) this._p('INSERT OR REPLACE INTO wallets(userId,balance,tx) VALUES(?,?,?)').run(u, num(w.balance), j(w.tx || []));
      for (const [u, pr] of Object.entries(D.profiles)) this._p('INSERT OR REPLACE INTO profiles(userId,data) VALUES(?,?)').run(u, j(pr));
      const q = (kind, map, dedupOf) => { for (const [u, list] of Object.entries(map)) for (const rec of list) this._p('INSERT INTO queues(kind,userId,dedup,rec,at) VALUES(?,?,?,?,?)').run(kind, u, dedupOf ? dedupOf(rec) : null, j(rec), num(rec.at) || Date.now()); };
      q('receipt', D.receipts); q('deletion', D.deletions);
      q('invite', D.invites, (r) => r.id != null ? String(r.id) : null);
      q('keyReq', D.keyReqs, (r) => `${r.roomId}|${r.from}`);
      for (const [room, us] of Object.entries(D.channelKeys)) for (const [u, ep] of Object.entries(us)) for (const [epoch, wrapped] of Object.entries(ep)) this._p('INSERT OR REPLACE INTO channel_keys(roomId,userId,epoch,wrapped) VALUES(?,?,?,?)').run(room, u, epoch, wrapped);
      for (const [room, ep] of Object.entries(D.channelSecrets)) for (const [epoch, keyHex] of Object.entries(ep)) this._p('INSERT OR REPLACE INTO channel_secrets(roomId,epoch,keyHex) VALUES(?,?,?)').run(room, epoch, keyHex);
      for (const [room, list] of Object.entries(D.channelPosts)) for (const e of list) this._p('INSERT OR REPLACE INTO channel_posts(seq,roomId,at,data) VALUES(?,?,?,?)').run(num(e.seq), room, num(e.at), j(e));
      for (const [room, byMsg] of Object.entries(D.channelReactions)) for (const [msgId, rec] of Object.entries(byMsg)) this._p('INSERT OR REPLACE INTO channel_reactions(roomId,msgId,data) VALUES(?,?,?)').run(room, msgId, j(rec));
      for (const [u, ts] of Object.entries(D.lastSeen)) this._p('INSERT OR REPLACE INTO last_seen(userId,ts) VALUES(?,?)').run(u, num(ts));
      this.outbox = Array.isArray(D.outbox) ? D.outbox : [];
      this._meta('outbox', j(this.outbox));
      this.seq = Math.max(this.seq, num(D.seq), num(this._p('SELECT COALESCE(MAX(seq),0) s FROM history').get().s), num(this._p('SELECT COALESCE(MAX(seq),0) s FROM channel_posts').get().s));
      this._meta('seq', j(this.seq));
      this._meta('migrated_from_json', j(Date.now()));
    });
    try { renameSync(this.path, this.path + '.migrated'); } catch {}
    try { console.log(`[store] мигрировано из ${this.path} → ${this.dbPath} (старый файл сохранён как ${this.path}.migrated)`); } catch {}
  }

  // ── Ключи (prekey-bundle) ────────────────────────────────────────────────────
  putUser(u, b) { this._p('INSERT INTO users(userId,publicBundle,updatedAt) VALUES(?,?,?) ON CONFLICT(userId) DO UPDATE SET publicBundle=excluded.publicBundle, updatedAt=excluded.updatedAt').run(u, j(b), Date.now()); }
  getUser(u) { const r = this._p('SELECT * FROM users WHERE userId=?').get(u); if (!r) return null; return { publicBundle: p(r.publicBundle), keyBackup: p(r.keyBackup), seedBackup: p(r.seedBackup), updatedAt: num(r.updatedAt) }; }

  // ── Устройства (MD1) ────────────────────────────────────────────────────────
  putDevice(u, deviceId, bundle, meta = {}) {
    this._tx(() => {
      const prev = this._p('SELECT * FROM devices WHERE userId=? AND deviceId=?').get(u, deviceId);
      const addedAt = prev ? num(prev.addedAt) : Date.now();
      const name = meta.name || (prev && prev.name) || '';
      this._p('INSERT INTO devices(userId,deviceId,bundle,name,addedAt,updatedAt,revoked) VALUES(?,?,?,?,?,?,0) ON CONFLICT(userId,deviceId) DO UPDATE SET bundle=excluded.bundle, name=excluded.name, updatedAt=excluded.updatedAt, revoked=0').run(u, deviceId, j(bundle), name, addedAt, Date.now());
      // MD7: лимит 10 активных устройств — эвиктим самые старые (кроме текущего).
      const active = this._p('SELECT deviceId FROM devices WHERE userId=? AND revoked=0 ORDER BY addedAt ASC').all(u);
      const LIMIT = 10;
      if (active.length > LIMIT) for (const e of active.slice(0, active.length - LIMIT)) if (e.deviceId !== deviceId) this._p('DELETE FROM devices WHERE userId=? AND deviceId=?').run(u, e.deviceId);
    });
  }
  getDevices(u) { return this._p('SELECT * FROM devices WHERE userId=? AND revoked=0').all(u).map((r) => ({ deviceId: r.deviceId, bundle: p(r.bundle), name: r.name || '', addedAt: num(r.addedAt), updatedAt: num(r.updatedAt), revoked: false })); }
  getDevice(u, deviceId) { const r = this._p('SELECT * FROM devices WHERE userId=? AND deviceId=?').get(u, deviceId); if (!r || r.revoked) return null; return { deviceId: r.deviceId, bundle: p(r.bundle), name: r.name || '', addedAt: num(r.addedAt), updatedAt: num(r.updatedAt), revoked: false }; }
  revokeDevice(u, deviceId) { const r = this._p('UPDATE devices SET revoked=1, updatedAt=? WHERE userId=? AND deviceId=? AND revoked=0').run(Date.now(), u, deviceId); return num(r.changes) > 0; }

  // ── Резервные копии личности (шифртекст) ────────────────────────────────────
  // ── Конфиденциальность (чёрный список, политики групп/звонков) ────────────
  getPrivacy(u) { const r = this._p('SELECT data FROM privacy WHERE userId=?').get(u); return r ? p(r.data) : null; }
  putPrivacy(u, d) { this._p('INSERT OR REPLACE INTO privacy(userId,data) VALUES(?,?)').run(u, j(d)); }
  // «Контакты» (для режима «Мои контакты»): peer'ы, КОМУ пользователь сам писал.
  addPeer(u, peer) { try { this._p('INSERT OR IGNORE INTO peers(userId,peer) VALUES(?,?)').run(u, peer); } catch {} }
  isPeer(u, peer) { return !!this._p('SELECT 1 FROM peers WHERE userId=? AND peer=?').get(u, peer); }

  putKeyBackup(u, blob) { this._p('INSERT INTO users(userId,keyBackup,updatedAt) VALUES(?,?,?) ON CONFLICT(userId) DO UPDATE SET keyBackup=excluded.keyBackup, updatedAt=excluded.updatedAt').run(u, j(blob), Date.now()); }
  getKeyBackup(u) { const r = this._p('SELECT keyBackup FROM users WHERE userId=?').get(u); return r ? p(r.keyBackup) : null; }
  putSeedBackup(u, blob) { this._p('INSERT INTO users(userId,seedBackup,updatedAt) VALUES(?,?,?) ON CONFLICT(userId) DO UPDATE SET seedBackup=excluded.seedBackup, updatedAt=excluded.updatedAt').run(u, j(blob), Date.now()); }
  getSeedBackup(u) { const r = this._p('SELECT seedBackup FROM users WHERE userId=?').get(u); return r ? p(r.seedBackup) : null; }

  // ── Аккаунты ────────────────────────────────────────────────────────────────
  hasAccount(u) { return !!this._p('SELECT 1 FROM accounts WHERE userId=?').get(u); }
  getAccount(u) { const r = this._p('SELECT data FROM accounts WHERE userId=?').get(u); return r ? p(r.data) : null; }
  createAccount(u, r) { const rec = { ...r, createdAt: Date.now() }; this._tx(() => { this._p('INSERT OR REPLACE INTO accounts(userId,data,isAdmin,createdAt,updatedAt) VALUES(?,?,?,?,?)').run(u, j(rec), rec.isAdmin ? 1 : 0, num(rec.createdAt), num(rec.createdAt)); this._p('INSERT OR IGNORE INTO wallets(userId,balance,tx) VALUES(?,0,?)').run(u, j([])); }); }
  _updateAccount(u, patch) { const a = this.getAccount(u); if (!a) return false; const rec = { ...a, ...patch, updatedAt: Date.now() }; this._p('UPDATE accounts SET data=?, isAdmin=?, updatedAt=? WHERE userId=?').run(j(rec), rec.isAdmin ? 1 : 0, num(rec.updatedAt), u); return true; }
  setSeedCred(u, cred) { this._updateAccount(u, { seedCred: cred }); }
  getSeedCred(u) { return this.getAccount(u)?.seedCred || null; }
  setPassword(u, rec) { this._updateAccount(u, { ...rec }); }
  setAdmin(u, val) { return this._updateAccount(u, { isAdmin: !!val }); }
  listAdmins() { return this._p('SELECT userId FROM accounts WHERE isAdmin=1').all().map((r) => r.userId); }
  countAccounts() { return num(this._p('SELECT COUNT(*) c FROM accounts').get().c); }

  putToken(t, u) { this._p('INSERT OR REPLACE INTO tokens(token,userId,createdAt) VALUES(?,?,?)').run(t, u, Date.now()); }
  getToken(t) { const r = this._p('SELECT userId,createdAt FROM tokens WHERE token=?').get(t); return r ? { userId: r.userId, createdAt: num(r.createdAt) } : null; }
  deleteToken(t) { this._p('DELETE FROM tokens WHERE token=?').run(t); }

  // ── Профили ─────────────────────────────────────────────────────────────────
  getProfile(u) { const r = this._p('SELECT data FROM profiles WHERE userId=?').get(u); return r ? p(r.data) : null; }
  setProfile(u, fields) { const cur = this.getProfile(u) || {}; const rec = { ...cur, ...fields, updatedAt: Date.now() }; this._p('INSERT OR REPLACE INTO profiles(userId,data) VALUES(?,?)').run(u, j(rec)); return rec; }

  // ── Очереди офлайн-доставки (receipts/deletions/invites/keyReqs) ─────────────
  _qpush(kind, u, rec, cap, dedup = null) {
    this._tx(() => {
      if (dedup != null) this._p('DELETE FROM queues WHERE kind=? AND userId=? AND dedup=?').run(kind, u, dedup);
      this._p('INSERT INTO queues(kind,userId,dedup,rec,at) VALUES(?,?,?,?,?)').run(kind, u, dedup, j(rec), num(rec.at) || Date.now());
      this._p('DELETE FROM queues WHERE id IN (SELECT id FROM queues WHERE kind=? AND userId=? ORDER BY id DESC LIMIT -1 OFFSET ?)').run(kind, u, cap);
    });
  }
  _qdrain(kind, u) {
    const rows = this._p('SELECT id,rec FROM queues WHERE kind=? AND userId=? ORDER BY id ASC').all(kind, u);
    if (rows.length) this._p('DELETE FROM queues WHERE kind=? AND userId=?').run(kind, u);
    return rows.map((r) => p(r.rec));
  }
  pushReceipt(u, rec) { this._qpush('receipt', u, rec, 1000); }
  drainReceipts(u) { return this._qdrain('receipt', u); }
  pushDeletion(u, d) { this._qpush('deletion', u, d, 2000); }
  drainDeletions(u) { return this._qdrain('deletion', u); }
  pushInvite(u, inv) { this._qpush('invite', u, inv, 500, inv.id != null ? String(inv.id) : null); }
  drainInvites(u) { return this._qdrain('invite', u); }
  pushKeyReq(u, req) { this._qpush('keyReq', u, req, 500, `${req.roomId}|${req.from}`); }
  drainKeyReqs(u) { return this._qdrain('keyReq', u); }

  // ── История (E2E-конверты) ──────────────────────────────────────────────────
  appendHistory(userId, { roomId, envelope }) {
    const seq = ++this.seq;
    const entry = { seq, at: Date.now(), roomId: roomId || null, msgId: envelope.msgId || null, toDevice: envelope.toDevice || null, envelope };
    this._p('INSERT INTO history(seq,userId,at,roomId,msgId,toDevice,envelope) VALUES(?,?,?,?,?,?,?)').run(seq, userId, entry.at, entry.roomId, entry.msgId, entry.toDevice, j(envelope));
    return entry;
  }
  _rowToEntry(r) { return { seq: num(r.seq), at: num(r.at), roomId: r.roomId || null, msgId: r.msgId || null, toDevice: r.toDevice || null, envelope: p(r.envelope) }; }
  historySince(userId, since = 0, deviceId = null) {
    const rows = deviceId == null
      ? this._p('SELECT * FROM history WHERE userId=? AND seq>? ORDER BY seq ASC').all(userId, since)
      : this._p('SELECT * FROM history WHERE userId=? AND seq>? AND (toDevice IS NULL OR toDevice=?) ORDER BY seq ASC').all(userId, since, deviceId);
    return rows.map((r) => this._rowToEntry(r));
  }
  historyForRoom(userId, roomId, since = 0, deviceId = null) {
    const rows = deviceId == null
      ? this._p('SELECT * FROM history WHERE userId=? AND roomId=? AND seq>? ORDER BY seq ASC').all(userId, roomId, since)
      : this._p('SELECT * FROM history WHERE userId=? AND roomId=? AND seq>? AND (toDevice IS NULL OR toDevice=?) ORDER BY seq ASC').all(userId, roomId, since, deviceId);
    return rows.map((r) => this._rowToEntry(r));
  }
  dmPeers(userId) {
    const rows = this._p(`SELECT json_extract(envelope,'$.from') AS peer, MAX(at) AS lastAt, COUNT(*) AS cnt
      FROM history WHERE userId=? AND roomId IS NULL AND peer IS NOT NULL AND peer<>? GROUP BY peer ORDER BY lastAt DESC`).all(userId, userId);
    return rows.map((r) => ({ peer: r.peer, lastAt: num(r.lastAt), count: num(r.cnt) }));
  }
  hasMessage(userId, msgId, toDevice = null) { if (!msgId) return false; return !!this._p("SELECT 1 FROM history WHERE userId=? AND msgId=? AND IFNULL(toDevice,'')=IFNULL(?,'') LIMIT 1").get(userId, msgId, toDevice); }
  findMessage(msgId) { const r = this._p('SELECT * FROM history WHERE msgId=? LIMIT 1').get(msgId); return r ? this._rowToEntry(r) : null; }
  deleteMessage(msgId) {
    const users = this._p('SELECT DISTINCT userId FROM history WHERE msgId=?').all(msgId).map((r) => r.userId);
    if (users.length) this._p('DELETE FROM history WHERE msgId=?').run(msgId);
    return users;
  }
  pruneHistory(effectiveSecondsFor) {
    const now = Date.now(); let removed = 0;
    const users = this._p('SELECT DISTINCT userId FROM history').all().map((r) => r.userId);
    for (const u of users) {
      const rows = this._p('SELECT * FROM history WHERE userId=?').all(u);
      const drop = [];
      for (const r of rows) { const sec = effectiveSecondsFor(this._rowToEntry(r)); if (isFinite(sec) && num(r.at) < now - sec * 1000) drop.push(num(r.seq)); }
      for (let i = 0; i < drop.length; i += 500) { const chunk = drop.slice(i, i + 500); this.db.prepare(`DELETE FROM history WHERE seq IN (${chunk.map(() => '?').join(',')})`).run(...chunk); }
      removed += drop.length;
    }
    return removed;
  }

  // ── Комнаты ─────────────────────────────────────────────────────────────────
  _saveRoom(r) { this._tx(() => { this._p('INSERT OR REPLACE INTO rooms(id,data,updatedAt) VALUES(?,?,?)').run(r.id, j(r), Date.now()); this._p('DELETE FROM room_members WHERE roomId=?').run(r.id); for (const m of new Set([...(r.members || []), ...(r.subscribers || [])].filter(Boolean))) this._p('INSERT OR IGNORE INTO room_members(userId,roomId) VALUES(?,?)').run(m, r.id); }); return r; }
  createRoom(r) { return this._saveRoom(r); }
  saveRoom(r) { return this._saveRoom(r); }
  getRoom(id) { const r = this._p('SELECT data FROM rooms WHERE id=?').get(id); return r ? p(r.data) : null; }
  allRooms() { return this._p('SELECT data FROM rooms').all().map((r) => p(r.data)); }
  roomsForUser(u) { const ids = this._p('SELECT roomId FROM room_members WHERE userId=?').all(u).map((r) => r.roomId); return ids.map((id) => this.getRoom(id)).filter(Boolean); }

  // ── Кошелёк 👻 ──────────────────────────────────────────────────────────────
  wallet(u) { let r = this._p('SELECT balance,tx FROM wallets WHERE userId=?').get(u); if (!r) { this._p('INSERT OR IGNORE INTO wallets(userId,balance,tx) VALUES(?,0,?)').run(u, j([])); r = { balance: 0, tx: '[]' }; } return { balance: num(r.balance), tx: p(r.tx, []) }; }
  _walletApply(u, delta, tx) {
    return this._tx(() => {
      this._p('INSERT OR IGNORE INTO wallets(userId,balance,tx) VALUES(?,0,?)').run(u, j([]));
      const cur = this._p('SELECT balance,tx FROM wallets WHERE userId=?').get(u);
      const bal = num(cur.balance) + delta;
      if (bal < 0) throw new Error('Недостаточно 👻 на балансе');
      let list = p(cur.tx, []);
      if (tx) { list.unshift({ ...tx, amount: delta, at: Date.now() }); if (list.length > 200) list = list.slice(0, 200); }
      this._p('UPDATE wallets SET balance=?, tx=? WHERE userId=?').run(bal, j(list), u);
      return bal;
    });
  }
  credit(u, a, tx) { return this._walletApply(u, a, tx); }
  debit(u, a, tx) { return this._walletApply(u, -a, tx); }

  // ── Каналы: ключи/секреты/посты ─────────────────────────────────────────────
  grantChannelKeys(roomId, userId, keys) { this._tx(() => { for (const k of keys) this._p('INSERT OR REPLACE INTO channel_keys(roomId,userId,epoch,wrapped) VALUES(?,?,?,?)').run(roomId, userId, String(k.epoch), k.wrapped); }); }
  getChannelKeys(roomId, userId) { const out = {}; for (const r of this._p('SELECT epoch,wrapped FROM channel_keys WHERE roomId=? AND userId=?').all(roomId, userId)) out[String(r.epoch)] = r.wrapped; return out; }
  setChannelSecret(roomId, epoch, keyHex) { this._p('INSERT OR REPLACE INTO channel_secrets(roomId,epoch,keyHex) VALUES(?,?,?)').run(roomId, String(epoch), keyHex); }
  getChannelSecrets(roomId) { const out = {}; for (const r of this._p('SELECT epoch,keyHex FROM channel_secrets WHERE roomId=?').all(roomId)) out[String(r.epoch)] = r.keyHex; return out; }
  appendChannelPost(roomId, post) { const seq = ++this.seq; const entry = { seq, at: Date.now(), ...post }; this._p('INSERT INTO channel_posts(seq,roomId,at,data) VALUES(?,?,?,?)').run(seq, roomId, entry.at, j(entry)); return entry; }
  channelHistory(roomId, since = 0) { return this._p('SELECT data FROM channel_posts WHERE roomId=? AND seq>? ORDER BY seq ASC').all(roomId, since).map((r) => p(r.data)); }

  // ── Реакции на посты канала ─────────────────────────────────────────────────
  _reactGet(roomId, msgId) { const r = this._p('SELECT data FROM channel_reactions WHERE roomId=? AND msgId=?').get(roomId, msgId); return r ? p(r.data) : null; }
  _reactPut(roomId, msgId, rec) { this._p('INSERT OR REPLACE INTO channel_reactions(roomId,msgId,data) VALUES(?,?,?)').run(roomId, msgId, j(rec)); }
  toggleReaction(roomId, msgId, emoji, userId) {
    const rec = this._reactGet(roomId, msgId) || { emojis: {}, paid: { total: 0, byUser: {} } };
    const arr = (rec.emojis[emoji] ||= []);
    const i = arr.indexOf(userId);
    if (i >= 0) { arr.splice(i, 1); if (!arr.length) delete rec.emojis[emoji]; } else arr.push(userId);
    this._reactPut(roomId, msgId, rec);
    return this.reactionSummary(roomId, msgId, userId);
  }
  addPaidReaction(roomId, msgId, userId, amount) {
    const rec = this._reactGet(roomId, msgId) || { emojis: {}, paid: { total: 0, byUser: {} } };
    rec.paid ||= { total: 0, byUser: {} };
    rec.paid.total += amount; rec.paid.byUser[userId] = (rec.paid.byUser[userId] || 0) + amount;
    this._reactPut(roomId, msgId, rec);
    return this.reactionSummary(roomId, msgId, userId);
  }
  reactionSummary(roomId, msgId, forUser = null) {
    const rec = this._reactGet(roomId, msgId);
    if (!rec) return { counts: {}, total: 0, mine: [], paid: 0, myPaid: 0, paidCount: 0 };
    const counts = {}; const mine = [];
    for (const [emoji, users] of Object.entries(rec.emojis || {})) { if (users.length) counts[emoji] = users.length; if (forUser && users.includes(forUser)) mine.push(emoji); }
    return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), mine, paid: rec.paid?.total || 0, myPaid: (forUser && rec.paid?.byUser?.[forUser]) || 0, paidCount: rec.paid ? Object.keys(rec.paid.byUser || {}).length : 0 };
  }
  reactionsForRoom(roomId, forUser = null) { const out = {}; for (const r of this._p('SELECT msgId FROM channel_reactions WHERE roomId=?').all(roomId)) out[r.msgId] = this.reactionSummary(roomId, r.msgId, forUser); return out; }
  removeReactions(roomId, msgId) { this._p('DELETE FROM channel_reactions WHERE roomId=? AND msgId=?').run(roomId, msgId); }

  // ── Исходящая очередь федерации (небольшая, держим в памяти + snapshot в meta) ─
  enqueueOutbox(item) { this.outbox.push(item); this.saveOutbox(); }
  outboxAll() { return this.outbox; }
  removeOutbox(id) { const n = this.outbox.length; this.outbox = this.outbox.filter((x) => x.id !== id); if (this.outbox.length !== n) this.saveOutbox(); }
  saveOutbox() { this._meta('outbox', j(this.outbox)); }
  pruneOutbox(cutoffMs) { const n = this.outbox.length; this.outbox = this.outbox.filter((x) => x.at >= cutoffMs); const dropped = n - this.outbox.length; if (dropped) this.saveOutbox(); return dropped; }

  // ── Последний визит ─────────────────────────────────────────────────────────
  setLastSeen(userId, ts) { this._p('INSERT OR REPLACE INTO last_seen(userId,ts) VALUES(?,?)').run(userId, num(ts)); }
  getLastSeen(userId) { const r = this._p('SELECT ts FROM last_seen WHERE userId=?').get(userId); return r ? num(r.ts) : 0; }

  close() { try { this._meta('seq', j(this.seq)); } catch {} try { this.db.close(); } catch {} }
}
