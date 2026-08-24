// features-media-delete-test.js — удаление сообщения с вложением освобождает
// место на сервере (медиа-блоб реально удаляется, а не висит до ретеншна).
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));

const PORT = 8971, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'm.org': URL });
const srv = await createServer({ domain: 'm.org', port: PORT, storePath: null, registrationEnabled: true });
line();

const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:m.org`, baseUrl: URL }).init(); await c.register(`${n}-pass-123`); return c; };
const alice = await mk('alice'), bob = await mk('bob');

const before = srv.storage.stats().usedBytes;
const bytes = new Uint8Array(120 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
const up = await alice.sendAttachment('bob:m.org', bytes, { filename: 'pic.png', mime: 'image/png' });
const after = srv.storage.stats().usedBytes;
assert(after > before, 'После отправки вложения место на сервере занято');
assert(!!up.mediaId, 'У вложения есть mediaId');

// Bob получил и может скачать (блоб на месте).
const got = await alice.fetchAttachment({ mediaId: up.mediaId, key: up.key, nonce: up.nonce });
assert(got && got.length === bytes.length, 'Блоб скачивается до удаления');
line();

// Удаляем медиа (как делает клиент при «удалить у обоих» своего вложения).
const del = await alice.deleteMedia(up.mediaId);
assert(del.ok && del.removed === true, 'Сервер подтвердил удаление блоба');
const freed = srv.storage.stats().usedBytes;
assert(freed === before, 'Место освобождено (usedBytes вернулся к исходному)');

// Повторное удаление — идемпотентно, без ошибок.
const del2 = await alice.deleteMedia(up.mediaId);
assert(del2.ok && del2.removed === false, 'Повторное удаление идемпотентно (removed=false)');

// Блоб больше не скачивается.
let gone = false; try { const r = await alice.fetchAttachment({ mediaId: up.mediaId, key: up.key, nonce: up.nonce }); gone = !r; } catch { gone = true; }
assert(gone, 'После удаления блоб недоступен');
line();

console.log('🎉 Тест освобождения места при удалении вложения пройден.');
srv.server.close(); try { srv.relay?.server.close(); } catch {}
