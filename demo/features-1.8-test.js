// features-1.8-test.js — верификация контактов (safety-number) и «поделиться контактом».
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';

const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));
const PORT = 8993, URL = `http://127.0.0.1:${PORT}`;
process.env.PRIZRAK_RESOLVER = JSON.stringify({ 'chat.org': URL });
const srv = await createServer({ domain: 'chat.org', port: PORT, storePath: null, registrationEnabled: true, inviteBase: 'https://prizrak.paymoney.online' });
line();

const alice = await new PrizrakClient({ name: 'Alice', userId: 'alice:chat.org', baseUrl: URL }).init(); await alice.register('alice-pass-123');
const bob = await new PrizrakClient({ name: 'Bob', userId: 'bob:chat.org', baseUrl: URL }).init(); await bob.register('bob-pass-123');

// ── Отпечаток собеседника совпадает с его собственным ────────────────────────
const sn = await alice.getSafetyNumber('bob:chat.org');
assert(sn.fingerprint === bob.identity.fingerprint, 'safety-number Bob у Alice = собственный safety-number Bob');
const self = await alice.getSafetyNumber('alice:chat.org');
assert(self.self && self.fingerprint === alice.identity.fingerprint, 'Свой safety-number помечен как self');
line();

// ── Отметка «проверен» и статусы ─────────────────────────────────────────────
assert((await alice.verificationStatus('bob:chat.org')).status === 'unverified', 'До проверки статус unverified');
await alice.markVerified('bob:chat.org');
assert((await alice.verificationStatus('bob:chat.org')).status === 'verified', 'После markVerified статус verified');
// Симуляция подмены ключа: сохранённый отпечаток не совпадает с текущим
alice.verified['bob:chat.org'] = 'deadbeefdeadbeefdeadbeefdeadbeef';
assert((await alice.verificationStatus('bob:chat.org')).status === 'changed', 'Смена ключа собеседника → статус changed (тревога MITM)');
alice.unverify('bob:chat.org');
assert((await alice.verificationStatus('bob:chat.org')).status === 'unverified', 'unverify сбрасывает отметку');
line();

// ── Поделиться контактом ─────────────────────────────────────────────────────
const sh = await alice.contactShare('bob:chat.org');
assert(sh.link === 'https://prizrak.paymoney.online/?dm=bob%3Achat.org', 'Ссылка на контакт ведёт на сайт (?dm=)');
assert(sh.deepLink === 'prizrak://dm/bob:chat.org', 'deepLink контакта prizrak://dm/<user>');
const mine = await alice.contactShare();
assert(mine.userId === 'alice:chat.org', 'Без аргумента — ссылка на свой контакт');
line();

console.log('🎉 Все тесты v1.8 (верификация, поделиться контактом) пройдены.');
srv.server.close();
