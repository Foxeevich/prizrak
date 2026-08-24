// Интеграционный тест мобильного ядра в среде «как Hermes»:
// НЕТ настоящего WebCrypto (subtle удалён) → работает наш полифилл на @noble;
// openpgp — БРАУЗЕРНАЯ сборка (как в Metro); клиент — мобильный src/lib.
// Проверяем: регистрация, вход, E2E-переписка мобильный↔десктопный клиент.
// Генерируем .sim-lib: копия src/lib, где 'openpgp' указывает на БРАУЗЕРНУЮ сборку
// (Node по умолчанию взял бы node-сборку и замаскировал бы проблемы Hermes).
import { cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __d = dirname(fileURLToPath(import.meta.url));
rmSync(join(__d, '.sim-lib'), { recursive: true, force: true });
cpSync(join(__d, 'src/lib'), join(__d, '.sim-lib'), { recursive: true });
const idPath = join(__d, '.sim-lib/crypto/identity.js');
writeFileSync(idPath, readFileSync(idPath, 'utf8').replace(
  "from 'openpgp'",
  `from '${join(__d, 'node_modules/openpgp/dist/openpgp.min.mjs')}'`,
));

const rnd = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
delete globalThis.crypto;
globalThis.crypto = { getRandomValues: rnd }; // как react-native-get-random-values

const { installWebCrypto } = await import('./src/webcrypto-subtle.js');
installWebCrypto();
console.log('polyfill installed, subtle:', typeof globalThis.crypto.subtle.digest);

const { createServer } = await import('../server/src/server.js');
const { PrizrakClient: MobileClient } = await import('./.sim-lib/client.js');
const { PrizrakClient: DesktopClient } = await import('../client/src/client.js');

const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const P = 8991, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'm.org', port: P, storePath: null, storagePaths: ['/tmp/mSIM'], registrationEnabled: true });

// 1. Мобильная регистрация (весь путь: openpgp browser + scrypt + prekeys)
const t0 = Date.now();
const mob = await new MobileClient({ name: 'foxmob', userId: 'foxmob:m.org', baseUrl: U, bankBase: U, deviceId: 'mob-test1' }).init();
console.log('  init (createIdentity+prekeys):', Date.now() - t0, 'ms');
await mob.register('mob-pass-123');
await mob.publishDevice();
ok(!!mob.token, 'мобильная регистрация прошла');

// 2. Десктопный собеседник
const desk = await new DesktopClient({ name: 'deskbob', userId: 'deskbob:m.org', baseUrl: U, bankBase: U, deviceId: 'desk1' }).init();
await desk.register('desk-pass-123');
await desk.publishDevice();

// 3. Переписка мобильный → десктоп
await mob.send('deskbob:m.org', 'привет с телефона!');
const inbox1 = await desk.receive();
const got1 = inbox1.find((m) => m.kind === 'text');
ok(got1 && got1.text === 'привет с телефона!', 'десктоп получил и расшифровал сообщение с телефона');

// 4. Ответ десктоп → мобильный
await desk.send('foxmob:m.org', 'привет с компа!');
const inbox2 = await mob.receive();
const got2 = inbox2.find((m) => m.kind === 'text');
ok(got2 && got2.text === 'привет с компа!', 'телефон получил и расшифровал ответ');

// 5. Перезапуск приложения: fromState + adopt, сообщение после рестарта
const state = mob.serializeState();
const mob2 = MobileClient.fromState(state);
await desk.send('foxmob:m.org', 'после рестарта');
const inbox3 = await mob2.receive();
const got3 = inbox3.find((m) => m.kind === 'text');
ok(got3 && got3.text === 'после рестарта', 'после перезапуска (fromState) сообщения читаются');

// 6. Логин с чужого «устройства» (восстановление identity из keyBackup)
const mob3 = await new MobileClient({ name: 'foxmob', userId: 'foxmob:m.org', baseUrl: U, bankBase: U, deviceId: 'mob-test2' }).init();
await mob3.login('mob-pass-123');
ok(mob3.identity.fingerprint === mob.identity.fingerprint, 'вход на новом устройстве восстановил ту же личность (keyBackup)');

console.log('🎉 мобильное ядро работает в Hermes-среде (без WebCrypto, полифилл @noble)');
s.server.close();
process.exit(0);
