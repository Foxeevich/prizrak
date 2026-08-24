// demo.js — демонстрация обхода DPI stealth-транспортом Prizrak.
//
// Что показываем:
//   1) Почему обычный WebRTC-звонок режется: STUN и DTLS палятся сигнатурами.
//   2) Наш stealth-туннель: те же медиапакеты, но на проводе — обычный HTTPS,
//      DPI-анализатор пропускает их как веб-трафик.
//   3) Probe-resistance: цензор стучится без токена — получает страницу-обманку.
import net from 'node:net';
import tls from 'node:tls';
import { createStealthServer, connectStealth } from './stealth.js';
import { classify } from './dpi-analyzer.js';

// Порты не задаём жёстко — просим ОС выдать свободные (port 0). Так демо не
// падает с EADDRINUSE, даже если 8443/8444 у вас чем-то заняты.
let TLS_PORT, TAP_PORT;
const PSK = 'demo-shared-tunnel-secret';
const line = () => console.log('─'.repeat(64));

// ── 1. Что DPI видит у классического WebRTC ────────────────────────────────
console.log('1) КЛАССИЧЕСКИЙ WebRTC-ЗВОНОК ГЛАЗАМИ DPI (ТСПУ):');
const stun = Buffer.alloc(20);
stun.writeUInt16BE(0x0001, 0);            // Binding Request
stun.writeUInt16BE(0x0000, 2);
stun.writeUInt32BE(0x2112a442, 4);        // magic cookie
console.log('   STUN binding request →', classify(stun));
const dtls = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x00]); // DTLS handshake
console.log('   DTLS media handshake →', classify(dtls));
console.log('   ⇒ ТСПУ дропает такие пакеты, звонок не устанавливается.');
line();

// ── 2. Поднимаем stealth-сервер и «провод»-перехватчик ─────────────────────
const received = [];
const server = createStealthServer({
  psk: PSK,
  onFrame: (payload, reply) => {
    received.push(payload.toString());
    reply(Buffer.from('ACK:' + payload.toString())); // «эхо» как в дуплексном звонке
  },
  onProbe: () => console.log('   [server] активное зондирование без токена → отдал обманку'),
});
server.on('error', (e) => { console.error('stealth-сервер:', e.message); process.exit(1); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
TLS_PORT = server.address().port;   // фактически выданный ОС порт

// Тап: net-прокси, который логирует первые байты клиент→сервер (то, что видит DPI).
let firstWireSample = null;
const tap = net.createServer((client) => {
  const upstream = net.connect(TLS_PORT, '127.0.0.1');
  client.on('data', (chunk) => {
    if (!firstWireSample) firstWireSample = Buffer.from(chunk);
    upstream.write(chunk);
  });
  upstream.on('data', (chunk) => client.write(chunk));
  client.on('error', () => {}); upstream.on('error', () => {});
  client.on('close', () => upstream.end()); upstream.on('close', () => client.end());
});
tap.on('error', (e) => { console.error('tap-прокси:', e.message); process.exit(1); });
await new Promise((r) => tap.listen(0, '127.0.0.1', r));
TAP_PORT = tap.address().port;      // фактически выданный ОС порт

// ── 3. Клиент звонит через stealth-туннель (медиа = «аудиокадры») ───────────
console.log('2) ЗВОНОК ЧЕРЕЗ STEALTH-ТУННЕЛЬ PRIZRAK:');
const conn = await connectStealth({
  host: '127.0.0.1', port: TAP_PORT,
  servername: 'cdn.example-static.net',  // SNI прикрытия (в проде — живой сайт)
  psk: PSK,
  onFrame: (payload) => console.log('   [client] получил от сервера:', payload.toString()),
});
for (let i = 0; i < 5; i++) conn.sendFrame(Buffer.from(`audio-frame-${i}`));
await new Promise((r) => setTimeout(r, 200));

console.log('   Сервер принял медиакадры:', received);
console.log('   Первые байты на ПРОВОДЕ (то, что видит DPI):',
  firstWireSample ? firstWireSample.subarray(0, 8).toString('hex') : '(нет)');
console.log('   DPI-вердикт по проводу →', classify(firstWireSample));
line();

// ── 4. Активное зондирование цензором (стук без токена) ─────────────────────
console.log('3) АКТИВНОЕ ЗОНДИРОВАНИЕ (цензор проверяет, что за сервер):');
const probe = tls.connect({ host: '127.0.0.1', port: TLS_PORT, rejectUnauthorized: false }, () => {
  probe.write(Buffer.from('GET / HTTP/1.1\r\nHost: cdn.example-static.net\r\n\r\n'));
});
probe.on('data', (d) => {
  console.log('   Цензор получил в ответ:', d.toString().split('\r\n')[0], '→ выглядит как обычный CDN');
  probe.end();
  finish();
});

function finish() {
  line();
  const verdict = classify(firstWireSample);
  console.log(verdict.flagged
    ? '❌ Провод спалился DPI'
    : '✅ Stealth-трафик неотличим от HTTPS — DPI/ТСПУ его пропускает.');
  conn.close(); server.close(); tap.close();
}
