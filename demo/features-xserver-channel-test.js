// Кросс-серверные каналы: канал на сервере A, подписчик на сервере B (приглашён по
// федерации). Подписчик должен читать посты, получать ключи, ставить реакции и
// видеть инфо о комнате — всё уходит на домашний сервер канала по федерации.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const A = 8965, B = 8966, UA = `http://127.0.0.1:${A}`, UB = `http://127.0.0.1:${B}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'a.org': UA, 'b.org': UB });
const sA = await createServer({ domain: 'a.org', port: A, storePath: null, storagePaths: ['/tmp/mXA'], registrationEnabled: true });
const sB = await createServer({ domain: 'b.org', port: B, storePath: null, storagePaths: ['/tmp/mXB'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n, d, u) => { const c = await new PrizrakClient({ name: n, userId: `${n}:${d}`, baseUrl: u, bankBase: u }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };

const owner = await mk('owner', 'a.org', UA);   // канал живёт на a.org
const bob = await mk('bob', 'b.org', UB);       // подписчик на b.org

// Владелец создаёт канал и приглашает bob с ДРУГОГО сервера.
const ch = await owner.createChannel('Кросс-канал');
await owner.invite(ch.id, 'bob:b.org');

// bob видит комнату (его клиент спрашивает СВОЙ сервер b.org, тот проксирует на a.org).
const room = await bob.getRoom(ch.id);
ok(room && room.id === ch.id, 'подписчик с другого сервера получает инфо о канале (get проксируется)');
ok(room.subscribers.includes('bob:b.org'), 'bob числится подписчиком');

// Владелец постит.
const p1 = await owner.postChannel(ch.id, 'привет из другого сервера!');
ok(p1.msgId, 'владелец опубликовал пост');

// bob читает историю (history + keys проксируются на a.org, ключ выдан при инвайте/посте).
const hist = await bob.getChannelHistory(ch.id);
ok(hist.some((h) => h.text === 'привет из другого сервера!' && !h.error), 'ПОДПИСЧИК С ДРУГОГО СЕРВЕРА ЧИТАЕТ ПОСТ');

// bob ставит реакцию (проксируется на a.org).
const sum = await bob.reactChannel(ch.id, p1.msgId, '🔥');
ok(sum.counts['🔥'] === 1, 'реакция подписчика с другого сервера засчитана');

// Владелец меняет срок хранения (локально), а bob НЕ может (нет прав) — но получает
// понятную ошибку прав, а НЕ «Комната не найдена».
let permErr = '';
try { await bob.setRoomRetention(ch.id, '1w'); } catch (e) { permErr = e.message; }
ok(permErr && !/не найдена/i.test(permErr), 'у подписчика retention даёт ошибку ПРАВ, а не «Комната не найдена»');

// Владелец (на домашнем сервере) ставит ретеншн — работает.
const rr = await owner.setRoomRetention(ch.id, '1w');
ok(rr.ok, 'владелец меняет срок хранения канала');

// Самолечение ключа: если подписчику НЕ достался ключ, он просит владельца, тот
// (онлайн) авто-раздаёт — и подписчик получает ключ.
await owner.connectRealtime(() => {});
await new Promise((r) => setTimeout(r, 150));
delete sA.store.data.channelKeys[ch.id]['bob:b.org']; // симулируем сбой выдачи
bob.channelKeys = {};
await bob.requestChannelKeys(ch.id);
await new Promise((r) => setTimeout(r, 600));
ok(Object.keys(sA.store.getChannelKeys(ch.id, 'bob:b.org')).length > 0, 'по запросу подписчика владелец авто-выдал ключ');
const keys = await bob.ensureChannelKeys(ch.id);
ok(Object.keys(keys).length > 0, 'подписчик распаковал выданный ключ');
owner.disconnectRealtime();

console.log('🎉 кросс-серверные каналы + самолечение ключа — ок');
sA.server.close(); sB.server.close();
