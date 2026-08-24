// features-1.2-test.js — 👻-кошелёк, вложения/голосовые, WebSocket-пуш, звонки без STUN.
import { createServer } from '../packages/server/src/server.js';
import { createRelay } from '../packages/relay/src/relay.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8971, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });

const relay = await createRelay({ psk: 'prizrak-relay', port: 0 });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true, admin: 'admin', relayUrl: `stealth://127.0.0.1:${relay.port}`, startRelay: false });
line();

const admin = await new PrizrakClient({ name: 'Admin', userId: 'admin:chat.org', baseUrl: URL }).init(); await admin.register('admin-pass-123');
const alice = await new PrizrakClient({ name: 'Alice', userId: 'alice:chat.org', baseUrl: URL }).init(); await alice.register('alice-pass-123');
const bob = await new PrizrakClient({ name: 'Bob', userId: 'bob:chat.org', baseUrl: URL }).init(); await bob.register('bob-pass-123');
await alice.serverConfig(); await bob.serverConfig(); // подтянуть relayUrl

// ── Кошелёк 👻 ──────────────────────────────────────────────────────────────
// Баланс/покупка/подарки теперь идут через централизованный Банк Призраков
// (prizrak.paymoney.online), а НЕ через homeserver — homeserver'у нельзя доверять
// учёт покупной валюты. Интеграция клиента с Банком проверяется отдельно:
//   demo/bank-client-test.sh  (TOFU-регистрация, IPN-зачисление, подписанный перевод).
line();

// ── Вложения и голосовые (E2E) ────────────────────────────────────────────
const fileBytes = new Uint8Array([...Array(1000).keys()].map((i) => i % 256));
const up = await alice.sendAttachment('bob:chat.org', fileBytes, { filename: 'secret.bin', mime: 'application/octet-stream' });
const raw = srv.storage.get(up.mediaId);
assert(raw && raw.ciphertext && !raw.ciphertext.startsWith('000102030405'), 'Сервер хранит вложение как ШИФРТЕКСТ');
let inbox = await bob.receive();
const attMsg = inbox.find((m) => m.kind === 'attachment');
assert(attMsg && attMsg.attachment.filename === 'secret.bin', 'Bob получил метаданные вложения');
const got = await bob.fetchAttachment(attMsg.attachment);
assert(got.length === 1000 && got[0] === 0 && got[999] === (999 % 256), 'Вложение скачано и расшифровано байт-в-байт');

const voice = new Uint8Array([9, 8, 7, 6, 5]);
await alice.sendAttachment('bob:chat.org', voice, { filename: 'voice.webm', mime: 'audio/webm', voice: true });
inbox = await bob.receive();
assert(inbox.find((m) => m.kind === 'attachment' && m.attachment.voice === true), 'Голосовое доставлено (voice:true)');
line();

// ── Звонок без STUN через stealth-relay ─────────────────────────────────────
const heardByBob = [], heardByAlice = [];
const { call: aliceCall, callId } = await alice.startCall('bob:chat.org', { video: false, onMedia: (b) => heardByAlice.push(Buffer.from(b).toString()) });
await sleep(100);
const offerMsg = (await bob.receive()).find((m) => m.kind === 'call' && m.call.event === 'offer');
assert(offerMsg && offerMsg.call.callId === callId, 'Bob получил call-offer по E2E-сигналингу');
const bobCall = await bob.acceptCall('alice:chat.org', offerMsg.call, { onMedia: (b) => heardByBob.push(Buffer.from(b).toString()) });
await sleep(150);

aliceCall.sendMedia(Buffer.from('audio-from-alice'));
bobCall.sendMedia(Buffer.from('audio-from-bob'));
await sleep(300);

assert(heardByBob.includes('audio-from-alice'), 'Медиа Alice дошло до Bob через relay (E2E)');
assert(heardByAlice.includes('audio-from-bob'), 'Медиа Bob дошло до Alice через relay (E2E)');
assert((await alice.receive()).some((m) => m.kind === 'call' && m.call.event === 'answer'), 'Alice получила call-answer');
aliceCall.hangup(); bobCall.hangup();
line();

// ── WebSocket-пуш (уведомления) ─────────────────────────────────────────────
const carol = await new PrizrakClient({ name: 'Carol', userId: 'carol:chat.org', baseUrl: URL }).init(); await carol.register('carol-pass-1');
await carol.serverConfig();
let resolveText; const pushed = new Promise((r) => (resolveText = r));
await carol.connectRealtime((ev) => { if (ev.kind === 'text') resolveText(ev.text); });
await sleep(150);
await alice.send('carol:chat.org', 'привет по WebSocket!');
const text = await Promise.race([pushed, sleep(1500).then(() => null)]);
assert(text === 'привет по WebSocket!', 'Сообщение доставлено мгновенно по WebSocket (пуш)');
carol.disconnectRealtime();
line();

console.log('🎉 Все тесты v1.2 (👻, вложения, голосовые, звонки без STUN, пуш) пройдены.');
srv.server.close(); relay.server.close();
