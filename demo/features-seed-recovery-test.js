// B3: фраза восстановления. Мнемоника (кодирование+контрольная сумма), включение
// восстановления по фразе, восстановление личности + сброс пароля по фразе.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
import { generateMnemonic, mnemonicToBytes, isValidMnemonic, normalizeMnemonic } from '../packages/crypto/src/index.js';
const P = 8992, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 's.org', port: P, storePath: null, storagePaths: ['/tmp/mSeed'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:s.org`, baseUrl: U, bankBase: U }).init(); return c; };

// 1) Мнемоника: кодирование обратимо, контрольная сумма ловит опечатку.
const mn = generateMnemonic();
ok(mn.split(' ').length === 17, 'фраза = 17 слов (16 данных + контроль)');
ok(isValidMnemonic(mn), 'сгенерированная фраза валидна');
ok(mnemonicToBytes(mn).length === 16, 'декодируется в 16 байт');
const words = normalizeMnemonic(mn).split(' '); words[0] = words[0] === 'ba' ? 'be' : 'ba';
ok(!isValidMnemonic(words.join(' ')), 'фраза с подменённым словом отклоняется (контрольная сумма)');
ok(!isValidMnemonic('foo bar baz'), 'мусорная фраза невалидна');

// 2) Аккаунт + включение восстановления по фразе.
const alice = await mk('alice'); await alice.register('alice-pass-123');
const bob = await mk('bob'); await bob.register('bob-pass-123');
const aliceFp = alice.fingerprint;
const phrase = await alice.enableSeedRecovery();
ok(isValidMnemonic(phrase), 'включено восстановление по фразе, фраза выдана');

// 3) «Потеря устройства»: свежий клиент восстанавливается по фразе + новый пароль.
const alice2 = await mk('alice');
ok(alice2.fingerprint !== aliceFp, 'у свежего клиента другие ключи');
let threw = false; try { await alice2.recoverBySeed('foo bar baz', 'new-pass-456'); } catch { threw = true; }
ok(threw, 'восстановление по неверной фразе не проходит');
await alice2.recoverBySeed(phrase, 'new-pass-456');
ok(alice2.fingerprint === aliceFp, 'после восстановления по фразе — та же личность (fingerprint)');

// 4) Новый пароль работает (старый сброшен).
const alice3 = await mk('alice');
const d = await alice3.login('new-pass-456');
ok(d && d.token, 'вход с новым паролем после восстановления работает');

// 5) Восстановленная Алиса пишет Бобу — расшифровывается.
await alice2.send('bob:s.org', 'я вернулась по сид-фразе');
ok((await bob.receive()).some((m) => m.text === 'я вернулась по сид-фразе' && !m.error), 'Боб читает сообщение восстановленной по фразе Алисы');

console.log('🎉 фраза восстановления (B3) — ок');
s.server.close();
