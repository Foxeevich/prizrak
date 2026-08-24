// C4: маскировка = настоящий TLS. Сервер с cert/key слушает TLS-порт по HTTPS/WSS
// (трафик неотличим от обычного HTTPS), не-TLS порт остаётся HTTP.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createServer } from '../packages/server/src/server.js';
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const get = (mod, url, opts) => new Promise((resolve, reject) => {
  const req = mod.get(url, opts || {}, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: d })); });
  req.on('error', reject); req.setTimeout(4000, () => req.destroy(new Error('timeout')));
});

const CERT = '/tmp/prizrak-tls-cert.pem', KEY = '/tmp/prizrak-tls-key.pem';
if (!existsSync(CERT) || !existsSync(KEY)) {
  try { execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${KEY} -out ${CERT} -days 3 -subj "/CN=localhost"`, { stdio: 'ignore' }); }
  catch { console.log('⚠ openssl недоступен — пропускаю TLS-тест'); process.exit(0); }
}

const HTTP_PORT = 8990, TLS_PORT = 8991;
const s = await createServer({
  domain: 'localhost', port: HTTP_PORT, ports: [HTTP_PORT, TLS_PORT], tlsPorts: [TLS_PORT],
  tlsCert: CERT, tlsKey: KEY, storePath: null, storagePaths: ['/tmp/mTls'], registrationEnabled: true,
});
ok(s.boundPorts.includes(HTTP_PORT) && s.boundPorts.includes(TLS_PORT), 'сервер слушает оба порта');

// TLS-порт отвечает по HTTPS (самоподписанный сертификат в тесте принимаем).
const rTls = await get(https, `https://localhost:${TLS_PORT}/_prizrak/client/v1/config`, { rejectUnauthorized: false });
ok(rTls.ok, 'TLS-порт отвечает по HTTPS (настоящий TLS)');
ok(JSON.parse(rTls.body).domain === 'localhost', 'через TLS отдаётся корректный config');

// Обычный HTTP на TLS-порт не проходит (это именно TLS).
let plainFailed = false;
try { await get(http, `http://localhost:${TLS_PORT}/_prizrak/client/v1/config`); } catch { plainFailed = true; }
ok(plainFailed, 'обычный HTTP на TLS-порт не проходит (порт реально под TLS)');

// Не-TLS порт остаётся обычным HTTP.
const rHttp = await get(http, `http://localhost:${HTTP_PORT}/_prizrak/client/v1/config`);
ok(rHttp.ok, 'не-TLS порт отвечает по обычному HTTP');

console.log('🎉 настоящий TLS на 443-подобных портах (C4) — ок');
s.closeAll();
