// B2: копия аккаунта в файл. Экспорт запечатанной паролем личности, «переустановка»
// (свежий клиент) и восстановление из файла → те же ключи (fingerprint), аккаунт
// работает, собеседник расшифровывает. Неверный пароль файла — ошибка.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8993, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'b.org', port: P, storePath: null, storagePaths: ['/tmp/mAcct'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:b.org`, baseUrl: U, bankBase: U }).init(); return c; };

const alice = await mk('alice'); await alice.register('alice-pass-123');
const bob = await mk('bob'); await bob.register('bob-pass-123');

// Наладили переписку, чтобы было что проверять по личности.
await alice.send('bob:b.org', 'привет от Алисы');
ok((await bob.receive()).some((m) => m.text === 'привет от Алисы'), 'Боб получил сообщение Алисы');
const aliceFp = alice.fingerprint;

// Экспорт копии аккаунта Алисы (пароль файла отдельный).
const file = alice.exportBackupBlob('file-secret-99');
ok(file.userId === 'alice:b.org' && typeof file.blob === 'string', 'файл копии сформирован');

// Неверный пароль файла — не открыть.
let threw = false; try { PrizrakClient.openBackupBlob('wrong-pass', file); } catch { threw = true; }
ok(threw, 'неверный пароль файла отклонён');

// «Переустановка»: совершенно новый клиент со свежими ключами, затем восстановление из файла.
const alice2 = await new PrizrakClient({ name: 'alice', userId: 'alice:b.org', baseUrl: U, bankBase: U }).init();
const freshFp = alice2.fingerprint;
ok(freshFp !== aliceFp, 'у свежего клиента другие ключи (до восстановления)');
const secret = PrizrakClient.openBackupBlob('file-secret-99', file);
await alice2.loginWithSecret('alice-pass-123', secret);
ok(alice2.fingerprint === aliceFp, 'после восстановления из файла — те же ключи (fingerprint совпал)');

// Восстановленная Алиса пишет Бобу — он расшифровывает (личность совпала с bundle).
await alice2.send('bob:b.org', 'снова я, восстановилась');
ok((await bob.receive()).some((m) => m.text === 'снова я, восстановилась' && !m.error), 'Боб читает сообщение восстановленной Алисы');

console.log('🎉 копия аккаунта: экспорт + восстановление из файла — ок');
s.server.close();
