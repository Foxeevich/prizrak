// После явного релогина (ввод пароля) свежий клиент перенимает ратчет-сессии
// из локального состояния — прошлые сообщения собеседника остаются читаемыми,
// нет «нет сессии».
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8991, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'x.org', port: P, storePath: null, storagePaths: ['/tmp/mReX'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:x.org`, baseUrl: U }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };

const alice = await mk('alice');
const bob = await mk('bob');

// Боб пишет Алисе (устанавливается сессия), Алиса читает.
await bob.send('alice:x.org', 'привет-1');
await new Promise(r => setTimeout(r, 150));
let ev = await alice.receive();
ok(ev.some(e => e.kind === 'text' && e.text === 'привет-1'), 'первое сообщение расшифровано (сессия установлена)');

// Снимок состояния Алисы (как в локальном файле) — до релогина.
const snapshot = alice.serializeState();
ok(Object.keys(snapshot.sessions || {}).length > 0, 'в состоянии есть ратчет-сессия с бобом');

// Боб шлёт ещё одно ПОКА Алиса «в старой сессии».
await bob.send('alice:x.org', 'привет-2');
await new Promise(r => setTimeout(r, 150));

// РЕЛОГИН Алисы: свежий клиент, пустые сессии.
const alice2 = await new PrizrakClient({ name: 'alice', userId: 'alice:x.org', baseUrl: U }).init();
await alice2.login('alice-pass-123');
await alice2.serverConfig();

// Без adopt — было бы «нет сессии». Перенимаем сессии из снапшота.
const adopted = alice2.adoptSessionsFrom(snapshot);
ok(adopted === true, 'сессии перенятны при совпадении userId');
ok(alice2.sessions.has('bob:x.org'), 'ратчет-сессия с бобом восстановлена после релогина');

// Чужое состояние — игнорируется.
ok(alice2.adoptSessionsFrom({ userId: 'someone:else', sessions: {} }) === false, 'чужое состояние не перенимается');

ev = await alice2.receive();
const two = ev.find(e => e.kind === 'text' && e.text === 'привет-2');
const noSess = ev.find(e => e.error === 'нет сессии');
ok(two && !noSess, 'сообщение «привет-2» расшифровано после релогина, без «нет сессии»');

console.log('🎉 релогин сохраняет сессии — ок');
s.server.close();
