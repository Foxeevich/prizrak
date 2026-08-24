// afterPack.cjs — хук electron-builder.
// На macOS накладывает AD-HOC подпись на собранный .app ДО упаковки в .dmg,
// чтобы свежесобранное приложение открывалось на этой машине без ошибки
// Gatekeeper «вредоносное ПО» (у неподписанных приложений macOS её показывает).
// Ad-hoc-подпись действует только локально; для раздачи другим нужен Apple
// Developer ID и нотаризация.
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  try {
    // Снять карантин (если есть) и подписать ad-hoc, рекурсивно и с флагами runtime-совместимости.
    try { execSync(`xattr -cr "${appPath}"`, { stdio: 'ignore' }); } catch {}
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log(`\n✅ [afterPack] ad-hoc подпись применена: ${appName}`);
    console.log('   Приложение откроется на этом Маке. Для раздачи другим нужен Apple Developer ID + нотаризация.\n');
  } catch (e) {
    console.warn(`⚠️  [afterPack] ad-hoc подпись не удалась: ${e.message}`);
    console.warn('   Открыть можно вручную: xattr -cr <app> && codesign --force --deep --sign - <app>');
  }
};
