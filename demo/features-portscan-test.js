// C2: авто-скан порта клиентом. По «голому» адресу (host без порта) клиент
// находит рабочий порт из списка кандидатов и подключается. Явный порт — как есть.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };

// Сервер на нестандартном (для нас) порту 8801 — он в списке кандидатов клиента.
const PORT = 8801;
const s = await createServer({ domain: '127.0.0.1', port: PORT, storePath: null, storagePaths: ['/tmp/mScan'], registrationEnabled: true });

// Голый адрес без порта → клиент должен сам найти рабочий порт (8801 в списке).
const resolved = await PrizrakClient.resolveBaseUrl('127.0.0.1');
ok(resolved === `http://127.0.0.1:${PORT}`, `авто-скан нашёл рабочий порт: ${resolved}`);

// Явный порт — используется как есть (без сканирования).
ok((await PrizrakClient.resolveBaseUrl('http://127.0.0.1:8801')) === 'http://127.0.0.1:8801', 'явный порт сохраняется');
ok((await PrizrakClient.resolveBaseUrl('127.0.0.1:8801')) === 'http://127.0.0.1:8801', 'host:port без схемы → http://host:port');

// По найденному адресу реально работает регистрация/вход.
const c = await new PrizrakClient({ name: 'zoe', userId: 'zoe:127.0.0.1', baseUrl: resolved, bankBase: resolved }).init();
const d = await c.register('zoe-pass-123');
ok(d && d.token, 'регистрация по авто-найденному адресу работает');

// Недоступный хост → возвращаем первый кандидат (осмысленная ошибка при обращении).
const dead = await PrizrakClient.resolveBaseUrl('10.255.255.1');
ok(typeof dead === 'string' && dead.startsWith('https://10.255.255.1:443'), 'мёртвый хост → первый кандидат (443)');

console.log('🎉 авто-скан порта (C2) — ок');
s.server.close();
