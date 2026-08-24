// botapi-server.js — Prizrak Bot API: упрощённый аналог Telegram Bot API.
//
// Модель 1:1 с Telegram (https://core.telegram.org/bots/api), но проще:
//   • URL:      http://<server>:8840/bot<TOKEN>/METHOD
//   • Конверт:  {ok:true, result:…} | {ok:false, error_code, description}
//   • Методы:   getMe · sendMessage {chat_id, text} · getUpdates {offset, limit, timeout}
//   • Update:   {update_id, message:{message_id, from, chat, date, text}}
//
// Роль BotFather играет админ сервера: POST /admin/createBot (X-Admin-Token) создаёт
// боту НАСТОЯЩИЙ аккаунт на homeserver'е через @prizrak/client — бот участвует в E2E
// как обычный пользователь (ключи бота хранятся здесь, на своём сервере).
//
// Хранилище: SQLite (node:sqlite, WAL) — боты + очереди обновлений.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { PrizrakClient } from '../../client/src/client.js';

const hex = (n) => randomBytes(n).toString('hex');
const nowSec = () => Math.floor(Date.now() / 1000);

// ── Хранилище ────────────────────────────────────────────────────────────────
export function openStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL, userId TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'bot',
    creator TEXT,
    state TEXT, createdAt INTEGER NOT NULL)`);
  try { db.exec("ALTER TABLE bots ADD COLUMN kind TEXT NOT NULL DEFAULT 'bot'"); } catch {}
  try { db.exec('ALTER TABLE bots ADD COLUMN creator TEXT'); } catch {}
  db.exec(`CREATE TABLE IF NOT EXISTS updates (
    botId INTEGER NOT NULL, updateId INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (botId, updateId))`);
  return db;
}
const nextUpdateId = (db, botId) => {
  const r = db.prepare('SELECT MAX(updateId) AS m FROM updates WHERE botId=?').get(botId);
  return (Number(r?.m) || 0) + 1;
};

// ── Сервис ───────────────────────────────────────────────────────────────────
export async function startBotApi({ port = 8840, dbPath, adminToken, domain, baseUrl = null, inviteCode = null }) {
  if (!adminToken) throw new Error('BOTAPI_ADMIN_TOKEN обязателен (роль BotFather)');
  if (!domain) throw new Error('BOTAPI_DOMAIN обязателен (домен вашего homeserver’а)');
  const db = openStore(dbPath);
  const clients = new Map();  // botId → PrizrakClient
  const waiters = new Map();  // botId → [resolve,…] — подвешенные getUpdates (long-poll)
  const persistT = new Map(); // botId → таймер отложенного сохранения состояния

  // Состояние клиента (ратчет-сессии!) меняется на каждом сообщении — сохраняем с троттлингом.
  const persistSoon = (botId) => {
    clearTimeout(persistT.get(botId));
    persistT.set(botId, setTimeout(() => {
      const cl = clients.get(botId); if (!cl) return;
      try { db.prepare('UPDATE bots SET state=? WHERE id=?').run(JSON.stringify(cl.serializeState()), botId); } catch {}
    }, 300));
  };

  const pushUpdate = (botId, message) => {
    const updateId = nextUpdateId(db, botId);
    db.prepare('INSERT INTO updates(botId,updateId,payload) VALUES(?,?,?)')
      .run(botId, updateId, JSON.stringify({ update_id: updateId, message }));
    for (const resolve of waiters.get(botId) || []) resolve(); // будим long-poll
    waiters.delete(botId);
  };

  // Входящее событие от homeserver'а → Update в стиле Telegram.
  const onEvent = (botId, botUserId) => (e) => {
    if (!e || e.error) return;
    if (e.kind !== 'text' && e.kind !== 'attachment') { persistSoon(botId); return; } // hs/receipt/… — не для бота
    if (e.from === botUserId) { persistSoon(botId); return; }                          // свои же сообщения
    const chat = e.roomId
      ? { id: e.roomId, type: 'group' }
      : { id: e.from, type: 'private' };
    const message = {
      message_id: e.msgId || hex(8),
      from: { id: e.from, username: (e.from || '').split(':')[0], is_bot: false },
      chat, date: nowSec(),
    };
    if (e.kind === 'text') message.text = e.text;
    else message.document = { file_name: e.attachment?.filename || 'file', mime_type: e.attachment?.mime || '', file_size: e.attachment?.size || 0 };
    pushUpdate(botId, message);
    persistSoon(botId);
  };

  // Создать аккаунт бота на homeserver'е и завести карточку. Общее для админ-API и PrizrakFather.
  const createBotAccount = async ({ login, name, password, inviteCode: ic, creator }) => {
    const inviteCodeEff = ic ?? inviteCode; // код из запроса или общий (конфиг сервера)
    login = String(login || '').trim().toLowerCase();
    name = String(name || login).trim();
    if (!/^[a-z0-9_]{3,32}$/.test(login)) throw Object.assign(new Error('login: 3–32 символа [a-z0-9_]'), { code: 400 });
    const userId = `${login}:${domain}`;
    if (db.prepare('SELECT id FROM bots WHERE userId=?').get(userId)) throw Object.assign(new Error('такой бот уже есть'), { code: 409 });
    const pw = password || hex(16);
    const base = baseUrl || await PrizrakClient.resolveBaseUrl(domain);
    const cl = await new PrizrakClient({ name: login, userId, baseUrl: base, deviceId: 'bot-' + hex(4) }).init();
    await cl.register(pw, { inviteCode: inviteCodeEff });
    // ВАЖНО: публикуем device-ключи бота (как делают обычные клиенты). Без этого
    // мультиустройственные собеседники не находят сессию к ответам бота («нет сессии»).
    try { await cl.publishDevice(); } catch {}
    const info = db.prepare('INSERT INTO bots(login,userId,name,token,password,kind,creator,state,createdAt) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(login, userId, name, 't-' + hex(12), pw, 'bot', creator || null, JSON.stringify(cl.serializeState()), nowSec());
    const botId = Number(info.lastInsertRowid);
    const token = `${botId}:${hex(16)}`;
    db.prepare('UPDATE bots SET token=? WHERE id=?').run(token, botId);
    clients.set(botId, cl);
    await cl.connectRealtime(onEvent(botId, userId));
    return { id: botId, username: login, user_id: userId, token };
  };

  // ── 👻 PrizrakFather — аналог BotFather: боты создаются в чате с ним ────────
  // Пользователь пишет prizrakfather:<домен> команды /newbot, /mybots, /revoke, /deletebot.
  const fatherDialogs = new Map(); // userId → {step, name} — простая машина состояний
  const FATHER_LOGIN = 'prizrakfather';
  const fatherHelp = 'Я создаю ботов Призрака (аналог BotFather).\n\n'
    + '/newbot — создать бота\n/mybots — мои боты\n/revoke <login> — новый токен (старый отзовётся)\n/deletebot <login> — удалить бота\n\n'
    + `API: http://<этот сервер>:8840/bot<token>/… (getMe, sendMessage, getUpdates). Документация: ${process.env.BOTAPI_DOCS_URL || 'https://prizrak.im/api.html'}`;

  const onFatherMessage = async (fatherCl, e) => {
    if (e.kind !== 'text' || e.roomId) return; // отец говорит только в личке
    const from = e.from; const text = String(e.text || '').trim();
    const reply = (t) => fatherCl.send(from, t).catch(() => {});
    const st = fatherDialogs.get(from);
    try {
      if (text === '/start' || text === '/help' || text === 'help') { fatherDialogs.delete(from); return reply(fatherHelp); }
      if (text === '/newbot') { fatherDialogs.set(from, { step: 'name' }); return reply('Как назовём бота? Пришлите имя (например: Погодный бот).'); }
      if (text === '/mybots') {
        const rows = db.prepare("SELECT login,name FROM bots WHERE kind='bot' AND creator=? ORDER BY id").all(from);
        return reply(rows.length ? 'Ваши боты:\n' + rows.map((r) => `• @${r.login} — ${r.name}`).join('\n') : 'У вас пока нет ботов. Создайте: /newbot');
      }
      if (text.startsWith('/revoke ')) {
        const login = text.slice(8).trim().replace(/^@/, '');
        const row = db.prepare("SELECT * FROM bots WHERE kind='bot' AND login=? AND creator=?").get(login, from);
        if (!row) return reply('Не нашёл такого вашего бота. /mybots — список.');
        const token = `${row.id}:${hex(16)}`;
        db.prepare('UPDATE bots SET token=? WHERE id=?').run(token, row.id);
        return reply(`Новый токен @${row.login} (старый больше не работает):\n\n${token}`);
      }
      if (text.startsWith('/deletebot ')) {
        const login = text.slice(11).trim().replace(/^@/, '');
        const row = db.prepare("SELECT * FROM bots WHERE kind='bot' AND login=? AND creator=?").get(login, from);
        if (!row) return reply('Не нашёл такого вашего бота. /mybots — список.');
        try { clients.get(row.id)?.disconnectRealtime?.(); } catch {}
        clients.delete(row.id);
        db.prepare('DELETE FROM updates WHERE botId=?').run(row.id);
        db.prepare('DELETE FROM bots WHERE id=?').run(row.id);
        return reply(`Бот @${login} удалён.`);
      }
      if (st?.step === 'name') {
        if (!text || text.startsWith('/')) { fatherDialogs.delete(from); return reply('Отменено.'); }
        fatherDialogs.set(from, { step: 'login', name: text });
        return reply('Теперь логин бота: 3–32 символа, латиница/цифры/подчёркивание (например: weather_bot).');
      }
      if (st?.step === 'login') {
        fatherDialogs.delete(from);
        const r = await createBotAccount({ login: text.replace(/^@/, ''), name: st.name, creator: from });
        return reply(`Готово! Бот @${r.username} создан.\n\nТокен (сохраните, показывается один раз):\n${r.token}\n\n`
          + `ID бота: ${r.user_id}\nПроверка: curl http://<этот сервер>:${port}/bot${r.token}/getMe\n\n`
          + 'Чтобы бот писал в группу/канал — добавьте его туда участником (по ID выше), затем sendMessage с chat_id = id комнаты (!…).');
      }
      return reply(fatherHelp);
    } catch (err) { return reply('Ошибка: ' + err.message); }
  };

  // Поднять клиента бота из сохранённого состояния и подключить real-time.
  const bootBot = async (row) => {
    try {
      const cl = PrizrakClient.fromState(JSON.parse(row.state));
      cl.deviceId = cl.deviceId || 'bot-' + hex(4);
      clients.set(row.id, cl);
      if (row.kind === 'father') await cl.connectRealtime((e) => { onFatherMessage(cl, e); persistSoon(row.id); });
      else await cl.connectRealtime(onEvent(row.id, row.userId));
      // Переподтверждаем device-ключи на каждом старте: лечит ботов, созданных до
      // фикса «нет сессии» (device не был опубликован), и ничего не ломает остальным.
      cl.publishDevice().then(() => persistSoon(row.id)).catch(() => {});
      console.log(`[botapi] ✅ ${row.kind === 'father' ? '👻 PrizrakFather' : 'бот @' + row.login} (${row.userId}) в сети`);
    } catch (e) { console.log(`[botapi] ⚠️ бот @${row.login} не поднялся: ${e.message}`); }
  };
  for (const row of db.prepare('SELECT * FROM bots WHERE state IS NOT NULL').all()) await bootBot(row);

  // PrizrakFather заводится сам при первом старте сервиса.
  if (!db.prepare("SELECT id FROM bots WHERE kind='father'").get()) {
    try {
      const base = baseUrl || await PrizrakClient.resolveBaseUrl(domain);
      const userId = `${FATHER_LOGIN}:${domain}`;
      const pw = hex(16);
      const cl = await new PrizrakClient({ name: FATHER_LOGIN, userId, baseUrl: base, deviceId: 'bot-' + hex(4) }).init();
      await cl.register(pw, { inviteCode }); // общий инвайт-код сервера, если регистрация «по коду»
      try { await cl.publishDevice(); } catch {} // device-ключи — иначе «нет сессии» у собеседников
      const info = db.prepare('INSERT INTO bots(login,userId,name,token,password,kind,creator,state,createdAt) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(FATHER_LOGIN, userId, 'PrizrakFather', 'father-' + hex(12), pw, 'father', null, JSON.stringify(cl.serializeState()), nowSec());
      const fid = Number(info.lastInsertRowid);
      clients.set(fid, cl);
      await cl.connectRealtime((e) => { onFatherMessage(cl, e); persistSoon(fid); });
      console.log(`[botapi] ✅ 👻 PrizrakFather создан: ${userId} — пишите ему /newbot`);
    } catch (e) { console.log('[botapi] ⚠️ PrizrakFather не создался: ' + e.message); }
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────
  const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(data)); };
  const okRes  = (res, result) => json(res, 200, { ok: true, result });
  const errRes = (res, code, description) => json(res, code, { ok: false, error_code: code, description });
  const readBody = (req) => new Promise((resolve) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const qs = Object.fromEntries(url.searchParams);

      // ── Админ (BotFather): создать/список/удалить ботов ────────────────────
      if (url.pathname.startsWith('/admin/')) {
        if (req.headers['x-admin-token'] !== adminToken) return errRes(res, 401, 'нужен X-Admin-Token');
        const body = await readBody(req);
        if (req.method === 'POST' && url.pathname === '/admin/createBot') {
          try {
            const r = await createBotAccount({ login: body.login, name: body.name, password: body.password, inviteCode: body.inviteCode, creator: 'admin' });
            return okRes(res, r);
          } catch (e) { return errRes(res, e.code || 500, 'регистрация бота: ' + e.message); }
        }
        if (req.method === 'GET' && url.pathname === '/admin/bots') {
          return okRes(res, db.prepare("SELECT id,login,userId,name,creator,createdAt FROM bots WHERE kind='bot' ORDER BY id").all());
        }
        if (req.method === 'POST' && url.pathname === '/admin/deleteBot') {
          const id = Number(body.id || 0);
          const row = db.prepare("SELECT * FROM bots WHERE id=? AND kind='bot'").get(id);
          if (!row) return errRes(res, 404, 'нет такого бота');
          try { clients.get(id)?.disconnectRealtime?.(); } catch {}
          clients.delete(id);
          db.prepare('DELETE FROM updates WHERE botId=?').run(id);
          db.prepare('DELETE FROM bots WHERE id=?').run(id);
          return okRes(res, true);
        }
        return errRes(res, 404, 'неизвестный админ-метод');
      }

      // ── Bot API: /bot<TOKEN>/METHOD (как в Telegram) ───────────────────────
      const m = url.pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
      if (!m) return errRes(res, 404, 'ожидается /bot<token>/метод');
      const [, token, method] = m;
      const bot = db.prepare("SELECT * FROM bots WHERE token=? AND kind='bot'").get(token);
      if (!bot) return errRes(res, 401, 'неверный токен бота');
      const body = req.method === 'POST' ? await readBody(req) : {};
      const p = { ...qs, ...body }; // параметры: query и/или JSON — как у Telegram

      if (method === 'getMe') {
        return okRes(res, { id: bot.id, is_bot: true, username: bot.login, user_id: bot.userId, first_name: bot.name });
      }

      if (method === 'sendMessage') {
        const chatId = String(p.chat_id || '').trim(); const text = String(p.text || '');
        if (!chatId || !text) return errRes(res, 400, 'нужны chat_id и text');
        const cl = clients.get(bot.id);
        if (!cl) return errRes(res, 503, 'клиент бота не в сети (перезапустите botapi)');
        try {
          const r = chatId.startsWith('!') ? await cl.sendToRoom(chatId, text) : await cl.send(chatId, text);
          persistSoon(bot.id);
          return okRes(res, {
            message_id: r?.msgId || hex(8), date: nowSec(), text,
            chat: { id: chatId, type: chatId.startsWith('!') ? 'group' : 'private' },
            from: { id: bot.userId, is_bot: true, username: bot.login },
          });
        } catch (e) { return errRes(res, 500, 'отправка: ' + e.message); }
      }

      if (method === 'getUpdates') {
        const offset = Number(p.offset || 0);
        const limit = Math.min(Math.max(Number(p.limit || 100), 1), 100);
        const timeout = Math.min(Math.max(Number(p.timeout || 0), 0), 30);
        if (offset > 0) db.prepare('DELETE FROM updates WHERE botId=? AND updateId<?').run(bot.id, offset); // подтверждение — как у Telegram
        const fetchRows = () => db.prepare('SELECT payload FROM updates WHERE botId=? AND updateId>=? ORDER BY updateId LIMIT ?')
          .all(bot.id, offset, limit).map((r) => JSON.parse(r.payload));
        let rows = fetchRows();
        if (!rows.length && timeout > 0) { // long-poll: висим до нового сообщения или таймаута
          await new Promise((resolve) => {
            const list = waiters.get(bot.id) || []; list.push(resolve); waiters.set(bot.id, list);
            setTimeout(resolve, timeout * 1000);
          });
          rows = fetchRows();
        }
        return okRes(res, rows);
      }

      return errRes(res, 404, `метод ${method} не поддерживается (есть: getMe, sendMessage, getUpdates)`);
    } catch (e) { return errRes(res, 500, e.message); }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return { port: server.address().port, server, db, clients };
}
