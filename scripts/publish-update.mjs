#!/usr/bin/env node
// publish-update.mjs — собрать и ПОДПИСАТЬ манифест релиза для автообновления.
//
// Что делает: берёт собранные пакеты (по платформам), считает их SHA-256 и размер,
// формирует манифест { version, notes, date, files:{win,mac,linux:{name,size,sha256,url}} },
// подписывает его приватным ключом мейнтейнера (Ed25519) и кладёт готовый
// dist/manifest.json. Этот manifest.json нужно опубликовать туда, откуда его читает
// клиент (сейчас — <PRIZRAK_WEB>/api/update/manifest.json; следующим шагом — в скрытый
// канал обновлений). Сами пакеты выкладываются по указанным url.
//
// Приватный ключ берётся из файла update-maintainer.key (в корне) или из переменной
// окружения PRIZRAK_UPDATE_KEY. Ключ держите ОФФЛАЙН и не коммитьте.
//
// Пример:
//   node scripts/publish-update.mjs 1.14.0 \
//     --notes "Автообновление" \
//     --win releases/win/"Prizrak Setup 1.14.0.exe" \
//     --mac releases/mac/"Prizrak-1.14.0-mac.zip" \
//     --linux releases/linux/"Prizrak-1.14.0.AppImage" \
//     --base-url https://prizrak.paymoney.online/download
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signManifest, sha256Hex } from '../packages/desktop/updater.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const version = argv.find((a) => /^\d+\.\d+\.\d+/.test(a));
if (!version) { console.error('Укажите версию, напр.: node scripts/publish-update.mjs 1.14.0 --win ... --mac ... --linux ... --android Prizrak-X.Y.Z-arm64.apk'); process.exit(1); }
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : null; };

const keyHex = (process.env.PRIZRAK_UPDATE_KEY || (existsSync(join(root, 'update-maintainer.key')) ? readFileSync(join(root, 'update-maintainer.key'), 'utf8').trim() : '')).trim();
if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.error('Нет приватного ключа. Положите update-maintainer.key в корень или задайте PRIZRAK_UPDATE_KEY (64 hex).'); process.exit(1); }

const baseUrl = (opt('base-url') || '').replace(/\/$/, '');
const notes = opt('notes') || '';
const files = {};
for (const plat of ['win', 'mac', 'linux', 'android']) {
  const p = opt(plat); if (!p) continue;
  if (!existsSync(p)) { console.error(`Файл для ${plat} не найден: ${p}`); process.exit(1); }
  const bytes = readFileSync(p), name = basename(p);
  files[plat] = { name, size: bytes.length, sha256: sha256Hex(bytes), url: baseUrl ? `${baseUrl}/${encodeURIComponent(name)}` : name };
  console.log(`• ${plat}: ${name}  ${(bytes.length / 1048576).toFixed(1)} МБ  sha256=${files[plat].sha256.slice(0, 16)}…`);
}
if (!Object.keys(files).length) { console.error('Не указан ни один пакет (--win/--mac/--linux/--android).'); process.exit(1); }

const manifest = { version, notes, date: new Date().toISOString().slice(0, 10), files };
const signed = signManifest(manifest, keyHex);

const outDir = join(root, 'dist'); mkdirSync(outDir, { recursive: true });
// --out manifest-android.json — отдельный манифест (напр. для Android, версии 0.x)
const outPath = join(outDir, opt('out') || 'manifest.json');
writeFileSync(outPath, JSON.stringify(signed, null, 2));
try { chmodSync(outPath, 0o644); } catch {} // читаемо для группы и остальных (для веб-сервера)
console.log(`\n✅ Подписанный манифест: ${outPath}`);
console.log('   Опубликуйте его как <PRIZRAK_WEB>/api/update/manifest.json и выложите пакеты по их url.');
