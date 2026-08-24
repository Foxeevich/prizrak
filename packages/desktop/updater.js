// updater.js — ядро системы обновлений (без Electron, чтобы легко тестировать).
// Манифест релиза — подписанный Ed25519 JSON: версия, что нового и по каждой
// платформе имя файла, размер и SHA-256. Подпись мейнтейнера (ключ зашит в
// клиент) гарантирует подлинность: канал/сервер — лишь транспорт. Клиент качает
// пакет, сверяет SHA-256 и проверяет подпись — только потом ставит.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

// Публичный ключ мейнтейнера. Приватный держится ОФФЛАЙН (см. update-maintainer.key
// и scripts/publish-update.mjs). Подписанные им манифесты клиент считает доверенными.
export const UPDATE_PUBKEY = '1b50aa53633c2b4922f8a1deb3f3dea71f350fac80aae5f6061d9b7abc7a1a2e';

// Детерминированный вид манифеста для подписи: без поля sig, ключи отсортированы.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]); return o; }
  return v;
}
export function canonicalManifest(m) { const { sig, ...rest } = m || {}; return JSON.stringify(sortKeys(rest)); }

// Подписать манифест приватным ключом (hex seed) → манифест с полем sig.
export function signManifest(m, privHex) {
  const msg = new TextEncoder().encode(canonicalManifest(m));
  return { ...m, sig: bytesToHex(ed25519.sign(msg, hexToBytes(privHex))) };
}

// Проверить подпись манифеста зашитым (или переданным) публичным ключом.
export function verifyManifest(m, pubHex = UPDATE_PUBKEY) {
  try {
    if (!m || typeof m.sig !== 'string' || !m.version) return false;
    const msg = new TextEncoder().encode(canonicalManifest(m));
    return ed25519.verify(hexToBytes(m.sig), msg, hexToBytes(pubHex));
  } catch { return false; }
}

// Сравнение версий semver-подобно: строго новее?
export function isNewer(candidate, current) {
  const pa = String(candidate).split('.').map(Number), pb = String(current).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const a = pa[i] || 0, b = pb[i] || 0; if (a !== b) return a > b; }
  return false;
}

// SHA-256 (hex) от байтов — для сверки скачанного пакета с манифестом.
export function sha256Hex(bytes) { return bytesToHex(sha256(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))); }

// Платформа Node (process.platform) → ключ в манифесте.
export function platformKey(p) { return p === 'darwin' ? 'mac' : p === 'win32' ? 'win' : 'linux'; }

// Выбрать запись файла для текущей платформы из проверенного манифеста.
export function pickFile(manifest, platform) {
  const key = platformKey(platform);
  const f = manifest && manifest.files && manifest.files[key];
  return f && f.name && f.sha256 ? { platform: key, ...f } : null;
}
