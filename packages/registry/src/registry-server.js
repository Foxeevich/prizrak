// registry-server.js — реестр ПУБЛИЧНЫХ групп федерации Prizrak (tech.prizrak.im).
//
// Homeserver'ы публикуют сюда подписанные записи своих публичных групп/каналов;
// клиенты ищут по подстроке в названии/описании («Рыбал» → все группы с этим словом).
//
// Безопасность и приватность:
//   • Публикуются ТОЛЬКО публичные комнаты (privacy='public') — решает владелец группы.
//   • Каждая запись подписана Ed25519-ключом сервера-дома; подпись проверяется.
//   • TOFU по домену: первый публикатор фиксирует ключ домена; чужим ключом записи
//     домена не перезаписать. Плюс best-effort сверка с /.well-known/prizrak/server.
//   • Анти-спам: лимит запросов по IP, лимит групп на домен, TTL записей (7 дней
//     без переподтверждения — запись исчезает; homeserver переподтверждает каждые 6ч).
//
// Хранилище: SQLite (node:sqlite, WAL) — без внешних зависимостей.
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519';

const utf8 = (s) => new TextEncoder().encode(s);
const hexToBytes = (h) => Uint8Array.from((h.match(/.{2}/g) || []).map((b) => parseInt(b, 16)));

// Канонические байты записи — 1:1 с makeGroupRecord в packages/server/src/deaddrop-fed.js.
export const regRecBytes = (r) => utf8(JSON.stringify({ roomId: r.roomId, domain: r.domain, name: r.name, description: r.description, members: r.members, type: r.type, updatedAt: r.updatedAt, ed: r.ed, del: !!r.del }));
export function verifyGroupRecord(record, sig) {
  if (!record || typeof record.roomId !== 'string' || typeof record.domain !== 'string' || typeof record.ed !== 'string' || typeof sig !== 'string') return false;
  try { return ed25519.verify(hexToBytes(sig), regRecBytes(record), hexToBytes(record.ed)); } catch { return false; }
}

const TTL_MS = 7 * 24 * 3600 * 1000;       // запись живёт 7 дней без переподтверждения
const MAX_PER_DOMAIN = 200;                 // лимит групп на один домен (анти-спам)
const RATE_PER_MIN = 60;                    // лимит запросов с одного IP в минуту

