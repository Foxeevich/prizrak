// features-1.7-test.js — кик/бан с иерархией рангов, бан-лист, режим «только чтение».
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const denied = async (fn, re = /прав|забанен|владелец|нельзя/i) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

const PORT = 8997, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true });
line();

const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(`${n}-pass-123`); return c; };
const alice = await mk('alice'), bob = await mk('bob'), carol = await mk('carol'), dan = await mk('dan');
const group = await alice.createGroup('Отряд');
for (const u of ['bob', 'carol', 'dan']) await alice.invite(group.id, `${u}:chat.org`);
await alice.setRoomRole(group.id, 'bob:chat.org', 'admin');
await alice.setRoomRole(group.id, 'carol:chat.org', 'moderator');

// ── Иерархия прав кик/бан ────────────────────────────────────────────────────
assert(await denied(() => dan.kickMember(group.id, 'carol:chat.org')), 'Обычный участник не может кикать');
assert(await denied(() => carol.kickMember(group.id, 'bob:chat.org')), 'Модератор не может кикнуть админа (ранг не выше)');
assert(await denied(() => bob.banMember(group.id, 'alice:chat.org')), 'Владельца нельзя забанить');

let r = await carol.kickMember(group.id, 'dan:chat.org');
assert(!r.members.includes('dan:chat.org'), 'Модератор кикнул обычного участника');
line();

// ── Бан и бан-лист ───────────────────────────────────────────────────────────
r = await bob.banMember(group.id, 'carol:chat.org');
assert(r.banned.includes('carol:chat.org') && !r.moderators.includes('carol:chat.org'), 'Админ забанил модератора');
assert(await denied(() => carol.join(group.id), /забанен/i), 'Забаненный не может вернуться');
assert(await denied(() => bob.invite(group.id, 'carol:chat.org'), /забанен/i), 'Забаненного нельзя пригласить');
r = await alice.unbanMember(group.id, 'carol:chat.org');
assert(!r.banned.includes('carol:chat.org'), 'Владелец разбанил');
await carol.join(group.id);
assert((await alice.getRoom(group.id)).members.includes('carol:chat.org'), 'После разбана участник вернулся');
line();

// ── Режим «только чтение» ────────────────────────────────────────────────────
await bob.invite(group.id, 'dan:chat.org'); // вернём Dan обычным участником
await alice.setRoomReadOnly(group.id, true);
assert((await alice.getRoom(group.id)).readOnly === true, 'Режим «только чтение» включён');
assert(await denied(() => dan.sendToRoom(group.id, 'можно?'), /нельзя писать/i), 'В read-only обычный участник не может писать');
await alice.sendToRoom(group.id, 'объявление от владельца');
assert(true, 'Владелец/админ пишет в read-only');
await alice.setRoomReadOnly(group.id, false);
await dan.sendToRoom(group.id, 'теперь можно');
assert(true, 'После выключения read-only участник снова пишет');
line();

console.log('🎉 Все тесты v1.7 (кик/бан, бан-лист, read-only) пройдены.');
srv.server.close();
