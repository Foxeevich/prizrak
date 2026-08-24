// bank-client-test.mjs — интеграция клиента Prizrak с Банком Призраков:
// TOFU-регистрация ghost-key, баланс из Банка, зачисление по IPN, подписанный
// перевод, детерминированность ghost-key (одинаков после восстановления личности).
import { PrizrakClient } from '../packages/client/src/client.js';
import crypto from 'node:crypto';

const BANK = process.env.BANK_BASE || 'http://127.0.0.1:8789';
const SECRET = process.env.PM_API_SECRET || 'test_api_secret';
const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const line = () => console.log('─'.repeat(64));

// Клиенты: init() создаёт личность локально, сеть homeserver'а не нужна для Банка.
const mk = async (n, dom) => new PrizrakClient({ name: n, userId: `${n}:${dom}`, baseUrl: 'http://127.0.0.1:1', bankBase: BANK }).init();
const alice = await mk('alice', 'a.org');
const bob = await mk('bob', 'b.org');

await bob.bankRegister(); // получатель должен быть в каталоге
// alice НЕ регистрируем явно — проверим, что перевод сам зарегистрирует её (lazy).
assert(await alice.bankBalance() === 0, 'Свежий пользователь: баланс в Банке = 0 (никаких «подарочных» призраков)');
line();

// Зачисление по подтверждённой оплате (dev-seed + IPN с подписью).
await fetch(BANK + '/api/dev/seed-payment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'R1', userId: 'alice:a.org', ghosts: 100 }) });
const ipnBody = JSON.stringify({ data: { ref_trx: 'R1' }, status: 'completed' });
const ipnSig = crypto.createHmac('sha256', SECRET).update(ipnBody).digest('hex');
await fetch(BANK + '/api/ipn', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'sha256=' + ipnSig }, body: ipnBody });
assert(await alice.bankBalance() === 100, 'После оплаты (IPN) баланс alice = 100 👻');
line();

// Подписанный перевод/подарок Alice → Bob (ghost-key Ed25519).
// alice ещё не была зарегистрирована — sendGhosts должен сам её зарегистрировать (lazy).
await alice.sendGhosts('bob:b.org', 30);
assert(await alice.bankBalance() === 70, 'После подарка у alice 70 👻 (авто-регистрация в Банке сработала)');
assert(await bob.bankBalance() === 30, 'Bob получил 30 👻');
line();

// Детерминированность ghost-key: после восстановления личности он тот же.
const restored = PrizrakClient.fromState(alice.serializeState());
assert(restored.ghostPubHex() === alice.ghostPubHex(), 'ghost-key детерминирован из личности (тот же после восстановления)');
line();

console.log('🎉 Тест интеграции клиента с Банком Призраков пройден.');
