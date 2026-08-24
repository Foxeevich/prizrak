// features-federation-queue-test.js — надёжная федерация:
//  1) сервер получателя недоступен → сообщение НЕ теряется, кладётся в очередь;
//  2) сервер вернулся → очередь доставляется (без дублей);
//  3) отправитель получает статус «дошло до сервера получателя» (✓✓);
//  4) медиа реально передаётся между серверами (подкачка блоба с origin).
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PA = 8974, PB = 8975, UA = `http://127.0.0.1:${PA}`, UB = `http://127.0.0.1:${PB}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'a.org': UA, 'b.org': UB });
const srvA = await createServer({ domain: 'a.org', port: PA, storePath: null, registrationEnabled: true });
const srvB = await createServer({ domain: 'b.org', port: PB, storePath: null, registrationEnabled: true });
line();

const mk = async (n, dom, url) => { const c = await new PrizrakClient({ name: n, userId: `${n}:${dom}`, baseUrl: url }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };
const alice = await mk('alice', 'a.org', UA);
const bob = await mk('bob', 'b.org', UB);

// Первое сообщение (B доступен) — устанавливает сессию.
await alice.send('bob:b.org', 'привет-1');
await sleep(80);
let bmsgs = await bob.receive();
assert(bmsgs.some((m) => m.kind === 'text' && m.text === 'привет-1'), 'Первое сообщение дошло (B онлайн)');
line();

// ── B «выключаем»: подменяем resolver у A на мёртвый порт ─────────────────────
srvA.cfg.resolver['b.org'] = 'http://127.0.0.1:9';
const r2 = await alice.send('bob:b.org', 'пока-ты-спал');
assert(r2.queued === true && r2.delivered === false, 'Сервер получателя недоступен → сообщение в очереди (queued)');
assert(srvA.store.outboxAll().length === 1, 'Сообщение лежит в очереди отправителя (не потеряно)');
bmsgs = await bob.receive();
assert(!bmsgs.some((m) => m.text === 'пока-ты-спал'), 'Пока B «недоступен» — сообщение НЕ доставлено');
line();

// ── B «вернулся»: восстанавливаем resolver и дренажим очередь ─────────────────
srvA.cfg.resolver['b.org'] = UB;
await srvA.drainOutbox();
assert(srvA.store.outboxAll().length === 0, 'После возврата сервера очередь доставлена и пуста');
bmsgs = await bob.receive();
assert(bmsgs.some((m) => m.text === 'пока-ты-спал'), 'Отложенное сообщение догналось при возврате B');

// Дубля быть не должно даже при повторном дренаже.
await srvA.drainOutbox();
const cnt = (await srvB.store.historySince('bob:b.org', 0)).filter((e) => e.envelope?.msgId === r2.msgId).length;
assert(cnt === 1, 'Повторная доставка не создаёт дубликат (антидубль по msgId)');

// Отправитель получил статус «дошло до сервера получателя» (✓✓).
await sleep(60);
const aevents = await alice.receive();
assert(aevents.some((e) => e.kind === 'receipt' && e.status === 'server' && (e.msgIds || []).includes(r2.msgId)), 'Отправителю пришёл статus ✓✓ (server) по отложенному сообщению');
line();

// ── Федеративное медиа: блоб на A, Bob (на B) скачивает через свой сервер ─────
const bytes = new Uint8Array(90 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 3) & 0xff;
await alice.sendAttachment('bob:b.org', bytes, { filename: 'big.bin', mime: 'application/octet-stream' });
await sleep(80);
const att = (await bob.receive()).find((m) => m.kind === 'attachment')?.attachment;
assert(att && att.mediaId && att._origin === 'a.org', 'Bob получил вложение с origin=a.org');
const got = await bob.fetchAttachment(att); // B подтянет блоб с A и отдаст Bob
assert(got && got.length === bytes.length && got[100] === bytes[100], 'Bob скачал файл — блоб передан между серверами');
line();

console.log('🎉 Тест надёжной федерации (очередь + догон + медиа) пройден.');
srvA.server.close(); srvB.server.close();
try { srvA.relay?.server.close(); srvB.relay?.server.close(); } catch {}
