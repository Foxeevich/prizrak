// Кольцо прогресса при скачивании файла получателем работает только если сервер
// отдаёт Content-Length на media/raw (по нему клиент считает %). Проверяем заголовок
// и что onProgress реально вызывается с числовым процентом, а файл цел.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8989, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'd.org', port: P, storePath: null, storagePaths: ['/tmp/mDlp'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:d.org`, baseUrl: U, bankBase: U }).init(); await c.register(`${n}-pass-123`); return c; };

const alice = await mk('alice');
const bob = await mk('bob');

// Файл ~2 МБ.
const bytes = new Uint8Array(2 * 1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
const up = await alice.sendAttachment('bob:d.org', bytes, { filename: 'big.bin', mime: 'application/octet-stream' });
await bob.receive();
const att = { mediaId: up.mediaId, key: up.key, nonce: up.nonce, filename: 'big.bin', size: bytes.length };

// 1) media/raw отдаёт Content-Length (это и питает кольцо прогресса).
const raw = await fetch(`${U}/_prizrak/client/v1/media/raw?id=${encodeURIComponent(up.mediaId)}`, { headers: { authorization: `Bearer ${bob.token}` } });
ok(raw.ok, 'media/raw доступен получателю');
ok(Number(raw.headers.get('content-length')) > 0, `media/raw отдаёт Content-Length (${raw.headers.get('content-length')})`);
await raw.arrayBuffer();

// 2) Скачивание с прогрессом: onProgress вызывается, доходит до 100, файл цел.
const seen = [];
const out = await bob.fetchAttachmentProgress(att, { onProgress: (p) => seen.push(p) });
ok(seen.length > 0 && seen.every((p) => typeof p === 'number'), 'onProgress вызывается с числовым процентом');
ok(seen[seen.length - 1] === 100, 'прогресс доходит до 100%');
ok(out.length === bytes.length && out[123] === (123 & 255), 'скачанный файл цел и расшифрован');

console.log('🎉 прогресс скачивания (кольцо у крестика) — ок');
s.server.close();
