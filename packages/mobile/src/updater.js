// Система обновлений мобильного клиента — ТОТ ЖЕ канал, что у десктопа:
// подписанный Ed25519 manifest.json (<PRIZRAK_WEB>/api/update/manifest.json),
// платформа "android" (APK кладётся в ту же папку, что и десктопные пакеты).
// Подпись мейнтейнера проверяется зашитым публичным ключом; при установке
// поверх Android дополнительно сверит подпись самого APK (наш keystore).
import {ed25519} from '@noble/curves/ed25519';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';

export const APP_VERSION = '2.1.7'; // держать в синхроне с android versionName

// Публичный ключ мейнтейнера обновлений (тот же, что в desktop/updater.js).
export const UPDATE_PUBKEY =
  '1b50aa53633c2b4922f8a1deb3f3dea71f350fac80aae5f6061d9b7abc7a1a2e';

// Отдельный манифест для Android (в той же папке, что и десктопный manifest.json):
// у десктопа версии 1.13.x, у мобилки 0.2.x — общее поле version смешивать нельзя.
// Пробуем несколько путей: /download/ — статическая папка рядом с APK (точно
// отдаётся веб-сервером), /api/update/ — как у десктопа (может быть backend-роут).
export const UPDATE_FEEDS = [
  'https://prizrak.paymoney.online/download/manifest-android.json',
  'https://prizrak.paymoney.online/api/update/manifest-android.json',
  'https://prizrak.paymoney.online/manifest-android.json',
];

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}
export function canonicalManifest(m) {
  const {sig, ...rest} = m || {};
  return JSON.stringify(sortKeys(rest));
}
export function verifyManifest(m, pubHex = UPDATE_PUBKEY) {
  try {
    if (!m || typeof m.sig !== 'string' || !m.version) return false;
    const msg = new TextEncoder().encode(canonicalManifest(m));
    return ed25519.verify(hexToBytes(m.sig), msg, hexToBytes(pubHex));
  } catch {
    return false;
  }
}
export function isNewer(candidate, current) {
  const pa = String(candidate).split('.').map(Number);
  const pb = String(current).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i] || 0,
      b = pb[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

// Диагностическая проверка обновлений. Возвращает объект со статусом:
//   'update'      — есть новее: {status,version,url,notes,size}
//   'latest'      — манифест получен, но версия не новее (manifestVersion===current)
//   'unsigned'    — подпись манифеста неверна (подделка/чужой ключ)
//   'nofile'      — в манифесте нет android-файла
//   'unreachable' — ни один фид не отдал манифест (сеть/403/404) — reason содержит детали
// НИКОГДА не «глотает» ошибку молча — Settings показывает точную причину.
export async function checkUpdate(current = APP_VERSION) {
  const errors = [];
  for (const feed of UPDATE_FEEDS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(feed + '?t=' + Date.now(), {
        signal: ctrl.signal,
        headers: {'cache-control': 'no-cache'},
      });
      clearTimeout(t);
      if (!r.ok) {
        errors.push(`HTTP ${r.status} @ ${shortUrl(feed)}`);
        continue;
      }
      let m;
      try {
        m = await r.json();
      } catch {
        errors.push(`не JSON @ ${shortUrl(feed)}`);
        continue;
      }
      if (!verifyManifest(m)) {
        return {status: 'unsigned', currentVersion: current, manifestVersion: m && m.version};
      }
      const f = m.files && m.files.android;
      if (!f || !f.url) {
        return {status: 'nofile', currentVersion: current, manifestVersion: m.version};
      }
      if (!isNewer(m.version, current)) {
        return {status: 'latest', currentVersion: current, manifestVersion: m.version};
      }
      return {
        status: 'update',
        version: m.version,
        notes: m.notes || '',
        url: f.url,
        size: f.size || 0,
        sha256: f.sha256 || null,
        currentVersion: current,
        manifestVersion: m.version,
      };
    } catch (e) {
      errors.push(`${(e && e.name) === 'AbortError' ? 'таймаут' : (e && e.message) || 'сбой'} @ ${shortUrl(feed)}`);
    }
  }
  return {status: 'unreachable', currentVersion: current, reason: errors.join('; ')};
}

function shortUrl(u) {
  return String(u).replace(/^https?:\/\//, '').replace(/\?.*$/, '');
}
