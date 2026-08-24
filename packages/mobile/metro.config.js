const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const path = require('path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const defaultConfig = getDefaultConfig(__dirname);

// openpgp публикует несколько сборок. В node-окружении Metro по умолчанию берёт
// CJS-сборку (dist/node/openpgp.min.cjs), которая тянет node:crypto/streams и
// падает в React Native. Явно перенаправляем импорт 'openpgp' на браузерную
// ESM-сборку: она использует WebCrypto при наличии, иначе — чистый JS (noble),
// что нам и нужно на телефоне (getRandomValues мы полифиллим).
const openpgpBrowser = path.resolve(
  __dirname,
  'node_modules/openpgp/dist/openpgp.min.mjs',
);

const config = {
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName === 'openpgp') {
        return {type: 'sourceFile', filePath: openpgpBrowser};
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(defaultConfig, config);
