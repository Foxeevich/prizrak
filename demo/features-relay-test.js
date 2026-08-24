// features-relay-test.js — relay для звонков поднимается ВНУТРИ homeserver'а
// (in-process) и реально переносит медиа между собеседниками.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
import { authToken } from '../packages/transport/src/stealth.js';
import tls from 'node:tls';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = () => console.log('─'.repeat(64));

const PORT = 8969, RELAY_PORT = 8815, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
// startRelay НЕ передаём — значит relay должен подняться в процессе сервера.
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true, relayUrl: `stealth://127.0.0.1:${RELAY_PORT}` });
assert(srv.relay, 'Relay поднялся ВНУТРИ homeserver\'а (srv.relay задан)');
line();

const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };
const alice = await mk('alice'), bob = await mk('bob');

const heardByBob = [], heardByAlice = [];
const { call: aliceCall, callId } = await alice.startCall('bob:chat.org', { video: false, onMedia: (b) => heardByAlice.push(Buffer.from(b).toString()) });
await sleep(100);
const offer = (await bob.receive()).find((m) => m.kind === 'call' && m.call.event === 'offer');
assert(offer && offer.call.callId === callId, 'Bob получил offer звонка');
const bobCall = await bob.acceptCall('alice:chat.org', offer.call, { onMedia: (b) => heardByBob.push(Buffer.from(b).toString()) });
await sleep(150);

aliceCall.sendMedia(Buffer.from('audio-from-alice'));
bobCall.sendMedia(Buffer.from('audio-from-bob'));
await sleep(300);

assert(heardByBob.includes('audio-from-alice'), 'Медиа Alice дошло до Bob через in-process relay');
assert(heardByAlice.includes('audio-from-bob'), 'Медиа Bob дошло до Alice через in-process relay');

// ── Большой кадр (видео-keyframe) > 64 КБ: раньше 16-битная длина переполнялась
//    и рвала звонок. Теперь длина 32-битная — большой кадр должен дойти целым.
const big = Buffer.alloc(200 * 1024);
for (let i = 0; i < big.length; i++) big[i] = 65 + (i % 26); // ASCII A–Z: точный round-trip через toString()
aliceCall.sendMedia(big);
await sleep(400);
const gotBig = heardByBob.find((s) => s.length === big.length && s === big.toString());
assert(!!gotBig, 'Большой видео-кадр 200 КБ дошёл целым (32-битный фрейминг)');
aliceCall.hangup(); bobCall.hangup();
line();

// ── Устойчивость: мусор/зонд на порт relay НЕ должен ронять сервер ────────────
const hit = (payload) => new Promise((resolve) => {
  const s = tls.connect({ host: '127.0.0.1', port: RELAY_PORT, rejectUnauthorized: false }, () => {
    try { s.write(payload); } catch {}
    setTimeout(() => { try { s.destroy(); } catch {} resolve(); }, 150);
  });
  s.on('error', () => resolve());
});
await hit(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));                 // зонд без токена → обманка
const AUTH = authToken('prizrak-relay');
await hit(Buffer.concat([Buffer.from(AUTH), Buffer.from([0x00, 0x10]), Buffer.from('0123456789abcdef')])); // токен + битый кадр → invalid tag
await sleep(150);

// Если бы сервер упал на «invalid tag», этот процесс уже был бы мёртв — а раз мы
// здесь, значит выжил. Дополнительно убеждаемся, что звонки всё ещё работают.
const carol = await mk('carol'), dave = await mk('dave');
const heard = [];
const { call: cCall, callId: cid } = await carol.startCall('dave:chat.org', { onMedia: () => {} });
await sleep(80);
const off2 = (await dave.receive()).find((m) => m.kind === 'call' && m.call.event === 'offer');
const dCall = await dave.acceptCall('carol:chat.org', off2.call, { onMedia: (b) => heard.push(Buffer.from(b).toString()) });
await sleep(120); cCall.sendMedia(Buffer.from('still-working')); await sleep(200);
assert(heard.includes('still-working'), 'После мусорных подключений relay/сервер живы и звонки работают');
cCall.hangup(); dCall.hangup();
line();

console.log('🎉 Тест in-process relay (звонки + устойчивость к мусору) пройден.');
try { srv.relay.server.close(); } catch {}
srv.server.close();
