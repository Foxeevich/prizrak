// features-invite-test.js — приглашение в канал/группу ДОХОДИТ до приглашённого:
// событие 'invited' с публичным видом комнаты (durable для офлайн + федерация).
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const texts = (h) => h.filter((x) => !x.error).map((x) => x.text);

const PA = 8992, PB = 8993, UA = `http://127.0.0.1:${PA}`, UB = `http://127.0.0.1:${PB}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'a.org': UA, 'b.org': UB });
const srvA = await createServer({ domain: 'a.org', port: PA, storePath: null, registrationEnabled: true });
const srvB = await createServer({ domain: 'b.org', port: PB, storePath: null, registrationEnabled: true });
line();

const mk = async (n, dom, url) => { const c = await new PrizrakClient({ name: n, userId: `${n}:${dom}`, baseUrl: url }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };
const alice = await mk('alice', 'a.org', UA);   // владелец канала на сервере A
const bob = await mk('bob', 'a.org', UA);       // тот же сервер (локальный invite)
const carol = await mk('carol', 'b.org', UB);   // ДРУГОЙ сервер (федеративный invite)

const ch = await alice.createChannel('Новости');
await alice.sendToRoom(ch.id, 'post1');

// ── Локальный invite: Bob (офлайн) при следующем inbox получает 'invited' ─────
await alice.invite(ch.id, 'bob:a.org');
const bEvents = await bob.receive();
const bInv = bEvents.find((e) => e.kind === 'invited' && e.room?.id === ch.id);
assert(!!bInv, 'Bob (тот же сервер) получил событие invited с комнатой');
assert(bInv.room.name === 'Новости' && bInv.room.type === 'channel', 'В invite пришли имя и тип канала');
const bh = await bob.getChannelHistory(ch.id);
assert(texts(bh).includes('post1'), 'Bob по приглашению видит канал и его историю (ключ выдан)');
line();

// ── Федеративный invite: Carol на сервере B получает приглашение с сервера A ──
// (само УВЕДОМЛЕНИЕ федеративно доходит; чтение канала, ХОСТЯЩЕГОСЯ на чужом
//  сервере, — отдельная большая фича федерации и здесь НЕ проверяется.)
await alice.invite(ch.id, 'carol:b.org');
await sleep(150); // межсерверный HTTP
const cEvents = await carol.receive();
const cInv = cEvents.find((e) => e.kind === 'invited' && e.room?.id === ch.id);
assert(!!cInv, 'Carol (ДРУГОЙ сервер) получила invited по федерации');
assert(cInv.room.name === 'Новости', 'В федеративном invite тоже пришли данные комнаты');
line();

// ── Повторный invite не плодит дубликаты в очереди ───────────────────────────
await alice.invite(ch.id, 'bob:a.org');
await alice.invite(ch.id, 'bob:a.org');
const dup = (await bob.receive()).filter((e) => e.kind === 'invited' && e.room?.id === ch.id);
assert(dup.length <= 1, 'Повторные приглашения дедуплицируются (не спамят)');
line();

console.log('🎉 Тест приглашений (invited: локально + федерация + дедуп) пройден.');
srvA.server.close(); srvB.server.close();
try { srvA.relay?.server.close(); srvB.relay?.server.close(); } catch {}
