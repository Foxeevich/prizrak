// bootstrap-6b.mjs — Фаза 6b: мультиканальный подписанный бутстрап сидов.
// Проверяем: подпись/срок, отбраковку подделок, выбор свежего бандла, работу разных каналов
// (DoH-TXT / HTTPS / baked), живучесть кэша при падении всех каналов и стыковку с DeaddropFed.
import { makeBootstrapBundle, verifyBootstrapBundle, Bootstrap, dohChannel, httpsChannel, bakedChannel, channelsFromConfig } from '../src/bootstrap.js';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const dir = mkdtempSync(join(tmpdir(), 'boot-'));

try {
  const priv = bytesToHex(randomBytes(32));
  const pub = bytesToHex(ed25519.getPublicKey(hexToBytes(priv)));
  const evilPriv = bytesToHex(randomBytes(32));
  const now = Date.now();

  // 1. Валидная подпись.
  const b = makeBootstrapBundle(priv, ['https://n1:8820', 'https://n2:8820'], { epoch: 100, ttlMs: 30 * 86400000, now });
  ok(verifyBootstrapBundle(b, pub, now), 'валидный бандл проходит проверку ключом мейнтейнера');

  // 2. Подделка чужим ключом отвергается.
  const forged = makeBootstrapBundle(evilPriv, ['https://evil:8820'], { epoch: 999, ttlMs: 30 * 86400000, now });
  ok(!verifyBootstrapBundle(forged, pub, now), 'бандл, подписанный чужим ключом, отвергнут');

  // 3. Подмена сидов после подписи ломает проверку.
  const tampered = { ...b, seeds: [...b.seeds, 'https://injected:8820'] };
  ok(!verifyBootstrapBundle(tampered, pub, now), 'дописанный сид ломает подпись');

  // 4. Протухший бандл (notAfter в прошлом) не принимается.
  ok(!verifyBootstrapBundle(b, pub, b.notAfter + 1), 'протухший бандл (после notAfter) отвергнут');

  // 5. Не-URL сиды отбрасываются проверкой.
  const bad = makeBootstrapBundle(priv, ['not-a-url'], { epoch: 5, now });
  ok(!verifyBootstrapBundle(bad, pub, now), 'бандл с не-URL сидом отвергнут');

  // 6. DoH-канал: TXT содержит prizrak-boot=<base64url>.
  const b64url = Buffer.from(JSON.stringify(b)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const dohFetch = async () => ({ json: async () => ({ Answer: [{ data: `"prizrak-boot=${b64url}"` }] }) });
  const viaDoh = await dohChannel('boot.example', { fetchImpl: dohFetch })();
  ok(viaDoh && viaDoh.sig === b.sig, 'DoH-канал вернул тот же подписанный бандл из TXT');

  // 7. HTTPS-канал: JSON-бандл.
  const httpsFetch = async () => ({ ok: true, json: async () => b });
  const viaHttps = await httpsChannel('https://cdn/prizrak-boot.json', { fetchImpl: httpsFetch })();
  ok(viaHttps && viaHttps.sig === b.sig, 'HTTPS-канал вернул подписанный бандл');

  // 8. Мультиканал: первый канал ПАДАЕТ, второй доставляет.
  const dead = async () => { throw new Error('blocked by DPI'); };
  const boot1 = new Bootstrap({ maintainerPubHex: pub, channels: [dead, bakedChannel(b)], cachePath: join(dir, 'c1.json') });
  const seeds1 = await boot1.resolve(now);
  ok(seeds1.length === 2 && seeds1.includes('https://n1:8820'), 'при мёртвом первом канале сиды пришли со второго');

  // 9. Выбор самого СВЕЖЕГО валидного бандла по epoch.
  const older = makeBootstrapBundle(priv, ['https://old:8820'], { epoch: 100, ttlMs: 30 * 86400000, now });
  const newer = makeBootstrapBundle(priv, ['https://new1:8820', 'https://new2:8820'], { epoch: 200, ttlMs: 30 * 86400000, now });
  const boot2 = new Bootstrap({ maintainerPubHex: pub, channels: [bakedChannel(older), bakedChannel(newer)], cachePath: join(dir, 'c2.json') });
  const seeds2 = await boot2.resolve(now);
  ok(seeds2.includes('https://new1:8820') && !seeds2.includes('https://old:8820'), 'принят более свежий бандл (epoch=200), старый отброшен');

  // 10. Подделка среди каналов игнорируется, берётся валидный.
  const boot3 = new Bootstrap({ maintainerPubHex: pub, channels: [bakedChannel(forged), bakedChannel(b)], cachePath: join(dir, 'c3.json') });
  const seeds3 = await boot3.resolve(now);
  ok(seeds3.includes('https://n1:8820') && !seeds3.includes('https://evil:8820'), 'подделанный бандл в канале проигнорирован, взят валидный');

  // 11. Кэш переживает падение ВСЕХ каналов.
  ok(existsSync(join(dir, 'c1.json')), 'валидный бандл сохранён в кэш');
  const boot4 = new Bootstrap({ maintainerPubHex: pub, channels: [dead, dead], cachePath: join(dir, 'c1.json') });
  const seeds4 = await boot4.resolve(now);
  ok(seeds4.length === 2, 'все каналы мертвы → сиды подняты из кэша (переживает блокировку)');

  // 12. Битый кэш не роняет и даёт пустой результат без каналов.
  const boot5 = new Bootstrap({ maintainerPubHex: pub, channels: [], cachePath: join(dir, 'nope.json') });
  ok(boot5.seeds().length === 0, 'нет кэша и каналов → пустой список сидов, без падения');

  // 13. channelsFromConfig собирает каналы из конфига.
  const chs = channelsFromConfig({ doh: [{ name: 'x', url: 'https://d' }], https: [{ url: 'https://h' }], baked: b }, httpsFetch);
  ok(chs.length === 3, 'channelsFromConfig собрал 3 канала (doh+https+baked)');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
