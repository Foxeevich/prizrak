#!/usr/bin/env node
// make-bootstrap.mjs — Фаза 6b: смонтировать ПОДПИСАННЫЙ бутстрап-бандл сид-узлов тайников.
//
// Тем же ключом мейнтейнера, что подписывает автообновления (update-maintainer.key или
// PRIZRAK_UPDATE_KEY, 64 hex). На выходе — три формы одного подписанного бандла:
//   • JSON-бандл (для HTTPS/CDN-канала и как baked-резерв в конфиге сервера);
//   • строка DNS-TXT: prizrak-boot=<base64url(json)> (положить в TXT-запись домена);
//   • публичный ключ мейнтейнера (вшить в сборку как корень доверия к бандлу).
//
// Пример:
//   node scripts/make-bootstrap.mjs \
//     --seed https://n1.example:8820 --seed https://n2.example:8820 \
//     --ttl-days 90 --out dist/prizrak-boot.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { makeBootstrapBundle } from '../packages/server/src/bootstrap.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opts = (name) => argv.reduce((acc, a, i) => (a === '--' + name ? [...acc, argv[i + 1]] : acc), []);
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };

const seeds = opts('seed');
if (!seeds.length) { console.error('Укажите хотя бы один --seed https://host:port'); process.exit(1); }

const keyHex = (process.env.PRIZRAK_UPDATE_KEY || (existsSync(join(root, 'update-maintainer.key')) ? readFileSync(join(root, 'update-maintainer.key'), 'utf8').trim() : '')).trim();
if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.error('Нет приватного ключа мейнтейнера. Положите update-maintainer.key в корень или задайте PRIZRAK_UPDATE_KEY (64 hex).'); process.exit(1); }

const ttlMs = Number(opt('ttl-days', 90)) * 86400000;
const bundle = makeBootstrapBundle(keyHex, seeds, { ttlMs });
const pub = bytesToHex(ed25519.getPublicKey(hexToBytes(keyHex)));

const json = JSON.stringify(bundle);
const b64url = Buffer.from(json).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

const outPath = opt('out', join(root, 'dist', 'prizrak-boot.json'));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(bundle, null, 2));

console.log('✅ Подписанный бутстрап-бандл готов\n');
console.log('Публичный ключ мейнтейнера (вшить в сборку как корень доверия):');
console.log('  ' + pub + '\n');
console.log('Сиды в бандле: ' + bundle.seeds.join(', '));
console.log('epoch=' + bundle.epoch + '  действителен до ' + new Date(bundle.notAfter).toISOString().slice(0, 10) + '\n');
console.log('JSON-бандл: ' + outPath + '  (для HTTPS/CDN-канала или как "baked" в конфиге)\n');
console.log('DNS-TXT запись (положить в TXT нужного имени, можно на нескольких доменах):');
console.log('  prizrak-boot=' + b64url + '\n');
console.log('Пример deaddropBootstrap в конфиге сервера:');
console.log(JSON.stringify({ deaddropBootstrap: { maintainerPub: pub, doh: [{ name: 'boot.ВАШ-ДОМЕН', url: 'https://cloudflare-dns.com/dns-query' }], https: [{ url: 'https://ВАШ-CDN/prizrak-boot.json' }], baked: bundle } }, null, 2));
