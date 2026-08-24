// sync-desktop-lib.mjs — делает Electron-клиент самодостаточным для сборки.
// Копирует исходники @prizrak/crypto, @prizrak/transport и @prizrak/client
// внутрь packages/desktop/lib, ПЕРЕПИСЫВАЯ относительные импорты так, чтобы они
// не «выходили» за пределы упаковки (иначе .app падает с ERR_MODULE_NOT_FOUND).
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = join(root, 'packages', 'desktop', 'lib');

function copyDir(srcRel, dstRel) {
  const src = join(root, srcRel), dst = join(lib, dstRel);
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) if (f.endsWith('.js')) copyFileSync(join(src, f), join(dst, f));
}
// Универсальная переписка путей: любой ../../<pkg>/src/ → ./<pkg>/
function rewrite(code) {
  return code
    .replace(/\.\.\/\.\.\/crypto\/src\//g, './crypto/')
    .replace(/\.\.\/\.\.\/transport\/src\//g, './transport/');
}

copyDir('packages/crypto/src', 'crypto');
copyDir('packages/transport/src', 'transport');

// 🛡 движок VPN внутрь приложения (SOCKS-режим): только нужные модули клиента,
// без старого демо (client.js/node.js) и серверных узлов.
function copyFiles(srcRel, dstRel, names) {
  const src = join(root, srcRel), dst = join(lib, dstRel);
  mkdirSync(dst, { recursive: true });
  for (const f of names) copyFileSync(join(src, f), join(dst, f));
}
copyFiles('packages/vpn/src', 'vpn', [
  'shadow.js', 'shaping.js', 'breath.js', 'wire.js', 'estafeta.js', 'client-tunnel.js', 'socks.js',
]);

writeFileSync(join(lib, 'client.js'), rewrite(readFileSync(join(root, 'packages/client/src/client.js'), 'utf8')));
writeFileSync(join(lib, 'link-preview.js'), rewrite(readFileSync(join(root, 'packages/client/src/link-preview.js'), 'utf8')));
writeFileSync(join(lib, 'call.js'), rewrite(readFileSync(join(root, 'packages/client/src/call.js'), 'utf8')));

// Защита: ни один файл в lib/ не должен импортировать «наружу» (../../…),
// иначе упакованное приложение упадёт с ERR_MODULE_NOT_FOUND.
function scan(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) scan(p);
    else if (f.name.endsWith('.js')) {
      const code = readFileSync(p, 'utf8');
      if (/from\s+['"]\.\.\/\.\.\//.test(code)) {
        console.error(`❌ В ${p} остался внешний импорт ../../ — упаковка сломается`);
        process.exit(1);
      }
    }
  }
}
scan(lib);
console.log('✅ desktop/lib синхронизирован (crypto + transport + client + call), внешних импортов нет');
