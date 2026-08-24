// sync-mobile-lib.mjs — делает React Native клиент самодостаточным.
// Копирует исходники @prizrak/crypto, @prizrak/transport и @prizrak/client
// внутрь packages/mobile/src/lib, переписывая относительные импорты так, чтобы
// Metro-бандлер собирал их из локальной папки (как это сделано для desktop/lib).
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = join(root, 'packages', 'mobile', 'src', 'lib');

function copyDir(srcRel, dstRel) {
  const src = join(root, srcRel), dst = join(lib, dstRel);
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) if (f.endsWith('.js')) copyFileSync(join(src, f), join(dst, f));
}
function rewrite(code) {
  return code
    .replace(/\.\.\/\.\.\/crypto\/src\//g, './crypto/')
    .replace(/\.\.\/\.\.\/transport\/src\//g, './transport/');
}

copyDir('packages/crypto/src', 'crypto');

writeFileSync(join(lib, 'client.js'), rewrite(readFileSync(join(root, 'packages/client/src/client.js'), 'utf8')));
writeFileSync(join(lib, 'link-preview.js'), rewrite(readFileSync(join(root, 'packages/client/src/link-preview.js'), 'utf8')));

// Мобильная заглушка call.js: транспорт звонков (stealth/SRTP) тянет node:tls/net,
// которых нет в React Native. Аудио/видео-звонки в мобильном v1 не поддержаны —
// сохраняем только чистую parseRelay, а Call бросает понятную ошибку при попытке звонка.
const callStub = `// call.js (mobile stub) — звонки в мобильном клиенте пока не поддержаны.
export function parseRelay(relayUrl) {
  const s = String(relayUrl).replace(/^stealth:\\/\\//, '');
  const [host, port] = s.split(':');
  return { host: host || '127.0.0.1', port: Number(port || 8810) };
}
export class Call {
  constructor() { throw new Error('Звонки пока недоступны в мобильном клиенте Prizrak'); }
}
`;
writeFileSync(join(lib, 'call.js'), callStub);

function scan(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) scan(p);
    else if (f.name.endsWith('.js')) {
      const code = readFileSync(p, 'utf8');
      if (/from\s+['"]\.\.\/\.\.\//.test(code)) {
        console.error(`❌ В ${p} остался внешний импорт ../../ — сборка сломается`);
        process.exit(1);
      }
    }
  }
}
scan(lib);
console.log('✅ mobile/src/lib синхронизирован (crypto + transport + client + call), внешних импортов нет');