export async function startRegistry({ port = 8830, dbPath = './registry.sqlite', wellKnownCheck = true } = {}) {
  // node:sqlite — глушим ExperimentalWarning, как в сторе homeserver'а.
  const origEmit = process.emit;
  process.emit = function (ev, warn, ...rest) {
    if (ev === 'warning' && warn && warn.name === 'ExperimentalWarning' && String(warn.message).includes('SQLite')) return false;
    return origEmit.call(this, ev, warn, ...rest);
  };
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('Нужен Node.js ≥ 22.5 (встроенный node:sqlite)'); }
  finally { process.emit = origEmit; }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS domains(
    domain TEXT PRIMARY KEY, ed TEXT NOT NULL, firstSeen INTEGER, verified INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS groups(
    roomId TEXT PRIMARY KEY, domain TEXT NOT NULL, name TEXT, description TEXT,
    nameLower TEXT, descLower TEXT, members INTEGER, type TEXT, updatedAt INTEGER, expiresAt INTEGER)`);
  db.exec('CREATE INDEX IF NOT EXISTS gi_name ON groups(nameLower)');
  db.exec('CREATE INDEX IF NOT EXISTS gi_dom ON groups(domain)');
  const stmts = new Map();
  const P = (sql) => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };
  const num = (v) => Number(v);

  // Token-bucket по IP.
  const buckets = new Map();
  function allow(ip) {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) { b = { tokens: RATE_PER_MIN, at: now }; buckets.set(ip, b); }
    b.tokens = Math.min(RATE_PER_MIN, b.tokens + ((now - b.at) / 60000) * RATE_PER_MIN);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  const rateGc = setInterval(() => { const cut = Date.now() - 600000; for (const [k, b] of buckets) if (b.at < cut) buckets.delete(k); }, 300000);
  if (rateGc.unref) rateGc.unref();

  // TTL-чистка протухших записей.
  const gc = () => { P('DELETE FROM groups WHERE expiresAt < ?').run(Date.now()); };
  const gcTimer = setInterval(gc, 3600 * 1000);
  if (gcTimer.unref) gcTimer.unref();
  gc();

  // Best-effort сверка ключа домена с /.well-known/prizrak/server (кэш успеха в domains.verified).
  async function wellKnownVerify(dom, edHex) {
    if (!wellKnownCheck) return false;
    try {
      const r = await fetch(`https://${dom}/.well-known/prizrak/server`, { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      return !!(j && j.keys && j.keys.ed === edHex);
    } catch { return false; }
  }

  // TOFU: домен → ключ. true = ключ принят для домена.
  async function domainKeyOk(dom, edHex) {
    const row = P('SELECT ed, verified FROM domains WHERE domain=?').get(dom);
    if (!row) {
      const verified = (await wellKnownVerify(dom, edHex)) ? 1 : 0;
      P('INSERT INTO domains(domain,ed,firstSeen,verified) VALUES(?,?,?,?)').run(dom, edHex, Date.now(), verified);
      return true;
    }
    if (row.ed === edHex) return true;
    // Ключ сменился: принимаем ТОЛЬКО если новый подтверждён well-known (переезд сервера).
    if (await wellKnownVerify(dom, edHex)) { P('UPDATE domains SET ed=?, verified=1 WHERE domain=?').run(edHex, dom); return true; }
    return false;
  }

  function handlePublish(rec, sig, del) {
    const dom = rec.domain;
    if (rec.del !== del) return { status: 400, body: { error: 'Флаг del не соответствует эндпоинту' } };
    if (!rec.roomId.endsWith(':' + dom)) return { status: 400, body: { error: 'roomId не принадлежит домену' } };
    if (Math.abs(Date.now() - rec.updatedAt) > 24 * 3600 * 1000) return { status: 400, body: { error: 'Слишком старая метка времени' } };
    if (del) {
      P('DELETE FROM groups WHERE roomId=?').run(rec.roomId);
      return { status: 200, body: { ok: true, removed: true } };
    }
    const cnt = num(P('SELECT COUNT(*) c FROM groups WHERE domain=?').get(dom).c);
    const exists = P('SELECT roomId FROM groups WHERE roomId=?').get(rec.roomId);
    if (!exists && cnt >= MAX_PER_DOMAIN) return { status: 429, body: { error: 'Лимит групп для домена' } };
    P(`INSERT INTO groups(roomId,domain,name,description,nameLower,descLower,members,type,updatedAt,expiresAt)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(roomId) DO UPDATE SET name=excluded.name, description=excluded.description,
         nameLower=excluded.nameLower, descLower=excluded.descLower, members=excluded.members,
         type=excluded.type, updatedAt=excluded.updatedAt, expiresAt=excluded.expiresAt`)
      .run(rec.roomId, dom, rec.name, rec.description, rec.name.toLowerCase(), rec.description.toLowerCase(),
        rec.members, rec.type, rec.updatedAt, Date.now() + TTL_MS);
    return { status: 200, body: { ok: true } };
  }

  function search(q, limit) {
    const needle = '%' + q.toLowerCase().replace(/[%_]/g, '') + '%';
    const rows = P(`SELECT roomId, domain, name, description, members, type, updatedAt FROM groups
       WHERE nameLower LIKE ? OR descLower LIKE ?
       ORDER BY members DESC, updatedAt DESC LIMIT ?`).all(needle, needle, limit);
    return rows.map((r) => ({ ...r, members: num(r.members), updatedAt: num(r.updatedAt) }));
  }

  const server = createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
    try {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').toString().split(',')[0].trim();
      if (!allow(ip)) return json(429, { error: 'Слишком много запросов' });
      const url = new URL(req.url, 'http://x');
      const Pth = url.pathname;

      if (req.method === 'GET' && (Pth === '/' || Pth === '/api/stats')) {
        const g = num(P('SELECT COUNT(*) c FROM groups').get().c);
        const d = num(P('SELECT COUNT(*) c FROM domains').get().c);
        return json(200, { service: 'prizrak-group-registry', groups: g, domains: d });
      }
      if (req.method === 'GET' && Pth === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 2) return json(400, { error: 'Минимум 2 символа' });
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        return json(200, { results: search(q, limit) });
      }
      if (req.method === 'POST' && (Pth === '/api/publish' || Pth === '/api/unpublish')) {
        let body = '';
        for await (const ch of req) { body += ch; if (body.length > 64 * 1024) { req.destroy(); return; } }
        let j; try { j = JSON.parse(body); } catch { return json(400, { error: 'Некорректный JSON' }); }
        const rec = j.record, sig = j.sig;
        if (!verifyGroupRecord(rec, sig)) return json(403, { error: 'Подпись не прошла проверку' });
        if (!(await domainKeyOk(rec.domain, rec.ed))) return json(403, { error: 'Ключ не совпадает с ключом домена' });
        const out = handlePublish(rec, sig, Pth === '/api/unpublish');
        return json(out.status, out.body);
      }
      return json(404, { error: 'Неизвестный маршрут' });
    } catch (e) { return json(500, { error: 'Внутренняя ошибка' }); }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, () => resolve()); });
  const close = () => { try { server.close(); } catch {} try { clearInterval(gcTimer); clearInterval(rateGc); } catch {} try { db.close(); } catch {} };
  return { server, db, port: server.address().port, close };
}
