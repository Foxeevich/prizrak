// main.js — главный процесс Electron.
// Держит PrizrakClient, real-time, звонки, а также ЗАПОМИНАЕТ ВХОД и локальный
// кэш переписки (шифруются на диске локальным AES-256-GCM ключом) — после
// перезапуска не нужно логиниться и видна история.
import { app, BrowserWindow, ipcMain, Notification, nativeImage, shell, dialog, powerMonitor, Tray, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { PrizrakClient } from './lib/client.js';
import { verifyManifest, isNewer, sha256Hex, pickFile } from './updater.js';
import { buildLinkPreview, firstUrl } from './lib/link-preview.js';
import * as VpnMain from './lib/vpn.js';
// Тихо: нет ссылки / сайт не ответил → просто без карточки.
async function makePreview(text) { try { return firstUrl(text) ? await buildLinkPreview(text) : null; } catch { return null; } }

const __dir = dirname(fileURLToPath(import.meta.url));
// ВАЖНО: build/ — это build-time ресурсы electron-builder, они НЕ пакуются в приложение
// (в `files` их нет). Поэтому иконки берём из renderer/ (папка входит в сборку). В деве
// build/ ещё существует — оставляем как запасной путь. Плюс встроенный base64 на самый край,
// чтобы трей никогда не был пустым.
function firstIcon(paths, fallbackDataUrl) {
  for (const p of paths) { try { const im = nativeImage.createFromPath(p); if (im && !im.isEmpty()) return im; } catch {} }
  try { if (fallbackDataUrl) { const im = nativeImage.createFromDataURL(fallbackDataUrl); if (!im.isEmpty()) return im; } } catch {}
  return nativeImage.createEmpty();
}
const ICON = existsSync(join(__dir, 'renderer', 'appicon.png')) ? join(__dir, 'renderer', 'appicon.png') : join(__dir, 'build', 'icon.png');
// 32×32 значок трея (Windows/Linux). Встроенный base64 — гарантия, что иконка есть даже если файл не нашёлся.
const TRAY_ICON_FALLBACK = 'data:image/png;base64,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';
let win = null, client = null, currentCall = null, saveTimer = null, pendingDeepLink = null;
let tray = null;
app.isQuitting = false;

// ── Настройки приложения (главный процесс) ───────────────────────────────────
// «Сворачивать в трей при закрытии»: закрытие окна не выходит из приложения, а
// прячет его в системный трей (Windows/Linux) / строку меню (macOS). Хранится
// отдельным json в userData, чтобы читалось ДО создания окна.
const appCfgFile = () => join(app.getPath('userData'), 'prizrak-app.json');
let appCfg = { closeToTray: true };
function loadAppCfg() { try { const j = JSON.parse(readFileSync(appCfgFile(), 'utf8')); if (j && typeof j === 'object') appCfg = { ...appCfg, ...j }; } catch {} }
function saveAppCfg() { try { writeFileSync(appCfgFile(), JSON.stringify(appCfg)); } catch {} }

// ── Deep link: prizrak://join/<room> открывает приложение и вступает в канал ──
if (!app.requestSingleInstanceLock()) app.quit();
try { app.setAsDefaultProtocolClient('prizrak'); } catch {}
app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); });            // macOS
app.on('second-instance', (_e, argv) => { const u = argv.find((a) => a.startsWith('prizrak://')); if (u) handleDeepLink(u); if (win) { win.show(); win.focus(); } }); // Win/Linux

