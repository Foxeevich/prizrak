// server.js — HTTP-эндпоинты узла-тайника (/dd/*). Тела бинарные/JSON.
// Для маскировки корень отдаёт безобидную страницу «It works» (как у relay) — на случай
// активного зондирования цензором. В проде узел ставится за тот же стелс/Reality-прокси, что и
// homeserver (TLS-фронт), поэтому здесь чистый HTTP.
import http from 'node:http';
import { RateLimiter, sampleSubset, clientKey } from './antienum.js';
import { powVerify } from './hardening.js';
import { signNodeClaim } from './crypto.js';

const DECOY = '<!doctype html><html><body><h1>It works</h1></body></html>';

// Локальная статус-страница оператора (только с localhost). Открывается в браузере —
// Electron не нужен. Тянет /dd/health с того же origin (без CORS).
const STATUS_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<title>Prizrak — узел-тайник</title><style>
:root{color-scheme:dark}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1219;color:#e6edf3}
.wrap{padding:22px;max-width:640px}h1{font-size:18px;margin:0 0 2px}.sub{color:#8b98a5;font-size:12px;margin-bottom:16px}
.badge{display:inline-block;padding:3px 9px;border-radius:10px;font-size:12px;font-weight:600}.on{background:#173a26;color:#4ade80}.off{background:#3a1717;color:#f87171}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.card{background:#131c26;border:1px solid #1e2a36;border-radius:12px;padding:12px 14px}
.k{color:#8b98a5;font-size:11px;text-transform:uppercase;letter-spacing:.04em}.v{font-size:20px;font-weight:700;margin-top:4px}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}.foot{margin-top:16px;color:#66727e;font-size:11px;line-height:1.5}
</style></head><body><div class="wrap">
<h1>👻 Prizrak — узел-тайник <span id="st" class="badge off">офлайн</span></h1>
<div class="sub">Зашифрованное промежуточное хранилище. Содержимое узлу недоступно.</div>
<div class="card"><div class="k">ID узла (публичный ключ)</div><div id="nodeId" class="mono">…</div></div>
<div class="grid">
<div class="card"><div class="k">Аптайм</div><div id="uptime" class="v">…</div></div>
<div class="card"><div class="k">Версия</div><div id="ver" class="v" style="font-size:15px">…</div></div>
<div class="card"><div class="k">Блобов хранится</div><div id="blobs" class="v">0</div></div>
<div class="card"><div class="k">Занято на диске</div><div id="bytes" class="v">0</div></div>
<div class="card"><div class="k">Ящиков</div><div id="mailboxes" class="v">0</div></div>
<div class="card"><div class="k">Доставлено (ACK)</div><div id="acks" class="v">0</div></div>
<div class="card"><div class="k">Известно узлов</div><div id="peers" class="v">0</div></div>
</div>
<div class="card" style="margin-top:12px"><div class="k">Привязать узел к аккаунту (для наград 👻)</div>
<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input id="op" placeholder="ваш ник: user:domain" style="flex:1;min-width:200px;padding:8px 10px;border-radius:8px;border:1px solid #1e2a36;background:#0c1018;color:#e6edf3;font-size:13px"><button id="genBtn" style="padding:8px 14px;border-radius:8px;border:none;background:#5b8cff;color:#fff;font-weight:600;cursor:pointer">Получить код</button></div>
<div id="claimBox" style="display:none;margin-top:10px"><div class="k">Код привязки — вставьте его в приложении (Мои узлы → Привязать):</div><div id="claimCode" class="mono" style="margin-top:6px;background:#0c1018;border:1px solid #1e2a36;border-radius:8px;padding:10px;cursor:pointer" title="нажмите, чтобы скопировать"></div></div></div>
<div class="foot">Данные зашифрованы отправителем — узел никогда не может их прочитать.</div></div>
<script>
const $=(i)=>document.getElementById(i);
const fb=(n)=>n<1024?n+' Б':n<1048576?(n/1024).toFixed(1)+' КБ':n<1073741824?(n/1048576).toFixed(1)+' МБ':(n/1073741824).toFixed(2)+' ГБ';
const fu=(ms)=>{const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+'д ':'')+(h?h+'ч ':'')+m+'м'};
async function tick(){try{const s=await(await fetch('/dd/health')).json();$('st').className='badge on';$('st').textContent='онлайн';
$('nodeId').textContent=s.nodeId;$('uptime').textContent=fu(s.uptimeMs);$('ver').textContent='v'+s.version;
$('blobs').textContent=s.blobs;$('bytes').textContent=fb(s.bytes);$('mailboxes').textContent=s.mailboxes;$('acks').textContent=s.acks;$('peers').textContent=s.peers??0;
}catch{$('st').className='badge off';$('st').textContent='офлайн'}}
tick();setInterval(tick,2000);
$('genBtn').onclick=async()=>{const u=$('op').value.trim();if(!u)return;try{const r=await(await fetch('/dd/claim?user='+encodeURIComponent(u))).json();if(!r.ok){alert(r.reason||'ошибка');return;}$('claimBox').style.display='block';$('claimCode').textContent=r.code;}catch{alert('не удалось получить код')}};
$('claimCode').onclick=()=>{navigator.clipboard&&navigator.clipboard.writeText($('claimCode').textContent);$('claimCode').style.borderColor='#4ade80';setTimeout(()=>{$('claimCode').style.borderColor='#1e2a36'},600);};
</script></body></html>`;

function isLocal(req) {
  const a = req.socket && req.socket.remoteAddress || '';
  return a.includes('127.0.0.1') || a === '::1' || a.includes('::ffff:127.0.0.1');
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > maxBytes) { reject(new Error('too-large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const sendJSON = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b); };
const sendBin = (res, code, buf) => { res.writeHead(code, { 'content-type': 'application/octet-stream', 'content-length': buf.length }); res.end(buf); };
const decoy = (res, code = 200) => { const b = Buffer.from(DECOY); res.writeHead(code, { server: 'nginx', 'content-type': 'text/html; charset=utf-8', 'content-length': b.length }); res.end(b); };

export function createServer({ store, identity, registry = null, directory = null, version = '0.1.0', startedAt = Date.now(), maxBlobBytes = 16 * 1024 * 1024, listPageMax = 24, listRate = null, powBits = 0 }) {
  // Фаза 6c: анти-энумерация листингов (rate-limit по IP + частичное представление).
  const listLimiter = new RateLimiter(listRate || { capacity: 20, refillPerSec: 0.5 });
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;

      // Локальная статус-страница оператора (в браузере, без Electron). Только с localhost.
      if (req.method === 'GET' && path === '/status') {
        if (!isLocal(req)) return decoy(res, 404);
        const b = Buffer.from(STATUS_HTML);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length });
        return res.end(b);
      }

      // Код привязки к аккаунту оператора (Фаза 7). Только с localhost (оператор у своей машины).
      // Возвращает строку-код: base64url(JSON{relayId,userId,sig}) — её оператор вставит в приложении.
      if (req.method === 'GET' && path === '/dd/claim') {
        if (!isLocal(req)) return decoy(res, 404);
        const userId = (url.searchParams.get('user') || '').trim();
        if (!/^[a-z0-9_.-]{1,64}:[a-z0-9.-]{3,}$/i.test(userId)) return sendJSON(res, 400, { ok: false, reason: 'нужен ник вида user:domain' });
        const sig = signNodeClaim(identity.priv, identity.nodeId, userId);
        const code = Buffer.from(JSON.stringify({ relayId: identity.nodeId, userId, sig })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return sendJSON(res, 200, { ok: true, relayId: identity.nodeId, userId, code });
      }

      // Здоровье узла (для скоринга/аптайма и статус-UI).
      if (req.method === 'GET' && path === '/dd/health') {
        return sendJSON(res, 200, { nodeId: identity.nodeId, version, uptimeMs: Date.now() - startedAt, ...store.stats(), peers: registry ? registry.size() : 0, servers: directory ? directory.size() : 0, powBits });
      }

      // ── Директория серверов (несём и разносим, Фаза 6a) ─────────────────────
      if (req.method === 'POST' && path === '/directory/announce') {
        if (!directory) return sendJSON(res, 200, { ok: true, count: 0 });
        const body = JSON.parse((await readBody(req, 512 * 1024)).toString() || '{}');
        const recs = Array.isArray(body.records) ? body.records : (body.domain ? [body] : []);
        return sendJSON(res, 200, { ok: true, count: directory.upsertMany(recs) });
      }
      if (req.method === 'GET' && path === '/directory/list') {
        if (!listLimiter.allow('dir:' + clientKey(req))) return sendJSON(res, 429, { ok: false, reason: 'rate' });
        const all = directory ? directory.list() : [];
        return sendJSON(res, 200, { ok: true, records: sampleSubset(all, listPageMax), total: all.length, partial: all.length > listPageMax });
      }

      // ── Реестр узлов (госсип) ──────────────────────────────────────────────
      // Приём чужих подписанных записей (announce). Тело: { records:[…] } или одна запись.
      if (req.method === 'POST' && path === '/registry/announce') {
        if (!registry) return sendJSON(res, 200, { ok: true, count: 0 });
        const body = JSON.parse((await readBody(req, 512 * 1024)).toString() || '{}');
        const recs = Array.isArray(body.records) ? body.records : (body.relayId ? [body] : []);
        return sendJSON(res, 200, { ok: true, count: registry.upsertMany(recs) });
      }
      // Отдать известные записи (для обмена). Фаза 6c: throttle + частичное представление,
      // чтобы цензор не выкачал весь список узлов за пару запросов. Приватные bridge-узлы
      // сюда не попадают вовсе (они себя не регистрируют — см. node.js).
      if (req.method === 'GET' && path === '/registry/list') {
        if (!listLimiter.allow('reg:' + clientKey(req))) return sendJSON(res, 429, { ok: false, reason: 'rate' });
        const all = registry ? registry.list() : [];
        return sendJSON(res, 200, { ok: true, records: sampleSubset(all, listPageMax), total: all.length, partial: all.length > listPageMax });
      }

      // PUT блоба: тело = ciphertext, метаданные в заголовках.
      if (req.method === 'PUT' && path === '/dd/put') {
        const ct = await readBody(req, maxBlobBytes + 4096);
        // Фаза 6: admission-PoW. Если узел требует PoW, без валидного nonce блоб не принимаем
        // (флуд становится дорогим). Nonce считается над msgId — привязан к конкретному блобу.
        if (powBits > 0 && !powVerify(req.headers['x-dd-msgid'], req.headers['x-dd-pow'], powBits)) {
          return sendJSON(res, 400, { ok: false, reason: 'pow' });
        }
        const r = store.put({
          msgId: req.headers['x-dd-msgid'],
          mailbox: req.headers['x-dd-mailbox'],
          epoch: Number(req.headers['x-dd-epoch'] || 0),
          expiry: Number(req.headers['x-dd-expiry'] || 0),
          ct,
        });
        return sendJSON(res, r.ok ? 200 : 400, r);
      }

      // POLL ящика: { mailbox, since } → список блобов.
      if (req.method === 'POST' && path === '/dd/poll') {
        const { mailbox, since } = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
        if (!mailbox) return sendJSON(res, 400, { ok: false, reason: 'no-mailbox' });
        return sendJSON(res, 200, { ok: true, items: store.poll(mailbox, Number(since || 0)) });
      }

      // GET блоба по msgId.
      if (req.method === 'GET' && path.startsWith('/dd/get/')) {
        const id = path.slice('/dd/get/'.length);
        const buf = store.get(id);
        return buf ? sendBin(res, 200, buf) : sendJSON(res, 404, { ok: false, reason: 'not-found' });
      }

      // ACK доставки: { msgId, pub, sig }.
      if (req.method === 'POST' && path === '/dd/ack') {
        const { msgId, pub, sig } = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
        const r = store.ack({ msgId, pub, sig });
        return sendJSON(res, r.ok ? 200 : 400, r);
      }

      // HAVE: { msgIds } → { acked, present }.
      if (req.method === 'POST' && path === '/dd/have') {
        const { msgIds } = JSON.parse((await readBody(req, 256 * 1024)).toString() || '{}');
        return sendJSON(res, 200, { ok: true, ...store.have(Array.isArray(msgIds) ? msgIds : []) });
      }

      // Всё прочее — страница-обманка.
      return decoy(res, path === '/' ? 200 : 404);
    } catch (e) {
      try { return sendJSON(res, 400, { ok: false, reason: String(e.message || e) }); } catch {}
    }
  });
}
