// main.cjs — Electron-обёртка узла-тайника: поднимает узел в процессе и показывает статус-окно.
// Узел (ESM) грузим динамическим import из CJS-main.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let node = null;

async function boot() {
  const mod = await import(path.join(__dirname, '..', 'src', 'node.js'));
  node = mod.startNode({}); // конфиг из ENV (DD_PORT/DD_DATA/…)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 540, height: 480, resizable: true, title: 'Prizrak — узел-тайник',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('dd-status', () => node
  ? { nodeId: node.identity.nodeId, port: node.port, host: node.host, dataDir: node.dataDir, uptimeMs: Date.now() - node.startedAt, ...node.store.stats() }
  : null);

app.whenReady().then(async () => {
  try { await boot(); } catch (e) { console.error('[deaddrop] не удалось запустить узел:', e.message); }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { try { node && node.stop(); } catch {} if (process.platform !== 'darwin') app.quit(); });
