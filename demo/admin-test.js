// admin-test.js — проверка провижининга администратора (create-admin) v1.1.1:
//   • имя админа зарезервировано (повторная регистрация → «занято»);
//   • при первом входе админа публикуются ключи, и с ним можно завести E2E-сессию.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
import { Store } from '../packages/server/src/store.js';
import { hashPassword } from '../packages/server/src/accounts.js';
import { writeFileSync, rmSync } from 'node:fs';

function assert(c, m) { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); }
const PORT = 8921, URL = `http://127.0.0.1:${PORT}`;
const STORE = '/tmp/prizrak-admin-test.json';
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });

// Провижиним админа заранее (эмуляция create-admin) в файловом хранилище.
try { rmSync(STORE); } catch {}
const seed = new Store(STORE);
seed.createAccount('root:chat.org', { ...hashPassword('super-admin-pass'), isAdmin: true });

const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: STORE, registrationEnabled: true, admin: 'root' });

// Имя зарезервировано: повторная регистрация root должна упасть.
let taken = false;
try { await new PrizrakClient({ name: 'X', userId: 'root:chat.org', baseUrl: URL }).init().then((c) => c.register('another-pass-12')); }
catch (e) { taken = /занят/i.test(e.message); }
assert(taken, 'Имя админа зарезервировано (перехватить нельзя)');

// Админ входит своим паролем — ключи публикуются при первом входе.
const admin = await new PrizrakClient({ name: 'Root', userId: 'root:chat.org', baseUrl: URL }).init();
const l = await admin.login('super-admin-pass');
assert(l.ok && l.isAdmin, 'Админ вошёл по паролю и получил флаг администратора');

// Кто-то заводит E2E-переписку с админом — значит ключи реально опубликованы.
const alice = await new PrizrakClient({ name: 'Alice', userId: 'alice:chat.org', baseUrl: URL }).init();
await alice.register('alice-pass-123');
await alice.send('root:chat.org', 'Здравствуйте, админ!');
const got = await admin.receive();
assert(got.find((m) => m.text === 'Здравствуйте, админ!'), 'E2E-сообщение админу доставлено (ключи опубликованы при входе)');

console.log('🎉 Провижининг администратора работает.');
srv.server.close();
try { rmSync(STORE); } catch {}
