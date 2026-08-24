// features-bigfile-test.js — чанковая загрузка большого файла с прогрессом,
// шифрование E2E, скачивание сырым потоком и расшифровка байт-в-байт.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));

const PORT = 8990, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true, storagePaths: ['/tmp/prizrak-bigfile-media'] });
line();

const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(`${n}-pass-123`); return c; };
const alice = await mk('alice'), bob = await mk('bob');

// 12 МБ псевдослучайных данных.
const SIZE = 12 * 1024 * 1024;
const data = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) data[i] = (i * 2654435761) & 0xff;

const progress = [];
const up = await alice.sendAttachment('bob:chat.org', data, {
  filename: 'big.bin', mime: 'application/octet-stream',
  onProgress: (p) => progress.push(p),
});
assert(up.msgId, 'Большой файл (12МБ) загружен чанками и отправлен');
assert(progress.length > 1 && progress[progress.length - 1] === 100, `Прогресс шёл и дошёл до 100% (${progress.length} шагов)`);
line();

// Сервер хранит ШИФРТЕКСТ (не открытый текст).
const meta = srv.storage.getRaw(up.mediaId);
assert(meta && meta.buffer.length >= SIZE, 'Сервер хранит зашифрованный блоб (>= размера)');
assert(!meta.buffer.subarray(0, 32).equals(Buffer.from(data.subarray(0, 32))), 'На сервере — ШИФРТЕКСТ, не исходные байты');
line();

// Bob скачивает (сырой поток) и расшифровывает.
const inbox = await bob.receive();
const att = inbox.find((m) => m.kind === 'attachment');
assert(att && att.attachment.filename === 'big.bin', 'Bob получил метаданные вложения');
const got = await bob.fetchAttachment(att.attachment);
assert(got.length === SIZE, `Скачано байт: ${got.length} == ${SIZE}`);
let ok = true; for (let i = 0; i < SIZE; i += 65537) if (got[i] !== data[i]) { ok = false; break; }
assert(ok, 'Файл расшифрован байт-в-байт (выборочная проверка)');
line();

// Отмена: isCancelled=true → загрузка прерывается.
let cancelled = false;
try { await alice.uploadBlobChunked(data, 'application/octet-stream', { isCancelled: () => true }); }
catch (e) { cancelled = !!e.cancelled; }
assert(cancelled, 'Отмена загрузки (isCancelled) прерывает передачу');
line();

console.log('🎉 Тест чанковой загрузки больших файлов пройден.');
srv.server.close();
