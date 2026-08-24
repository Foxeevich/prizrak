// admins-7.mjs — админ сервера с ЛЮБЫМ ником, несколько админов, выдача прав на лету.
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const dir = mkdtempSync(join(tmpdir(), 'adm-'));

try {
  // Конфиг со списком админов (любые ники, не root).
  const cfgPath = join(dir, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({ domain: 'x.org', storePath: join(dir, 'store.json'), admins: ['fox', 'alice'] }));
  process.env.PRIZRAK_CONFIG = cfgPath;
  delete process.env.PRIZRAK_ADMIN;
  const cfg = loadConfig();
  ok(Array.isArray(cfg.admins) && cfg.admins.length === 2, 'несколько админов из конфига (admins:[fox,alice])');
  ok(cfg.admin === 'fox', 'cfg.admin (legacy) = первый из списка');

  // Логика isAdmin при регистрации: совпадение localpart ИЛИ полного id с набором.
  const adminSet = new Set(cfg.admins);
  const regIsAdmin = (uid) => adminSet.has(uid.split(':')[0]) || adminSet.has(uid);
  ok(regIsAdmin('fox:x.org') && regIsAdmin('alice:x.org'), 'fox и alice получают админа при регистрации');
  ok(!regIsAdmin('bob:x.org'), 'посторонний bob админом НЕ становится');

  // Выдача/снятие прав на лету через хранилище.
  const store = new Store(cfg.storePath);
  store.createAccount('fox:x.org', { isAdmin: regIsAdmin('fox:x.org') });
  store.createAccount('bob:x.org', { isAdmin: regIsAdmin('bob:x.org') });
  ok(store.getAccount('fox:x.org').isAdmin === true && store.getAccount('bob:x.org').isAdmin === false, 'флаги isAdmin проставлены верно');
  store.setAdmin('bob:x.org', true);
  ok(store.getAccount('bob:x.org').isAdmin === true, 'bob получил админа на лету (grant-admin)');
  ok(store.listAdmins().sort().join(',') === 'bob:x.org,fox:x.org', 'listAdmins возвращает всех админов');
  store.setAdmin('bob:x.org', false);
  ok(store.getAccount('bob:x.org').isAdmin === false, 'у bob сняты права (revoke-admin)');
  ok(store.setAdmin('nope:x.org', true) === false, 'нельзя выдать права несуществующему аккаунту');

  // Одиночный ник тоже работает (обратная совместимость с --admin fox).
  const cfg2Path = join(dir, 'cfg2.json');
  writeFileSync(cfg2Path, JSON.stringify({ domain: 'x.org', storePath: join(dir, 's2.json'), admin: 'boss' }));
  process.env.PRIZRAK_CONFIG = cfg2Path;
  const cfg2 = loadConfig();
  ok(cfg2.admins.length === 1 && cfg2.admins[0] === 'boss' && cfg2.admin === 'boss', 'одиночный admin:"boss" (не root) работает');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
