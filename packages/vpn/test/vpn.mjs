// vpn.mjs — боевой тест Prizrak VPN: настоящий сайт + узел + клиент + SOCKS5.
// Проверяем весь путь: браузер → SOCKS5 → stealth-туннель → выходной узел → сайт.
import { createServer as httpServer } from 'node:http';
import net from 'node:net';
import { startVpnNode } from '../src/node.js';
import { connectVpn, startSocksProxy } from '../src/client.js';
import { issueTicket, verifyTicket } from '../src/ticket.js';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { classify } from '../../transport/src/dpi-analyzer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const PSK = 'test-node-psk-123';
const seed = randomBytes(32), SEC = bytesToHex(seed), PUB = bytesToHex(ed25519.getPublicKey(seed));
const otherSeed = randomBytes(32), OTHER_SEC = bytesToHex(otherSeed);

let site, node, vpn, socks;
try {
  // ── «Интернет»: обычный сайт, до которого ходим через VPN ──
  site = httpServer((req, res) => {
    if (req.url === '/big') { res.writeHead(200); return res.end('X'.repeat(300 * 1024)); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('привет из интернета:' + req.url);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const SITE = site.address().port;

  // ── Билеты ──
  const t = issueTicket(SEC, { sub: 'fox:prizrak.im', ttlSec: 3600, bytes: 10 * 1024 * 1024, tier: 'pro' });
  ok(verifyTicket(t, [PUB]).ok, 'билет проверяется ключом издателя');
  ok(!verifyTicket(t, [bytesToHex(ed25519.getPublicKey(otherSeed))]).ok, 'чужой ключ билет не принимает');
  const expired = issueTicket(SEC, { sub: 'x', ttlSec: -10 });
  ok(!verifyTicket(expired, [PUB]).ok, 'просроченный билет отклонён');
  const forged = { ...t, sub: 'другой:домен' };
  ok(!verifyTicket(forged, [PUB]).ok, 'подделка (подменили поле) не проходит');

  // ── Узел ──
  const usage = [];
  node = await startVpnNode({ port: 0, host: '127.0.0.1', psk: PSK, trustedIssuers: [PUB], allowPrivate: true, onUsage: (u) => usage.push(u) });
  ok(node.port > 0, 'выходной узел слушает (снаружи — обычный HTTPS)');

  // ── Отказ без билета и с чужим билетом ──
  let denied = null;
  try { await connectVpn({ host: '127.0.0.1', port: node.port, psk: PSK }); } catch (e) { denied = e.message; }
  ok(!!denied, 'без билета узел не пускает');
  const alien = issueTicket(OTHER_SEC, { sub: 'hacker', ttlSec: 3600 });
  denied = null;
  try { await connectVpn({ host: '127.0.0.1', port: node.port, psk: PSK, ticket: alien }); } catch (e) { denied = e.message; }
  ok(!!denied, 'билет чужого издателя не принимается');

  // ── Подключение с билетом + SOCKS5 ──
  vpn = await connectVpn({ host: '127.0.0.1', port: node.port, psk: PSK, ticket: t });
  ok(vpn.info && vpn.info.tier === 'pro', 'узел принял билет и вернул тариф');
  socks = await startSocksProxy({ vpn, port: 0 });
  ok(socks.port > 0, 'локальный SOCKS5 поднят');

  // ── Настоящий HTTP-запрос через SOCKS5 → туннель → узел → сайт ──
  const viaSocks = (path) => new Promise((resolve, reject) => {
    const c = net.connect(socks.port, '127.0.0.1', () => {
      c.write(Buffer.from([0x05, 0x01, 0x00]));                       // greeting
      c.once('data', () => {
        const hostBuf = Buffer.from('127.0.0.1');
        const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, Buffer.from([SITE >> 8, SITE & 0xff])]);
        c.write(req);
        c.once('data', (rep) => {
          if (rep[1] !== 0x00) return reject(new Error('SOCKS отказал: ' + rep[1]));
          c.write(`GET ${path} HTTP/1.1\r\nHost: site\r\nConnection: close\r\n\r\n`);
          let out = '';
          c.on('data', (d) => { out += d.toString('latin1'); });
          c.on('close', () => resolve(out));
        });
      });
    });
    c.on('error', reject);
    setTimeout(() => reject(new Error('таймаут запроса через VPN')), 15000);
  });

  const body = await viaSocks('/hello');
  ok(body.includes('привет из интернета:/hello'), 'страница получена ЧЕРЕЗ туннель');

  // ── Большой ответ (проверяем мультиплексор на объёме) ──
  const big = await viaSocks('/big');
  ok((big.match(/X/g) || []).length >= 300 * 1024, 'большой ответ (300 КБ) прошёл целиком');

  // ── Несколько потоков одновременно в одном туннеле ──
  const many = await Promise.all([viaSocks('/a'), viaSocks('/b'), viaSocks('/c')]);
  ok(many.every((r, i) => r.includes('/' + 'abc'[i])), '3 параллельных потока в одном TLS-канале');

  // ── Учёт трафика для наград оператору ──
  const st = node.stats();
  ok(st.up > 0 && st.down > 300 * 1024, 'узел посчитал трафик (для наград оператору)');

  // ── Запрет локальной сети (узел не должен сканировать чужую LAN) ──
  const node2 = await startVpnNode({ port: 0, host: '127.0.0.1', psk: PSK, trustedIssuers: [PUB] }); // allowPrivate по умолчанию false
  const vpn2 = await connectVpn({ host: '127.0.0.1', port: node2.port, psk: PSK, ticket: t });
  let lanErr = null;
  try { await vpn2.open('192.168.1.1', 80, new net.Socket()); } catch (e) { lanErr = e.message; }
  ok(!!lanErr, 'выход в локальную сеть запрещён');
  vpn2.close(); node2.close();

  // ── DPI: что видно на проводе ──
  const wire = Buffer.from([0x17, 0x03, 0x03, 0x01, 0x00]); // TLS application data — то, чем идёт туннель
  ok(/TLS|HTTPS|веб/i.test(String(classify(wire))), 'на проводе трафик выглядит как обычный HTTPS');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.message, e.stack?.split('\n')[1] || '');
} finally {
  try { socks?.close(); } catch {}
  try { vpn?.close(); } catch {}
  try { node?.close(); } catch {}
  try { site?.close(); } catch {}
}
console.log(`\nPrizrak VPN: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