function handleDeepLink(url) { if (!url) return; if (client) processDeepLink(url); else pendingDeepLink = url; }
async function processDeepLink(url) {
  try {
    if (url.includes('/dm/') || url.includes('?dm=')) {
      const m = url.match(/[?&]dm=([^&#]+)/) || url.match(/\/dm\/([^?&#]+)/);
      if (m && win) { win.webContents.send('opened-dm', decodeURIComponent(m[1])); win.show(); win.focus(); }
      return;
    }
    if (url.includes('join/')) { const room = await client.joinByLink(url); if (win) { win.webContents.send('opened-room', room); win.show(); win.focus(); } }
  } catch (e) { if (win) win.webContents.send('deeplink-error', e.message); }
}

const sessionFile = () => join(app.getPath('userData'), 'prizrak-session.bin');
const uiFile = () => join(app.getPath('userData'), 'prizrak-ui.bin');
const keyFile = () => join(app.getPath('userData'), 'prizrak-local.key');
// MD1: стабильный id этого устройства (одна установка = одно устройство).
function getDeviceId() {
  const f = join(app.getPath('userData'), 'prizrak-device.id');
  try { if (existsSync(f)) { const v = readFileSync(f, 'utf8').trim(); if (v) return v; } } catch {}
  const v = crypto.randomBytes(8).toString('hex');
  try { writeFileSync(f, v); } catch {}
  return v;
}

// Локальный ключ шифрования данных на диске. Раньше использовался
// Electron safeStorage (macOS Keychain) — он на каждом запуске просил пароль
// связки ключей, потому что сборка подписана ad-hoc. Теперь шифруем локальным
// AES-256-GCM ключом в userData: тот же уровень «шифрования при хранении», но
// БЕЗ запроса пароля Keychain при каждом старте.
let LOCAL_KEY = null;
function localKey() {
  if (LOCAL_KEY) return LOCAL_KEY;
  try {
    if (existsSync(keyFile())) { LOCAL_KEY = readFileSync(keyFile()); if (LOCAL_KEY.length === 32) return LOCAL_KEY; }
  } catch {}
  LOCAL_KEY = crypto.randomBytes(32);
  try { writeFileSync(keyFile(), LOCAL_KEY, { mode: 0o600 }); } catch {}
  return LOCAL_KEY;
}
const MAGIC = Buffer.from('PZK2');
function encWrite(file, obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', localKey(), iv);
  const ct = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(file, Buffer.concat([MAGIC, iv, tag, ct]));
}
function decRead(file) {
  if (!existsSync(file)) return null;
  try {
    const buf = readFileSync(file);
    if (buf.subarray(0, 4).equals(MAGIC)) {
      const iv = buf.subarray(4, 16), tag = buf.subarray(16, 32), ct = buf.subarray(32);
      const d = crypto.createDecipheriv('aes-256-gcm', localKey(), iv);
      d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
    }
    // Совместимость со старым форматом PLAIN (без safeStorage). Старые
    // safeStorage-файлы прочитать нельзя — вернём null, пользователь войдёт заново.
    if (buf.subarray(0, 5).toString() === 'PLAIN') return JSON.parse(buf.subarray(5).toString('utf8'));
    return null;
  } catch { return null; }
}
function saveSession() { if (client) try { encWrite(sessionFile(), client.serializeState()); } catch {} }
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveSession, 800); }

const windows = new Set();
function broadcast(channel, payload) { for (const w of windows) { try { if (!w.isDestroyed()) w.webContents.send(channel, payload); } catch {} } }

// Буфер realtime-событий: при автологине сообщения-«догонялки» приходят ДО того,
// как рендерер загрузился и подписался. Копим их и отдаём, когда окно готово,
// иначе сообщение приходит «в никуда» и теряется (курсор уже сдвинут).
let rendererReady = false;
const rtBuffer = [];
function emitRealtime(ev) { if (rendererReady && windows.size) broadcast('realtime', ev); else { rtBuffer.push(ev); if (rtBuffer.length > 2000) rtBuffer.shift(); } }
ipcMain.handle('renderer-ready', () => { rendererReady = true; const buf = rtBuffer.splice(0); for (const ev of buf) broadcast('realtime', ev); return { ok: true }; });
function createWindow(focusChat = null) {
  const w = new BrowserWindow({
    width: 1080, height: 740, minWidth: 860, minHeight: 580,
    title: 'Prizrak', backgroundColor: '#0f1115', icon: ICON,
    webPreferences: { preload: join(__dir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  windows.add(w); win = w;
  w.on('focus', () => { win = w; });
  // Закрытие окна НЕ выходит из приложения (если включено): прячем окно, но
  // приложение остаётся работать в фоне и ВИДИМО в доке (macOS) / трее (Win/Linux).
  // Иконку дока НЕ прячем — иначе на Mac приложение выглядит закрытым и пропадает
  // из таскбара. Окно потом разворачивается кликом по доку/трею с сохранением состояния.
  w.on('close', (e) => {
    if (!app.isQuitting && appCfg.closeToTray && windows.size <= 1) {
      e.preventDefault();
      try { w.hide(); } catch {}
    }
  });
  w.on('closed', () => { windows.delete(w); if (win === w) win = [...windows][0] || null; });
  w.loadFile(join(__dir, 'renderer', 'index.html'));
  if (process.platform === 'win32' && _winOverlay) { try { w.once('ready-to-show', () => { try { w.setOverlayIcon(_winOverlay, ''); } catch {} }); } catch {} }
  if (focusChat) w.webContents.once('did-finish-load', () => setTimeout(() => { try { w.webContents.send('focus-chat', focusChat); } catch {} }, 500));
  return w;
}
ipcMain.handle('open-window', (_e, chat) => { createWindow(chat || null); return { ok: true }; });

// ── Системный трей ───────────────────────────────────────────────────────────
function showMain() {
  let w = win || [...windows][0];
  if (!w || w.isDestroyed()) w = createWindow();
  try { if (!w.isVisible()) w.show(); w.focus(); } catch {}
  try { if (process.platform === 'darwin' && app.dock) app.dock.show(); } catch {}
}
function buildTray() {
  if (tray) return;
  try {
    // Иконку трея берём из renderer/ (входит в сборку), с запасными путями и base64-фолбэком —
    // раньше указывал на build/icon.png, которого в упакованном .exe нет → пустой значок.
    let img = firstIcon([
      join(__dir, 'renderer', 'tray.png'),
      join(__dir, 'renderer', 'tray-32.png'),
      join(__dir, 'renderer', 'appicon.png'),
      join(__dir, 'build', 'icon.png'),
    ], TRAY_ICON_FALLBACK);
    if (!img.isEmpty()) img = img.resize(process.platform === 'darwin' ? { width: 18, height: 18 } : { width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('Prizrak');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть Prizrak', click: () => showMain() },
      { type: 'separator' },
      { label: 'Выйти', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => showMain());
    tray.on('double-click', () => showMain());
  } catch {}
}
ipcMain.handle('get-close-to-tray', () => ({ enabled: !!appCfg.closeToTray }));
ipcMain.handle('set-close-to-tray', (_e, { enabled }) => { appCfg.closeToTray = !!enabled; saveAppCfg(); return { ok: true }; });

// ── Бейдж непрочитанных на иконке приложения ─────────────────────────────────
// Цвет значка (красный/серый) задаёт рендерер и рисует картинку. Системный бейдж
// дока macOS всегда красный, поэтому на macOS ставим готовую иконку с уже
// нарисованным значком через app.dock.setIcon. На Windows — overlay на кнопке
// панели задач. На Linux — числовой бейдж (только красный, что ОС и позволяет).
let _winOverlay = null;
ipcMain.handle('set-badge', (_e, { count, red, overlay, dock }) => {
  const n = Math.max(0, Number(count) || 0);
  if (process.platform === 'darwin') {
    try { if (app.dock) app.dock.setIcon(n > 0 && dock ? nativeImage.createFromDataURL(dock) : nativeImage.createFromPath(ICON)); } catch {}
  } else if (process.platform === 'win32') {
    try {
      _winOverlay = (n > 0 && overlay) ? nativeImage.createFromDataURL(overlay) : null;
      for (const w of windows) { try { if (!w.isDestroyed()) w.setOverlayIcon(_winOverlay, n > 0 ? `${n}` : ''); } catch {} }
    } catch {}
  } else {
    try { app.setBadgeCount(n); } catch {}
  }
  return { ok: true };
});
let notifEnabled = true;
let mutedMap = {}; // convId → timestamp «замьючено до» (-1 = навсегда)
function isMuted(key) { const mu = key && mutedMap[key]; return !!mu && (mu === -1 || mu > Date.now()); }
function notify(title, body) { if (!notifEnabled) return; try { if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show(); } catch {} }
ipcMain.handle('set-muted', (_e, map) => { mutedMap = map || {}; return { ok: true }; });

function onRealtime(ev) {
  emitRealtime(ev); // буферизуется, если окно ещё не готово
  scheduleSave(); // курсор/сессии могли обновиться
  const muted = isMuted(ev.roomId || ev.from);
  if (ev.kind === 'text') { if (!muted) notify(`Сообщение от ${ev.from}`, ev.text); }
  else if (ev.kind === 'attachment') { if (!muted) notify(`Вложение от ${ev.from}`, ev.attachment.voice ? '🎤 голосовое' : `📎 ${ev.attachment.filename || 'файл'}`); }
  else if (ev.kind === 'call' && ev.call.event === 'offer') { notify('Входящий звонок', `${ev.from} звонит вам`); broadcast('incoming-call', ev); } // звонки звонят всегда
  else if (ev.kind === 'ghosts') { if (!muted) notify('Получены 👻', `${ev.from}: ${ev.amount} 👻`); }
  else if (ev.kind === 'invited') { if (!muted) notify('Приглашение', `Вас добавили: ${ev.room?.name || 'комната'}`); }
  else if (ev.error && ev.from) { if (!muted) notify(`Новое сообщение от ${ev.from}`, 'не удалось расшифровать — проверьте ключи/переустановите вход'); }
}
async function afterAuth(res) {
  try { await client.publishDevice(); } catch {} // MD1/MD2: опубликовать устройство ДО реалтайма (после adopt/восстановления ключей)
  await client.serverConfig(); await client.connectRealtime(onRealtime); saveSession();
  try { await client.bankRegister(); } catch {} // TOFU-регистрация ghost-key в Банке Призраков
  if (pendingDeepLink) { const u = pendingDeepLink; pendingDeepLink = null; setTimeout(() => processDeepLink(u), 400); }
  return { ...res, fingerprint: client.fingerprint };
}

// ── Аккаунт / автологин ──────────────────────────────────────────────────────
// C2: адрес без порта — клиент сам находит рабочий порт (авто-скан), возвращаем resolved baseUrl.
ipcMain.handle('config', async (_e, { baseUrl }) => {
  const resolved = await PrizrakClient.resolveBaseUrl(baseUrl);
  const cfg = await new PrizrakClient({ name: 'probe', userId: 'probe:x', baseUrl: resolved }).serverConfig();
  return { ...cfg, baseUrl: resolved };
});
ipcMain.handle('bootstrap', () => client ? { loggedIn: true, me: { userId: client.userId, isAdmin: client.isAdmin, fingerprint: client.fingerprint } } : { loggedIn: false });
ipcMain.handle('register', async (_e, a) => { const baseUrl = await PrizrakClient.resolveBaseUrl(a.baseUrl); client = await new PrizrakClient({ ...a, baseUrl, bankBase: PRIZRAK_WEB, deviceId: getDeviceId() }).init(); return afterAuth(await client.register(a.password, { inviteCode: a.inviteCode })); });
// B1: пер-аккаунтный локальный бэкап, чтобы логаут НЕ терял историю и сессии.
// Файлы шифруются тем же локальным ключом (encWrite/decRead). При входе тем же
// аккаунтом восстанавливаем ратчет-сессии и локальную переписку.
const acctHash = (userId) => crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
const acctFile = (userId) => join(app.getPath('userData'), 'acct-' + acctHash(userId) + '.bin');
const acctUiFile = (userId) => join(app.getPath('userData'), 'acct-ui-' + acctHash(userId) + '.bin');
ipcMain.handle('login', async (_e, a) => {
  const baseUrl = await PrizrakClient.resolveBaseUrl(a.baseUrl);
  client = await new PrizrakClient({ ...a, baseUrl, bankBase: PRIZRAK_WEB, deviceId: getDeviceId() }).init();
  const r = await client.login(a.password);
  // Перенять ратчет-сессии прошлого входа этого аккаунта (бэкап логаута или активная сессия).
  try { const prev = decRead(acctFile(a.userId)) || decRead(sessionFile()); if (prev) client.adoptSessionsFrom(prev); } catch {}
  // Восстановить локальную историю/группы этого аккаунта (или очистить чужую).
  try {
    if (existsSync(acctUiFile(a.userId))) copyFileSync(acctUiFile(a.userId), uiFile());
    else if (existsSync(uiFile())) rmSync(uiFile());
  } catch {}
  return afterAuth(r);
});
ipcMain.handle('logout', () => {
  // Не теряем данные: кладём зашифрованный бэкап аккаунта, потом гасим активную сессию.
  try {
    if (client) {
      try { encWrite(acctFile(client.userId), client.serializeState()); } catch {}
      try { if (existsSync(uiFile())) copyFileSync(uiFile(), acctUiFile(client.userId)); } catch {}
    }
  } catch {}
  try { client?.disconnectRealtime(); } catch {} client = null;
  try { rmSync(sessionFile()); } catch {} try { rmSync(uiFile()); } catch {}
  return { ok: true };
});
ipcMain.handle('whoami', () => client ? { userId: client.userId, isAdmin: client.isAdmin, fingerprint: client.fingerprint } : null);

// B2: экспорт/импорт копии аккаунта (офлайн-восстановление личности).
let _importFile = null;
ipcMain.handle('account-export', async (_e, { password }) => {
  if (!client) return { error: 'Вы не в аккаунте' };
  try {
    const data = client.exportBackupBlob(password);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `prizrak-${client.userId.split(':')[0]}.prizrakkey`,
      filters: [{ name: 'Prizrak account key', extensions: ['prizrakkey'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await writeFile(filePath, JSON.stringify(data, null, 2));
    return { saved: filePath };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('account-pick-file', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Prizrak account key', extensions: ['prizrakkey', 'json'] }] });
    if (canceled || !filePaths?.length) return { canceled: true };
    const f = JSON.parse(await readFile(filePaths[0], 'utf8'));
    if (!f || !f.userId || !f.blob) return { error: 'Некорректный файл копии аккаунта' };
    _importFile = f;
    return { userId: f.userId, baseUrl: f.baseUrl || '' };
  } catch (e) { return { error: e.message }; }
});
// B3: фраза восстановления
ipcMain.handle('seed-enable', async () => {
  if (!client) return { error: 'Вы не в аккаунте' };
  try { return { mnemonic: await client.enableSeedRecovery() }; } catch (e) { return { error: e.message }; }
});
ipcMain.handle('seed-recover', async (_e, { baseUrl, userId, mnemonic, newPassword }) => {
  try {
    if (!baseUrl || !userId) return { error: 'Укажите сервер и логин' };
    const bu = await PrizrakClient.resolveBaseUrl(baseUrl);
    client = await new PrizrakClient({ name: userId.split(':')[0], userId, baseUrl: bu, bankBase: PRIZRAK_WEB, deviceId: getDeviceId() }).init();
    const r = await client.recoverBySeed(mnemonic, newPassword);
    try { const prev = decRead(acctFile(userId)); if (prev) client.adoptSessionsFrom(prev); } catch {}
    try { if (existsSync(acctUiFile(userId))) copyFileSync(acctUiFile(userId), uiFile()); else if (existsSync(uiFile())) rmSync(uiFile()); } catch {}
    return await afterAuth(r);
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('account-import', async (_e, { baseUrl, filePassword, accountPassword }) => {
  if (!_importFile) return { error: 'Сначала выберите файл копии' };
  const f = _importFile;
  try {
    const secret = PrizrakClient.openBackupBlob(filePassword, f); // неверный пароль → throw
    const rawBu = baseUrl || f.baseUrl;
    if (!rawBu) return { error: 'Не указан сервер' };
    const bu = await PrizrakClient.resolveBaseUrl(rawBu);
    client = await new PrizrakClient({ name: f.userId.split(':')[0], userId: f.userId, baseUrl: bu, bankBase: PRIZRAK_WEB, deviceId: getDeviceId() }).init();
    const r = await client.loginWithSecret(accountPassword, secret);
    try { const prev = decRead(acctFile(f.userId)); if (prev) client.adoptSessionsFrom(prev); } catch {}
    try { if (existsSync(acctUiFile(f.userId))) copyFileSync(acctUiFile(f.userId), uiFile()); else if (existsSync(uiFile())) rmSync(uiFile()); } catch {}
    _importFile = null;
    return await afterAuth(r);
  } catch (e) { return { error: /tag|decrypt|open|json/i.test(e.message) ? 'Неверный пароль файла' : e.message }; }
});

// ── Локальный кэш переписки (история после перезапуска) ──────────────────────
ipcMain.handle('persist-ui', (_e, blob) => { try { encWrite(uiFile(), blob); } catch {} return { ok: true }; });
ipcMain.handle('load-ui', () => decRead(uiFile()) || null);

// ── Сообщения / комнаты ──────────────────────────────────────────────────────
// Превью ссылки собирает ОТПРАВИТЕЛЬ (main-процесс) и кладёт в шифртекст —
// получатель на сайт не ходит, его IP не утекает. Выключается в настройках.
ipcMain.handle('send-direct', async (_e, { peerId, text, previews }) => {
  const preview = previews === false ? null : await makePreview(text);
  const r = await client.send(peerId, text, preview); scheduleSave();
  return { msgId: r.msgId, delivered: r.delivered, preview };
});
ipcMain.handle('forward-attachment', async (_e, { peerId, attachment }) => { const r = await client.forwardAttachment(peerId, attachment); scheduleSave(); return { msgId: r.msgId, delivered: r.delivered }; });
// 🎁 Подарки
ipcMain.handle('privacy-get', () => client.getPrivacy());
ipcMain.handle('privacy-set', (_e, { privacy }) => client.setPrivacy(privacy));
ipcMain.handle('gift-catalog', () => client.giftCatalog());
ipcMain.handle('gift-send', async (_e, { to, giftId, msg, anon }) => { const r = await client.sendGift(to, { giftId, msg, anon }); scheduleSave(); return r; });
ipcMain.handle('gifts-of', (_e, { userId }) => client.giftsOf(userId));
ipcMain.handle('gifts-mine', () => client.myGifts());
ipcMain.handle('gift-convert', (_e, { id }) => client.convertGift(id));
ipcMain.handle('gift-hide', (_e, { id, hidden }) => client.hideGift(id, hidden));
ipcMain.handle('mark-read', (_e, { peerId, msgIds }) => { try { return client.markRead(peerId, msgIds); } catch { return null; } });
ipcMain.handle('sync-read', (_e, { convId }) => { try { client?.markReadSync(convId); } catch {} return { ok: true }; }); // MD4
ipcMain.handle('devices-list', async () => { try { return { devices: await client.myDevices() }; } catch (e) { return { error: e.message, devices: [] }; } }); // MD6
ipcMain.handle('device-revoke', async (_e, { deviceId }) => { try { await client.revokeDevice(deviceId); return { ok: true }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('mark-received', (_e, { peerId, msgIds }) => { try { return client.sendReceipt(peerId, msgIds, 'received'); } catch { return null; } });
ipcMain.handle('media-ensure', (_e, { attachment }) => client.ensureMedia(attachment).catch(() => false));
ipcMain.handle('media-head', (_e, { attachment }) => client.mediaHead(attachment).catch(() => ({ present: false })));
ipcMain.handle('media-federate', (_e, { mediaId, toDomain }) => client.federateMedia(mediaId, toDomain).catch(() => ({ ok: false })));
ipcMain.handle('media-push-status', (_e, { mediaId }) => client.pushStatus(mediaId).catch(() => ({ done: true })));
ipcMain.handle('delete-message', (_e, { msgId, peer }) => client.deleteMessage(msgId, peer));
ipcMain.handle('media-delete', (_e, { mediaId }) => client.deleteMedia(mediaId).catch(() => ({ ok: false })));
ipcMain.handle('room-role', (_e, { roomId, userId, role }) => client.setRoomRole(roomId, userId, role));
ipcMain.handle('room-transfer', (_e, { roomId, newOwner }) => client.transferRoom(roomId, newOwner));
ipcMain.handle('room-kick', (_e, { roomId, userId }) => client.kickMember(roomId, userId));
ipcMain.handle('room-ban', (_e, { roomId, userId }) => client.banMember(roomId, userId));
ipcMain.handle('room-unban', (_e, { roomId, userId }) => client.unbanMember(roomId, userId));
ipcMain.handle('room-readonly', (_e, { roomId, readOnly }) => client.setRoomReadOnly(roomId, readOnly));
ipcMain.handle('create-group', (_e, { name }) => client.createGroup(name));
ipcMain.handle('create-channel', (_e, { name }) => client.createChannel(name));
ipcMain.handle('list-rooms', () => client.listRooms());
ipcMain.handle('room-get', (_e, { roomId }) => client.getRoom(roomId));
ipcMain.handle('presence', (_e, { userId }) => client.presence(userId).catch(() => ({ online: false, lastSeen: 0, unknown: true })));
ipcMain.handle('room-join', async (_e, { roomId }) => { const r = await client.join(roomId); try { await client.ensureChannelKeys(roomId); } catch {} return r; });
ipcMain.handle('room-leave', (_e, { roomId }) => client.leave(roomId));
ipcMain.handle('invite', (_e, { roomId, userId }) => client.invite(roomId, userId));
ipcMain.handle('send-room', async (_e, { roomId, text, previews }) => {
  const preview = previews === false ? null : await makePreview(text);
  scheduleSave(); const r = await client.sendToRoom(roomId, text, preview); return { ...r, preview };
});
ipcMain.handle('get-history', (_e, { roomId }) => client.getHistory(roomId, 0));
ipcMain.handle('channel-history', async (_e, { roomId }) => {
  const posts = await client.getChannelHistory(roomId, 0);
  // Владелец/админ открыл канал → до-раздаём ключ участникам, кому не досталось
  // (например, инвайт не смог зашифровать на их ключ). Не блокируем ответ.
  client.resyncChannelKeys(roomId).then(() => scheduleSave()).catch(() => {});
  return posts;
});
ipcMain.handle('channel-reactions', (_e, { roomId }) => client.channelReactions(roomId).catch(() => ({})));
ipcMain.handle('channel-react', (_e, { roomId, msgId, emoji }) => client.reactChannel(roomId, msgId, emoji));
ipcMain.handle('channel-react-paid', async (_e, { roomId, msgId, amount, ownerId }) => { const r = await client.reactPaidChannel(roomId, msgId, amount, ownerId); scheduleSave(); return r; });
ipcMain.handle('room-reactions-settings', (_e, { roomId, ...opts }) => client.setRoomReactions(roomId, opts));
// Реакции в личных чатах (E2E)
ipcMain.handle('react-direct', (_e, { peerId, msgId, emoji, on }) => { scheduleSave(); return client.reactDirect(peerId, msgId, emoji, on); });
ipcMain.handle('react-paid-direct', async (_e, { peerId, msgId, amount }) => { const r = await client.reactPaidDirect(peerId, msgId, amount); scheduleSave(); return r; });

// ── Вложения ─────────────────────────────────────────────────────────────────
ipcMain.handle('attach-send', async (_e, { peerId, bytes, filename, mime, voice, dur, wave }) => { const up = await client.sendAttachment(peerId, new Uint8Array(bytes), { filename, mime, voice: !!voice, dur, wave }); return { msgId: up.msgId, delivered: up.delivered, queued: up.queued, media: { mediaId: up.mediaId, key: up.key, nonce: up.nonce } }; });
ipcMain.handle('attach-fetch', async (_e, { attachment }) => ({ bytes: Array.from(await client.fetchAttachment(attachment)) }));
// Превью картинки: скачать+расшифровать, положить в кэш (для перетаскивания/сохранения)
// И вернуть байты (для blob-превью — file:// запрещён CSP). Один проход.
ipcMain.handle('attach-cache', async (_e, { attachment }) => {
  try {
    const bytes = await client.fetchAttachment(attachment);
    const dir = join(app.getPath('userData'), 'cache'); mkdirSync(dir, { recursive: true });
    const safe = String(attachment.filename || 'file').replace(/[^\w.\- ]+/g, '_');
    const outPath = join(dir, (attachment.mediaId || 'img') + '-' + safe);
    await writeFile(outPath, Buffer.from(bytes));
    return { path: outPath, bytes: Array.from(bytes) };
  } catch (e) { return { error: e.message }; }
});
// Прочитать локальный файл из кэша (для восстановления превью после перезапуска).
ipcMain.handle('read-file', async (_e, { path }) => { try { return { bytes: Array.from(new Uint8Array(await readFile(path))) }; } catch (e) { return { error: e.message }; } });

// Скачивание файла в фоне с прогрессом → в кэш приложения; потом «Сохранить как…».
// Не гоняем большой файл через IPC — расшифрованные байты пишем в файл в main.
const cancelledDownloads = new Set();
ipcMain.handle('attach-cancel-download', (_e, { downloadId }) => { cancelledDownloads.add(downloadId); return { ok: true }; });
ipcMain.handle('attach-download', async (_e, { downloadId, attachment }) => {
  try {
    const bytes = await client.fetchAttachmentProgress(attachment, {
      onProgress: (percent) => { broadcast('download-progress', { downloadId, percent }); },
      isCancelled: () => cancelledDownloads.has(downloadId),
    });
    cancelledDownloads.delete(downloadId);
    const dir = join(app.getPath('userData'), 'cache'); mkdirSync(dir, { recursive: true });
    const safe = String(attachment.filename || 'file').replace(/[^\w.\- ]+/g, '_');
    const outPath = join(dir, downloadId + '-' + safe);
    await writeFile(outPath, Buffer.from(bytes));
    return { path: outPath };
  } catch (e) {
    cancelledDownloads.delete(downloadId);
    return e.cancelled ? { cancelled: true } : { error: e.message };
  }
});
// Открыть изображение в отдельном окне (превью → полный размер, как в Telegram).
ipcMain.handle('image-window', (_e, { path, title }) => {
  try {
    const iw = new BrowserWindow({ width: 980, height: 760, title: title || 'Изображение', backgroundColor: '#0f1115', autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    iw.loadFile(path); // Chromium сам отрисует картинку по центру
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});
// Нативный drag-out: перетащить СКАЧАННЫЙ файл из окна Prizrak в другое приложение
// или обратно в чат. startDrag можно вызвать только на стороне main во время жеста.
const DRAG_ICON = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAM0lEQVR42u3MMQ0AAAgDsOFf9BvBhQTS0nZ2RERERERERERERERERERERERERERERPzsAdY9AAF5m2n8AAAAAElFTkSuQmCC');
ipcMain.on('drag-out', (e, filePath) => {
  try {
    if (!filePath) return;
    let icon = nativeImage.createFromPath(filePath);
    if (icon.isEmpty()) icon = DRAG_ICON; else icon = icon.resize({ width: 96, height: 96 });
    e.sender.startDrag({ file: filePath, icon });
  } catch {}
});
// Открыть окно «Сохранить как…» и скопировать скачанный из кэша файл в выбранную папку.
ipcMain.handle('attach-open', async (_e, { path, filename }) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: filename || 'file' });
    if (canceled || !filePath) return { canceled: true };
    await copyFile(path, filePath);
    return { saved: filePath };
  } catch (e) { return { error: e.message }; }
});

// Загрузка файла с прогрессом и отменой (как в Telegram). path — для перетащенных
// файлов/пикера (не гоняем 100МБ через IPC как массив), bytes — для вставки из буфера.
const cancelledUploads = new Set();
ipcMain.handle('attach-cancel', (_e, { uploadId }) => { cancelledUploads.add(uploadId); return { ok: true }; });
ipcMain.handle('attach-upload', async (_e, { uploadId, peerId, path, bytes, filename, mime, voice }) => {
  let data;
  try { data = path ? new Uint8Array(await readFile(path)) : new Uint8Array(bytes || []); }
  catch (e) { return { error: 'Не удалось прочитать файл: ' + e.message }; }
  try {
    const up = await client.sendAttachment(peerId, data, {
      filename, mime: mime || 'application/octet-stream', voice: !!voice,
      onProgress: (percent) => { broadcast('upload-progress', { uploadId, percent }); },
      isCancelled: () => cancelledUploads.has(uploadId),
    });
    cancelledUploads.delete(uploadId); scheduleSave();
    return { msgId: up.msgId, size: data.length, delivered: up.delivered, queued: up.queued, media: { mediaId: up.mediaId, key: up.key, nonce: up.nonce } };
  } catch (e) {
    cancelledUploads.delete(uploadId);
    return e.cancelled ? { cancelled: true } : { error: e.message };
  }
});

// ── Кошелёк 👻 ──────────────────────────────────────────────────────────────
ipcMain.handle('wallet', () => client.wallet());
ipcMain.handle('ghosts-history', () => client.bankHistory());
ipcMain.handle('ghosts-send', (_e, a) => client.sendGhosts(a.to, a.amount, a.note));
ipcMain.handle('ghosts-buy', async (_e, a) => { const r = await client.buyGhosts(a.amount); if (r && r.payment_url) { try { shell.openExternal(r.payment_url); } catch {} } return r; });
ipcMain.handle('nodes-mine', () => client.bankMyNodes());
ipcMain.handle('nodes-bind', async (_e, a) => { try { const r = await client.bindNode(a.code); return { ok: true, relayId: r.relayId }; } catch (e) { return { error: e.message }; } });

// ── Настройки приложения: автозапуск и обновления ────────────────────────────
const PRIZRAK_WEB = process.env.PRIZRAK_WEB || 'https://prizrak.paymoney.online';
// 🛡 Призрак-VPN: оплата → тап по стране → ордер Банка → туннель. Никаких конфигов.
VpnMain.register(ipcMain, { getClient: () => client });
ipcMain.handle('get-autostart', () => { try { return { enabled: app.getLoginItemSettings().openAtLogin }; } catch { return { enabled: false }; } });
ipcMain.handle('set-autostart', (_e, { enabled }) => { try { app.setLoginItemSettings({ openAtLogin: !!enabled }); } catch {} return { ok: true }; });
ipcMain.handle('set-notif', (_e, { enabled }) => { notifEnabled = enabled !== false; return { ok: true }; });
// Быстрая проверка соединения (окно получило фокус / сеть вернулась) — пингуем WS,
// а если он мёртв, пересоздаём. Мгновенно оживляет «зомби»-коннект без перезапуска.
ipcMain.handle('net-poke', () => { try { client?.pokeConnection(); } catch {} return { ok: true }; });
ipcMain.handle('open-external', (_e, { url }) => { try { if (/^https?:\/\//.test(url)) shell.openExternal(url); } catch {} return { ok: true }; });
// ── Система обновлений: подписанный манифест → авто-загрузка → установка в 1 клик ──
// Источники манифеста (по порядку). Основной — скрытый канал обновлений (добавим
// следующим шагом), пока — подписанный manifest.json на сервере как резерв.
// Ссылки на пакеты берём из манифеста; всё защищено подписью мейнтейнера.
const UPDATE_FEEDS = [`${PRIZRAK_WEB}/api/update/manifest.json`];
const UPDATE_POLL_MS = 6 * 3600e3;
let _update = { state: 'idle', info: null, path: null, file: null, percent: 0 };
function updDir() { const d = join(app.getPath('temp'), 'prizrak-update'); try { mkdirSync(d, { recursive: true }); } catch {} return d; }
function emitUpd(kind, extra) { broadcast('update-status', { kind, state: _update.state, ...(extra || {}) }); }

// Скачать URL в файл с прогрессом; вернуть буфер (для сверки SHA-256).
async function downloadTo(url, destPath, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); got += value.length; if (total && onProgress) onProgress(Math.min(100, Math.round(got / total * 100))); }
  const buf = Buffer.concat(chunks);
  writeFileSync(destPath, buf);
  return buf;
}

// Проверить источники, вернуть {manifest, feed} с валидной подписью и новее текущей.
async function fetchManifest() {
  for (const feed of UPDATE_FEEDS) {
    try {
      const r = await fetch(feed, { cache: 'no-store' });
      if (!r.ok) continue;
      const m = await r.json();
      if (!verifyManifest(m)) continue;                 // чужая/битая подпись — пропускаем
      if (!isNewer(m.version, app.getVersion())) return { manifest: m, feed, upToDate: true };
      return { manifest: m, feed };
    } catch {}
  }
  return null;
}

// Полный цикл: проверить → (если новее и ещё не качали) скачать + сверить SHA-256.
async function runUpdateCheck({ auto = true } = {}) {
  if (_update.state === 'downloading' || _update.state === 'ready') return _update;
  _update.state = 'checking'; emitUpd('checking');
  const found = await fetchManifest();
  if (!found) { _update.state = 'idle'; emitUpd('none', { error: 'нет доступного манифеста' }); return _update; }
  if (found.upToDate) { _update.state = 'idle'; emitUpd('uptodate', { version: found.manifest.version }); return _update; }
  const file = pickFile(found.manifest, process.platform);
  if (!file) { _update.state = 'idle'; emitUpd('none', { error: 'нет пакета под платформу' }); return _update; }
  _update.info = { version: found.manifest.version, notes: found.manifest.notes };
  _update.file = file;
  const url = /^https?:\/\//.test(file.url || '') ? file.url : new URL(file.url || file.name, found.feed).toString();
  _update.state = 'downloading'; _update.percent = 0; emitUpd('downloading', { version: file.version || found.manifest.version, percent: 0 });
  try {
    const dest = join(updDir(), file.name);
    const buf = await downloadTo(url, dest, (p) => { _update.percent = p; emitUpd('downloading', { percent: p }); });
    if (sha256Hex(buf) !== String(file.sha256).toLowerCase()) throw new Error('SHA-256 не совпал — пакет повреждён/подменён');
    _update.path = dest; _update.state = 'ready';
    emitUpd('ready', { version: found.manifest.version, notes: found.manifest.notes });
  } catch (e) {
    _update.state = 'idle'; _update.path = null;
    emitUpd('error', { error: e.message });
  }
  return _update;
}

// Установка загруженного и проверенного пакета + перезапуск.
// macOS: подменяем .app и перезапускаем. Работает как из .zip, так и из .dmg —
// извлекаем .app (unzip или монтируем образ), заменяем текущий бандл, снимаем
// карантин и открываем заново. Полноценная установка «в один клик».
function macInstall(pkgPath) {
  const appRoot = process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
  const tmp = join(updDir(), 'swap-' + Date.now()); mkdirSync(tmp, { recursive: true });
  const isDmg = /\.dmg$/i.test(pkgPath);
  const extract = isDmg
    ? `MNT="${tmp}/mnt"; /bin/mkdir -p "$MNT"
/usr/bin/hdiutil attach -nobrowse -noautoopen -mountpoint "$MNT" "${pkgPath}"
SRC=$(/usr/bin/find "$MNT" -maxdepth 2 -name "*.app" -type d | head -1)`
    : `/usr/bin/ditto -x -k "${pkgPath}" "${tmp}"
SRC=$(/usr/bin/find "${tmp}" -maxdepth 3 -name "*.app" -type d | head -1)`;
  const detach = isDmg ? `/usr/bin/hdiutil detach "$MNT" -quiet 2>/dev/null || true` : `true`;
  const sh = `#!/bin/bash
set -e
sleep 1
${extract}
if [ -n "$SRC" ] && [ -n "${appRoot}" ]; then
  /bin/rm -rf "${appRoot}"
  /usr/bin/ditto "$SRC" "${appRoot}"
  /usr/bin/xattr -dr com.apple.quarantine "${appRoot}" 2>/dev/null || true
  ${detach}
  /usr/bin/open "${appRoot}"
else
  ${detach}
  /usr/bin/open "${pkgPath}"
fi`;
  const scriptPath = join(tmp, 'install.sh'); writeFileSync(scriptPath, sh); chmodSync(scriptPath, 0o755);
  spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
  app.isQuitting = true; app.quit();
}
function installUpdate() {
  const p = _update.path;
  if (!p || !existsSync(p)) return { ok: false, error: 'обновление не загружено' };
  try {
    if (process.platform === 'win32') {
      spawn(p, [], { detached: true, stdio: 'ignore' }).unref(); // NSIS-инсталлятор сам обновит и перезапустит
      app.isQuitting = true; app.quit();
    } else if (process.platform === 'linux') {
      const target = process.env.APPIMAGE;
      if (target) { copyFileSync(p, target); try { chmodSync(target, 0o755); } catch {} app.relaunch({ execPath: target }); app.isQuitting = true; app.exit(0); }
      else { shell.openPath(p); }
    } else { // darwin — из .zip или .dmg, установка в один клик
      macInstall(p);
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

ipcMain.handle('check-update', async () => {
  const before = _update.state;
  const r = await runUpdateCheck({ auto: false });
  const cur = app.getVersion();
  if (r.state === 'ready') return { current: cur, latest: r.info?.version, isNewer: true, ready: true, notes: r.info?.notes };
  if (r.state === 'downloading') return { current: cur, latest: r.info?.version, isNewer: true, downloading: true, percent: r.percent };
  return { current: cur, latest: r.info?.version || cur, isNewer: false };
});
ipcMain.handle('update-state', () => ({ ..._update }));
ipcMain.handle('update-install', () => installUpdate());

// ── Профили и «Поделиться» ───────────────────────────────────────────────────
// ── Верификация и шаринг контакта ────────────────────────────────────────────
ipcMain.handle('safety-status', async (_e, { userId }) => { const s = await client.verificationStatus(userId); return s; });
ipcMain.handle('safety-verify', async (_e, { userId }) => { const fp = await client.markVerified(userId); saveSession(); return { ok: true, fingerprint: fp }; });
ipcMain.handle('safety-unverify', (_e, { userId }) => { client.unverify(userId); saveSession(); return { ok: true }; });
ipcMain.handle('contact-share', (_e, { userId }) => client.contactShare(userId));
ipcMain.handle('safety-qr', async (_e, { text }) => {
  try { const QR = (await import('qrcode')).default; const dataUrl = await QR.toDataURL(text, { margin: 1, width: 220, color: { dark: '#0f1115', light: '#f5f8ff' } }); return { dataUrl }; }
  catch { return { dataUrl: null }; }
});
ipcMain.handle('get-profile', (_e, { userId }) => client.getProfile(userId));
ipcMain.handle('set-profile', async (_e, { fields }) => { const r = await client.setProfile(fields); saveSession(); return r; });
ipcMain.handle('set-room-profile', (_e, { roomId, fields }) => client.setRoomProfile(roomId, fields));
ipcMain.handle('room-share', (_e, { roomId }) => client.roomShare(roomId));
ipcMain.handle('room-diag', (_e, { roomId }) => client.roomDiag(roomId));
ipcMain.handle('channel-resync', (_e, { roomId }) => client.resyncChannelKeys(roomId).then((r) => { scheduleSave(); return r || { ok: true }; }).catch((e) => ({ ok: false, error: e.message })));
ipcMain.handle('join-link', (_e, { link }) => client.joinByLink(link));

// ── Настройки: ретеншн комнаты и админ-хранилище ─────────────────────────────
ipcMain.handle('room-retention', (_e, { roomId, retention }) => client.setRoomRetention(roomId, retention));
ipcMain.handle('room-settings', (_e, { roomId, settings }) => client.setRoomSettings(roomId, settings));
ipcMain.handle('groups-search', (_e, { q }) => client.searchGroups(q));
ipcMain.handle('admin-storage-get', () => client.adminStorage());
ipcMain.handle('admin-storage-set', (_e, opts) => client.adminSetStorage(opts));

// ── Звонки ────────────────────────────────────────────────────────────────────
function pipeMedia(bytes) { broadcast('call-media', { bytes: Array.from(bytes) }); }
function pipeRaw() { broadcast('call-raw', {}); } // сырой кадр с relay (до расшифровки) — для диагностики приёма
// Управляющие пакеты от собеседника: PLI (подтип 1) → просим рендерер выдать ключевой кадр.
function pipeCtrl(payload) { try { if (payload && payload[0] === 7 && payload[1] === 1) broadcast('call-pli', {}); } catch {} }
ipcMain.handle('call-start', async (_e, { peerId, video }) => { const { call, callId } = await client.startCall(peerId, { video, onMedia: pipeMedia, onRaw: pipeRaw, onCtrl: pipeCtrl }); currentCall = { call, peerId, callId }; return { callId }; });
ipcMain.handle('call-accept', async (_e, { peerId, offer }) => { const call = await client.acceptCall(peerId, offer, { onMedia: pipeMedia, onRaw: pipeRaw, onCtrl: pipeCtrl }); currentCall = { call, peerId, callId: offer.callId }; return { ok: true }; });
ipcMain.handle('call-media', (_e, { chunk }) => { try { currentCall?.call.sendMedia(new Uint8Array(chunk)); } catch {} });
ipcMain.handle('call-pli-request', () => { try { currentCall?.call.requestKeyframe(); } catch {} return { ok: true }; });
ipcMain.handle('call-hangup', async () => { if (currentCall) { try { await client.hangupCall(currentCall.peerId, currentCall.callId); } catch {} currentCall.call.hangup(); currentCall = null; } return { ok: true }; });

app.whenReady().then(async () => {
  loadAppCfg();
  buildTray();
  try { if (process.platform === 'darwin' && app.dock) app.dock.setIcon(nativeImage.createFromPath(ICON)); } catch {}
  // Автологин: восстановить сессию, если сохранена.
  const state = decRead(sessionFile());
  if (state) { try { client = PrizrakClient.fromState(state); client.deviceId = getDeviceId(); await client.serverConfig(); await client.connectRealtime(onRealtime); try { await client.bankRegister(); } catch {} try { await client.publishDevice(); } catch {} } catch { client = null; } }
  createWindow();
  // При пробуждении Mac/ПК из сна и разблокировке экрана WS часто становится «зомби»
  // (close не приходит). Принудительно пересоздаём соединение — чтобы сразу вернулись
  // сообщения и входящие звонки без перезапуска приложения.
  try {
    const wake = () => { try { client?.forceReconnect(); } catch {} };
    powerMonitor.on('resume', wake);
    powerMonitor.on('unlock-screen', wake);
  } catch {}
  // Автопроверка обновлений: через 20 c после старта (не мешаем логину) и раз в 6 ч.
  setTimeout(() => { runUpdateCheck().catch(() => {}); }, 20000);
  setInterval(() => { runUpdateCheck().catch(() => {}); }, UPDATE_POLL_MS);
  // Ссылка при запуске (Windows/Linux — в argv; либо отложенная macOS open-url)
  const argvUrl = process.argv.find((a) => a.startsWith('prizrak://'));
  if (argvUrl) handleDeepLink(argvUrl);
  if (client && pendingDeepLink) { const u = pendingDeepLink; pendingDeepLink = null; win.webContents.once('did-finish-load', () => setTimeout(() => processDeepLink(u), 400)); }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showMain(); });
app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => { saveSession(); try { client?.disconnectRealtime(); } catch {} if (process.platform !== 'darwin') app.quit(); });
