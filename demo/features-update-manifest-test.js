// Ядро автообновления: подпись манифеста релиза, проверка подписи, отклонение
// подделки, выбор файла под платформу, сверка SHA-256 и сравнение версий.
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { webcrypto } from 'node:crypto';
import { signManifest, verifyManifest, isNewer, sha256Hex, pickFile, UPDATE_PUBKEY } from '../packages/desktop/updater.js';
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };

// Свой тестовый ключ (не трогаем боевой публичный).
const seed = webcrypto.getRandomValues(new Uint8Array(32));
const priv = bytesToHex(seed);
const pub = bytesToHex(ed25519.getPublicKey(seed));

const pkg = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const manifest = {
  version: '1.20.0', notes: 'тест', date: '2026-08-11',
  files: {
    win: { name: 'Prizrak Setup 1.20.0.exe', size: pkg.length, sha256: sha256Hex(pkg) },
    mac: { name: 'Prizrak-1.20.0-mac.zip', size: pkg.length, sha256: sha256Hex(pkg) },
    linux: { name: 'Prizrak-1.20.0.AppImage', size: pkg.length, sha256: sha256Hex(pkg) },
  },
};

const signed = signManifest(manifest, priv);
ok(typeof signed.sig === 'string' && signed.sig.length === 128, 'манифест подписан (есть sig)');
ok(verifyManifest(signed, pub) === true, 'подпись проверяется верным ключом');
ok(verifyManifest(signed, UPDATE_PUBKEY) === false, 'чужой (боевой) ключ подпись не подтверждает');

// Подделка: подменили версию/хэш после подписи — подпись обязана слететь.
const tampered = { ...signed, version: '9.9.9' };
ok(verifyManifest(tampered, pub) === false, 'подделка версии отклоняется');
const tampered2 = JSON.parse(JSON.stringify(signed)); tampered2.files.win.sha256 = 'deadbeef';
ok(verifyManifest(tampered2, pub) === false, 'подделка хэша файла отклоняется');
ok(verifyManifest({ ...manifest }, pub) === false, 'манифест без подписи не проходит');

// Выбор файла под платформу + сверка SHA-256 скачанного пакета.
const f = pickFile(signed, 'darwin');
ok(f && f.platform === 'mac' && f.name.includes('mac'), 'выбран файл для macOS');
ok(sha256Hex(pkg) === f.sha256, 'SHA-256 скачанного пакета совпадает с манифестом');
ok(sha256Hex(new Uint8Array([9, 9, 9])) !== f.sha256, 'битый пакет по SHA-256 не пройдёт');

// Сравнение версий.
ok(isNewer('1.20.0', '1.13.42') === true, 'новее: 1.20.0 > 1.13.42');
ok(isNewer('1.13.42', '1.13.42') === false, 'та же версия — не новее');
ok(isNewer('1.13.9', '1.13.10') === false, 'числовое сравнение: 1.13.9 < 1.13.10');

console.log('🎉 ядро автообновления (подпись/проверка/версии) — ок');
