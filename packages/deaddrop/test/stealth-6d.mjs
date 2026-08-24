// stealth-6d.mjs — Фаза 6d: стелс-фронт узла (TLS-туннель + probe-resistance).
// Узел слушает HTTP на localhost, наружу — стелс-фронт. Доступ по PSK; стук без токена → обманка.
import { startNode } from '../src/node.js';
import { createStealthFront, stealthFetch } from '../src/stealth-front.js';
import tls from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const nd = mkdtempSync(join(tmpdir(), 'st-'));
const PSK = 'test-tunnel-secret';
const HTTP = 8951, STEALTH = 8952;
const node = startNode({ dataDir: nd, port: HTTP, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:' + HTTP, gossip: false, heal: false, sweepMs: 3600000 });
const front = createStealthFront({ psk: PSK, target: { host: '127.0.0.1', port: HTTP }, onProbe: () => { probed = true; } });
let probed = false;
await new Promise((r) => front.listen(STEALTH, '127.0.0.1', r));
await sleep(180);

try {
  const f = stealthFetch('https://127.0.0.1:' + STEALTH, { psk: PSK, servername: 'cdn' });

  // GET /dd/health через стелс-туннель.
  const h = await (await f('/dd/health')).json();
  ok(h && typeof h.nodeId === 'string' && h.version, 'GET /dd/health прошёл сквозь стелс-туннель');

  // POST /registry/list (пустой) через туннель.
  const rl = await f('/registry/list');
  const j = await rl.json();
  ok(rl.status === 200 && Array.isArray(j.records), 'GET /registry/list прошёл через туннель (200)');

  // Наружу — валидный TLS: сырое TLS-рукопожатие проходит (запись type 0x16).
  const tlsOk = await new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port: STEALTH, servername: 'cdn', rejectUnauthorized: false }, () => { resolve(true); s.end(); });
    s.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  ok(tlsOk, 'наружу настоящий TLS 1.2+ (рукопожатие проходит, как у HTTPS-сайта)');

  // Probe-resistance: активное зондирование (сырой TLS + мусор вместо токена) → страница-обманка,
  // а не данные узла. Проверяем напрямую сырым соединением (как это делает цензор).
  const probeResp = await new Promise((resolve) => {
    const chunks = [];
    const s = tls.connect({ host: '127.0.0.1', port: STEALTH, servername: 'cdn', rejectUnauthorized: false }, () => {
      s.write(Buffer.from('47455420 not a valid token padding padding', 'utf8')); // 32+ байт мусора ≠ AUTH
    });
    s.on('data', (c) => chunks.push(c));
    s.on('close', () => resolve(Buffer.concat(chunks).toString()));
    s.on('error', () => resolve(Buffer.concat(chunks).toString()));
    setTimeout(() => { try { s.destroy(); } catch {}; resolve(Buffer.concat(chunks).toString()); }, 3000);
  });
  ok(!probeResp.includes('nodeId'), 'зонд НЕ получает данные узла (нет nodeId в ответе)');
  ok(probeResp.includes('It works') || probeResp.includes('Edge node'), 'зонду отдана правдоподобная страница-обманка');
  ok(probed === true, 'зонд без валидного токена зафиксирован (onProbe)');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  try { front.close(); } catch {}
  node.stop();
  rmSync(nd, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
