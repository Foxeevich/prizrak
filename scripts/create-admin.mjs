// create-admin.mjs — провижининг администратора на этапе развёртывания.
// Создаёт аккаунт <name>:<domain> с заданным паролем и флагом администратора.
// Имя ЛЮБОЕ (не обязательно root). После создания ник зарезервирован (регистрация вернёт 409).
//
// Использование:
//   PRIZRAK_CONFIG=./prizrak.config.json node scripts/create-admin.mjs --password 'ВашПароль'
//   PRIZRAK_CONFIG=./prizrak.config.json node scripts/create-admin.mjs --name fox --password '…'
//   # --name задаёт любой ник; без него берётся первый из admins в конфиге.
//   # Если аккаунт уже есть — с --promote просто выдаём ему права админа (без пересоздания).
import { loadConfig } from '../packages/server/src/config.js';
import { hashPassword } from '../packages/server/src/accounts.js';
import { Store } from '../packages/server/src/store.js';

const args = process.argv.slice(2);
let password = null, name = null, promote = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--password') password = args[++i];
  else if (args[i] === '--name') name = args[++i];
  else if (args[i] === '--promote') promote = true;
}

const cfg = loadConfig();
if (!cfg.storePath) { console.error('Ошибка: в конфиге не задан storePath.'); process.exit(1); }

// Ник: из --name, иначе первый админ из конфига. Допустим и полный user:domain.
const raw = (name || cfg.admin || '').trim();
if (!raw) { console.error('Ошибка: укажите --name <ник> или задайте admins в конфиге.'); process.exit(1); }
const localpart = raw.includes(':') ? raw.split(':')[0] : raw;
const userId = raw.includes(':') ? raw : `${localpart}:${cfg.domain}`;

const store = new Store(cfg.storePath);
const existing = store.getAccount(userId);

if (existing) {
  if (promote) {
    store.setAdmin(userId, true);
    console.log(`✅ Пользователю ${userId} выданы права администратора.`);
    process.exit(0);
  }
  console.error(`Аккаунт ${userId} уже существует. Добавьте --promote, чтобы просто выдать ему админ-права.`);
  process.exit(2);
}

if (!password) { console.error('Ошибка: для нового админа укажите --password "…" (мин. 8 символов).'); process.exit(1); }
const pw = hashPassword(password); // бросит, если пароль слишком короткий
store.createAccount(userId, { ...pw, isAdmin: true });

console.log(`✅ Администратор создан: ${userId}`);
console.log('   Ник зарезервирован (повторная регистрация вернёт «занято»).');
console.log('   Войдите в клиенте под этим именем и паролем — ключи опубликуются при первом входе.');
console.log('   Подсказка: несколько админов — перечислите их в конфиге "admins":["fox","alice"],');
console.log('   или выдайте права на лету действующим админом (/admin/grant-admin).');
