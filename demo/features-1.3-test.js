// features-1.3-test.js — запоминание входа, история/ретеншн (кламп), хранилище, SRTP/jitter, версия.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
import { StorageManager } from '../packages/server/src/storage.js';
import { protectPacket, unprotectPacket, JitterBuffer } from '../packages/transport/src/srtp.js';
import { randomBytes } from '../packages/crypto/src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));

const PORT = 8981, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true, admin: 'admin', historyRetention: 'forever' });
line();

// ── Версия сервера ───────────────────────────────────────────────────────────
assert(/^\d+\.\d+\.\d+$/.test(srv.version), `Сервер знает свою версию: v${srv.version}`);
const cfg = await new PrizrakClient({ name: 'x', userId: 'x:chat.org', baseUrl: URL }).serverConfig();
assert(cfg.version === srv.version, '/config отдаёт версию сервера');
line();

// ── Запоминание входа: persist → restore → догон оффлайн-сообщения ──────────
const alice = await new PrizrakClient({ name: 'Alice', userId: 'alice:chat.org', baseUrl: URL }).init(); await alice.register('alice-pass-123');
const bob = await new PrizrakClient({ name: 'Bob', userId: 'bob:chat.org', baseUrl: URL }).init(); await bob.register('bob-pass-123');

await alice.send('bob:chat.org', 'msg1 (online)');
let got = await bob.receive();
assert(got.find((m) => m.text === 'msg1 (online)'), 'Bob получил первое сообщение (сессия установлена)');

const saved = JSON.parse(JSON.stringify(bob.serializeState())); // «Bob закрыл приложение»
await alice.send('bob:chat.org', 'msg2 (пока Bob оффлайн)');    // приходит, пока Bob offline

const bob2 = PrizrakClient.fromState(saved);                    // «Bob снова открыл приложение»
assert(bob2.token === bob.token && bob2.fingerprint === bob.fingerprint, 'Состояние восстановлено (токен и личность те же)');
got = await bob2.receive();
assert(got.find((m) => m.text === 'msg2 (пока Bob оффлайн)'), 'После перезапуска Bob догрузил оффлайн-сообщение и расшифровал');
assert(!got.find((m) => m.text === 'msg1 (online)'), 'Курсор сохранён — старое не пришло повторно');
line();

// ── Ретеншн: глобальный максимум + кламп per-room ────────────────────────────
const admin = await new PrizrakClient({ name: 'Admin', userId: 'admin:chat.org', baseUrl: URL }).init(); await admin.register('admin-pass-1');
await admin.adminSetStorage({ retention: '6mo' });
const room = await alice.createGroup('История');
await alice.invite(room.id, 'bob:chat.org');
// alice — создатель, значит админ комнаты
let r = await alice.setRoomRetention(room.id, '1y');
assert(r.effective === '6mo' && r.clamped, 'Пользовательский срок 1y склампился к админскому 6mo');
r = await alice.setRoomRetention(room.id, '1w');
assert(r.effective === '1w' && !r.clamped, 'Более короткий срок 1w разрешён без клампа');
line();

// ── Ретеншн-очистка удаляет старое ───────────────────────────────────────────
await alice.send('bob:chat.org', 'старое сообщение');
const hist = srv.store.data.history['bob:chat.org'];
const before = hist.length;
hist[hist.length - 1].at = Date.now() - 100 * 86400 * 1000; // «состарить» на 100 дней
await admin.adminSetStorage({ retention: '1mo' });           // 30 дней → запустит очистку
const after = srv.store.data.history['bob:chat.org'].length;
assert(after === before - 1, 'Ретеншн-очистка удалила запись старше срока');
line();

// ── Хранилище: несколько путей, лимит, вытеснение, статистика ────────────────
const base = mkdtempSync(join(tmpdir(), 'prizrak-stor-'));
const p1 = join(base, 'disk1'), p2 = join(base, 'disk2');
const sm = new StorageManager({ paths: [p1], maxBytes: 3000 });
const blob = (n) => '00'.repeat(n); // n байт в hex
sm.put('a', { ciphertext: blob(1000), mime: 'x' });
sm.put('b', { ciphertext: blob(1000), mime: 'x' });
sm.put('c', { ciphertext: blob(1000), mime: 'x' });
assert(sm.get('a'), 'Первые блобы на месте');
sm.put('d', { ciphertext: blob(1000), mime: 'x' }); // превышает лимит → вытеснит старейший (a)
assert(!sm.get('a') && sm.get('d'), 'При превышении лимита вытеснен самый старый блоб');
sm.addPath(p2);
assert(sm.stats().paths.length === 2, 'Добавлен второй путь хранения (новый диск)');
sm.put('e', { ciphertext: blob(500), mime: 'x' });
assert(sm.stats().usedBytes <= sm.maxBytes, 'Суммарный размер не превышает лимит');
rmSync(base, { recursive: true, force: true });
line();

// ── SRTP + jitter-буфер ──────────────────────────────────────────────────────
const key = randomBytes(32), ssrc = 0x1234abcd;
const pkt = protectPacket(key, { idx: 5, timestamp: 100, ssrc, payload: new TextEncoder().encode('opus-frame') });
const un = unprotectPacket(key, pkt);
assert(new TextDecoder().decode(un.payload) === 'opus-frame' && un.idx === 5, 'SRTP: пакет защищён и корректно расшифрован');
let bad = false; try { const t = Buffer.from(pkt); t[t.length - 1] ^= 1; unprotectPacket(key, t); } catch { bad = true; }
assert(bad, 'SRTP: подделанный пакет отвергнут AEAD');
const order = [];
const jb = new JitterBuffer((p) => order.push(new TextDecoder().decode(p)));
jb.push({ idx: 2, payload: new TextEncoder().encode('c') });
jb.push({ idx: 0, payload: new TextEncoder().encode('a') });
jb.push({ idx: 1, payload: new TextEncoder().encode('b') });
assert(order.join('') === 'abc', 'Jitter-буфер переупорядочил пакеты (c,a,b → a,b,c)');
line();

console.log('🎉 Все тесты v1.3 (вход, история/ретеншн, хранилище, SRTP) пройдены.');
srv.server.close();
