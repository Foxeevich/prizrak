// features-1.4-test.js — профили, аватары, доп-поля, видимость телефона, «Поделиться».
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const PORT = 8991, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true, admin: 'admin' });
line();

const alice = await new PrizrakClient({ name: 'Alice', userId: 'alice:chat.org', baseUrl: URL }).init(); await alice.register('alice-pass-123');
const bob = await new PrizrakClient({ name: 'Bob', userId: 'bob:chat.org', baseUrl: URL }).init(); await bob.register('bob-pass-123');

// ── Профиль пользователя + видимость телефона ────────────────────────────────
await alice.setProfile({ displayName: 'Alice A.', bio: 'люблю крипту', birthday: '1990-03-15', phone: '+38268615606', showPhone: false, personalChannel: '@alice_channel', avatar: { mime: 'image/png', data: 'QUJD' } });
let p = await bob.getProfile('alice:chat.org');
assert(p.displayName === 'Alice A.' && p.bio === 'люблю крипту' && p.birthday === '1990-03-15', 'Профиль (имя, о себе, ДР) виден другим');
assert(p.personalChannel === '@alice_channel' && p.avatar?.data === 'QUJD', 'Личный канал и аватар отдаются');
assert(p.phone === undefined, 'Телефон скрыт, пока showPhone=false');
await alice.setProfile({ showPhone: true });
p = await bob.getProfile('alice:chat.org');
assert(p.phone === '+38268615606', 'После showPhone=true телефон виден');

// Незаполненный профиль → displayName = localpart
assert((await alice.getProfile('bob:chat.org')).displayName === 'bob', 'У Bob дефолтное имя = localpart');

// Слишком большой аватар отвергается
let tooBig = false; try { await alice.setProfile({ avatar: { mime: 'image/png', data: 'A'.repeat(700001) } }); } catch (e) { tooBig = /слишком большой/i.test(e.message); }
assert(tooBig, 'Слишком большой аватар отклонён');
line();

// ── Профиль комнаты (аватар, описание) + права ───────────────────────────────
const group = await alice.createGroup('Друзья');
await alice.setRoomProfile(group.id, { name: 'Лучшие друзья', description: 'наш чат', avatar: { mime: 'image/png', data: 'WFla' } });
let r = await bob.getRoom(group.id);
assert(r.name === 'Лучшие друзья' && r.description === 'наш чат' && r.avatar?.data === 'WFla', 'Профиль группы (имя/описание/аватар) обновлён');
let denied = false; try { await bob.setRoomProfile(group.id, { name: 'взлом' }); } catch (e) { denied = /админ/i.test(e.message); }
assert(denied, 'Менять профиль комнаты может только админ');
line();

// ── Поделиться и вступление по ссылке ────────────────────────────────────────
const sh = await alice.roomShare(group.id);
assert(sh.link.includes('prizrak.paymoney.online/?join=') && sh.deepLink === `prizrak://join/${group.id}`, 'Поделиться даёт https-ссылку на сайт + deepLink prizrak://');
await bob.joinByLink(sh.link);        // https-ссылка с сайта
r = await alice.getRoom(group.id);
assert(r.members.includes('bob:chat.org'), 'Bob вступил по https-ссылке приглашения');
// И прямая схема тоже принимается
await bob.leave(group.id); await bob.joinByLink(sh.deepLink);
assert((await alice.getRoom(group.id)).members.includes('bob:chat.org'), 'Вступление по prizrak:// тоже работает');
line();

console.log('🎉 Все тесты v1.4 (профили, аватары, поля, поделиться) пройдены.');
srv.server.close();
