// demo.js — сквозной сценарий Prizrak:
//   • Поднимаем ДВА homeserver'а на разных доменах (a.org и b.org).
//   • Alice живёт на a.org, Bob — на b.org.
//   • Они переписываются E2E ЧЕРЕЗ ФЕДЕРАЦИЮ, при этом ни один сервер
//     не видит открытого текста.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const A_PORT = 8801, B_PORT = 8802;
const A_URL = `http://127.0.0.1:${A_PORT}`, B_URL = `http://127.0.0.1:${B_PORT}`;

// Локальный реестр «домен → URL» (в проде это DNS + /.well-known)
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'a.org': A_URL, 'b.org': B_URL });

function line() { console.log('─'.repeat(64)); }

const srvA = await createServer({ domain: 'a.org', port: A_PORT, storePath: null });
const srvB = await createServer({ domain: 'b.org', port: B_PORT, storePath: null });

line();
const alice = await new PrizrakClient({ name: 'Alice', userId: 'alice:a.org', baseUrl: A_URL }).init();
const bob = await new PrizrakClient({ name: 'Bob', userId: 'bob:b.org', baseUrl: B_URL }).init();
await alice.register('alice-strong-pass');
await bob.register('bob-strong-pass');
console.log(`Alice alice:a.org  (safety-number ${alice.fingerprint})`);
console.log(`Bob   bob:b.org    (safety-number ${bob.fingerprint})`);
line();

// Alice → Bob через федерацию (a.org пересылает конверт на b.org)
await alice.send('bob:b.org', 'Боб, привет с другого сервера! Нас никто не читает.');
let inbox = await bob.receive();
console.log('Bob получил:', inbox);

// Bob → Alice (обратная федерация b.org → a.org, запускает DH-ратчет)
await bob.send('alice:a.org', 'Привет, Alice! Подтверждаю: канал forward-secret.');
inbox = await alice.receive();
console.log('Alice получила:', inbox);

// Ещё пара реплик
await alice.send('bob:b.org', 'Отлично. Давай проверим несколько сообщений подряд.');
await alice.send('bob:b.org', 'Каждое — со своим одноразовым ключом.');
inbox = await bob.receive();
console.log('Bob получил:', inbox);

line();
// Демонстрация приватности сервера: что ЛЕЖИТ в inbox на сервере b.org?
await alice.send('bob:b.org', 'СЕКРЕТ: пароль от сейфа 4815162342');
const raw = (srvB.store.data.history['bob:b.org'] || []).map((e) => e.envelope);
console.log('Что видит сервер b.org в конверте (payload зашифрован):');
console.log(JSON.stringify(raw, null, 2).slice(0, 600) + ' ...');
line();

console.log('✅ Демо федерации завершено. Открытого текста на серверах нет.');
srvA.server.close(); srvB.server.close();
