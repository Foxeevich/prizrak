// features-1.9-test.js — история каналов через общий ключ + ротация при бане.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const texts = (h) => h.filter((x) => !x.error).map((x) => x.text);

const PORT = 8994, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true });
line();

const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:chat.org`, baseUrl: URL }).init(); await c.register(`${n}-pass-123`); return c; };
const alice = await mk('alice'), bob = await mk('bob'), carol = await mk('carol');

const ch = await alice.createChannel('Новости');
await alice.sendToRoom(ch.id, 'post1');   // маршрутизируется в канал (общий ключ)
await alice.sendToRoom(ch.id, 'post2');

// ── Новый участник видит историю ─────────────────────────────────────────────
await alice.invite(ch.id, 'bob:chat.org');
let bh = await bob.getChannelHistory(ch.id);
assert(texts(bh).includes('post1') && texts(bh).includes('post2'), 'Новый участник (Bob) видит историю ДО вступления');

await alice.sendToRoom(ch.id, 'post3');
bh = await bob.getChannelHistory(ch.id);
assert(texts(bh).includes('post3'), 'Новый участник видит и свежие посты');
line();

// ── Ещё позже вступивший тоже видит всю историю ──────────────────────────────
await alice.invite(ch.id, 'carol:chat.org');
const chh = await carol.getChannelHistory(ch.id);
assert(['post1', 'post2', 'post3'].every((t) => texts(chh).includes(t)), 'Позже вступившая (Carol) видит ВСЮ историю');
line();

// ── Сервер хранит посты как шифртекст ────────────────────────────────────────
const raw = srv.store.data.channelPosts[ch.id][0];
assert(raw.ct && !/post1/.test(JSON.stringify(raw)), 'Сервер хранит посты канала как шифртекст');
line();

// ── Бан ротирует ключ: забаненный не читает будущее ─────────────────────────
await alice.banMember(ch.id, 'bob:chat.org'); // → ротация эпохи, ключ выдан оставшимся
await alice.sendToRoom(ch.id, 'post4');        // уже в новой эпохе
const chh2 = await carol.getChannelHistory(ch.id);
assert(texts(chh2).includes('post4'), 'Оставшийся участник (Carol) читает пост после ротации');
let bobBlocked = false; try { await bob.getChannelHistory(ch.id); } catch (e) { bobBlocked = /участник|забанен/i.test(e.message); }
assert(bobBlocked, 'Забаненный (Bob) больше не имеет доступа к каналу');
assert((await alice.getRoom(ch.id)).keyEpoch === 2, 'Эпоха ключа канала выросла после бана (ротация)');
line();

console.log('🎉 Все тесты v1.9 (история каналов, общий ключ, ротация) пройдены.');
srv.server.close();
