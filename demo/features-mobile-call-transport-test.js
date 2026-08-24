// Транспорт мобильного звонка совместим с relay и десктопом.
// «Мобильное плечо» использует ЧИСТЫЕ функции из packages/mobile (stealth-frame + srtp),
// но поверх node:tls (в приложении там react-native-tcp-socket — тот же протокол).
// Десктопное плечо — штатный connectStealth. Через relay гоняем медиапакет туда-обратно.
import tls from 'node:tls';
import { createRelay } from '../packages/relay/src/relay.js';
import { connectStealth } from '../packages/transport/src/stealth.js';
import { frameKey, authToken, encodeFrame, makeFrameDecoder } from '../packages/mobile/src/native/stealth-frame.js';
import { protectPacket, unprotectPacket } from '../packages/mobile/src/native/srtp.js';
import { randomBytes } from '../packages/crypto/src/index.js';

const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const PSK = 'prizrak-relay';
const PORT = 8899;
const relay = createRelay({ psk: PSK, port: PORT, host: '127.0.0.1' });
await new Promise((r) => setTimeout(r, 300));

const callId = 'testcall1';
const mediaKey = randomBytes(32);

// ── Десктопное плечо (штатный транспорт) — принимает медиа ──────────────────
const gotOnDesktop = [];
const desk = await connectStealth({
  host: '127.0.0.1', port: PORT, servername: 'x', psk: PSK,
  onFrame: (payload) => { try { gotOnDesktop.push(unprotectPacket(mediaKey, payload)); } catch {} },
});
desk.sendFrame(Buffer.from(JSON.stringify({ callId })));
await new Promise((r) => setTimeout(r, 200));

// ── Мобильное плечо (чистые функции mobile + node:tls) ──────────────────────
const key = frameKey(PSK);
const AUTH = authToken(PSK);
const gotOnMobile = [];
const decodeMobile = makeFrameDecoder(key, (payload) => { try { gotOnMobile.push(unprotectPacket(mediaKey, payload)); } catch {} });

const mob = await new Promise((resolve, reject) => {
  const s = tls.connect({ host: '127.0.0.1', port: PORT, servername: 'x', rejectUnauthorized: false }, () => {
    s.write(Buffer.from(AUTH));                                   // скрытый токен
    s.write(Buffer.from(encodeFrame(key, new TextEncoder().encode(JSON.stringify({ callId }))))); // join
    s.on('data', (chunk) => { try { decodeMobile(new Uint8Array(chunk)); } catch {} });
    resolve(s);
  });
  s.on('error', reject);
});
await new Promise((r) => setTimeout(r, 200));

// 1. Мобильный шлёт медиапакет (как аудио-кадр) → приходит на десктоп.
const payloadA = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 7, 7]); // packChunk('a')-подобный
mob.write(Buffer.from(encodeFrame(key, protectPacket(mediaKey, { idx: 0, timestamp: 0, ssrc: 12345, payload: payloadA }))));
await new Promise((r) => setTimeout(r, 300));
ok(gotOnDesktop.length === 1, 'десктоп получил 1 медиапакет от мобильного');
ok(gotOnDesktop[0] && Buffer.from(gotOnDesktop[0].payload).equals(Buffer.from(payloadA)), 'payload расшифрован в точности (mobile→desktop)');

// 2. Десктоп шлёт медиапакет → приходит на мобильное плечо (расшифровка тем же ключом).
const payloadB = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9]);
desk.sendFrame(protectPacket(mediaKey, { idx: 1, timestamp: 20, ssrc: 999, payload: payloadB }));
await new Promise((r) => setTimeout(r, 300));
ok(gotOnMobile.length === 1, 'мобильное плечо получило 1 медиапакет от десктопа');
ok(gotOnMobile[0] && Buffer.from(gotOnMobile[0].payload).equals(Buffer.from(payloadB)), 'payload расшифрован в точности (desktop→mobile)');

console.log('🎉 транспорт мобильного звонка совместим с relay и десктопом');
try { mob.destroy(); } catch {}
try { desk.close(); } catch {}
try { relay.close(); } catch {}
process.exit(0);
