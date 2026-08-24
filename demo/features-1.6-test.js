// features-1.6-test.js — роли (владелец/админ/модератор), передача владельца, удаление сообщений.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const denied = async (fn, re = /прав|владелец/i) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

const PORT = 8995, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true });
line();

const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(`${n}-pass-123`); return c; };
const alice = await mk('alice'), bob = await mk('bob'), carol = await mk('carol'), dan = await mk('dan');

const group = await alice.createGroup('Команда');
for (const u of ['bob', 'carol', 'dan']) await alice.invite(group.id, `${u}:chat.org`);

// ── Роли ─────────────────────────────────────────────────────────────────────
let r = await alice.setRoomRole(group.id, 'bob:chat.org', 'admin');
assert(r.admins.includes('bob:chat.org') && r.owner === 'alice:chat.org', 'Владелец назначил Bob админом');
r = await bob.setRoomRole(group.id, 'carol:chat.org', 'moderator');
assert(r.moderators.includes('carol:chat.org'), 'Админ Bob назначил Carol модератором');
assert(await denied(() => carol.setRoomRole(group.id, 'dan:chat.org', 'admin')), 'Модератор НЕ может назначать роли');
assert(await denied(() => bob.transferRoom(group.id, 'bob:chat.org')), 'Админ НЕ может передать владельца');
line();

// ── Удаление в личном чате: полные права участникам, чужим — нет ─────────────
const dm = (await alice.send('bob:chat.org', 'привет лично')).msgId;
await bob.receive();
assert(await denied(() => carol.deleteMessage(dm)), 'Посторонний не может удалить чужое личное сообщение');
await bob.deleteMessage(dm);
assert(srv.store.findMessage(dm) === null, 'Участник удалил сообщение в личном чате (для всех)');
line();

// ── Удаление в группе: автор / модератор / админ / владелец ─────────────────
const a = (await alice.sendToRoom(group.id, 'сообщение Alice')).msgId;
assert(await denied(() => dan.deleteMessage(a), /прав/i), 'Обычный участник не может удалить чужое в группе');
await carol.deleteMessage(a); // Carol — модератор
assert(srv.store.findMessage(a) === null, 'Модератор удалил чужое сообщение (порядок в чате)');
const d = (await dan.sendToRoom(group.id, 'сообщение Dan')).msgId;
await dan.deleteMessage(d); // автор удаляет своё
assert(srv.store.findMessage(d) === null, 'Автор удалил своё сообщение в группе');
line();

// ── Передача владельца ───────────────────────────────────────────────────────
r = await alice.transferRoom(group.id, 'bob:chat.org');
assert(r.owner === 'bob:chat.org' && r.admins.includes('alice:chat.org'), 'Владелец передан Bob, Alice осталась админом');
assert(await denied(() => alice.transferRoom(group.id, 'carol:chat.org')), 'Бывший владелец больше не может передавать права');
r = await bob.setRoomRole(group.id, 'dan:chat.org', 'admin');
assert(r.admins.includes('dan:chat.org'), 'Новый владелец Bob управляет ролями');
line();

console.log('🎉 Все тесты v1.6 (роли, передача владельца, удаление) пройдены.');
srv.server.close();
