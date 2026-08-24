// web-test.mjs — тест PHP-бэкенда prizrak.paymoney.online (каталог + Банк Призраков + IPN).
// Требует запущенный `php -S 127.0.0.1:PORT` (см. demo/web-test.sh).
import { ed25519 } from '@noble/curves/ed25519';
import crypto from 'node:crypto';

const BASE = process.env.WEB_BASE || 'http://127.0.0.1:8788';
const WEBHOOK = process.env.PM_API_SECRET || 'test_api_secret'; // IPN подписан тем же Client Secret (API Secret)
const assert = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const hex = (b) => Buffer.from(b).toString('hex');
const mkKey = () => { const priv = ed25519.utils.randomPrivateKey(); return { priv, pub: hex(ed25519.getPublicKey(priv)) }; };
const jget = async (p) => (await fetch(BASE + p)).json();
const jpost = async (p, o) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }));
async function signed(p, obj, priv) {
  const body = JSON.stringify({ ...obj, ts: Math.floor(Date.now() / 1000), nonce: hex(crypto.randomBytes(8)) });
  const sig = hex(ed25519.sign(new TextEncoder().encode(body), priv));
  return fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sig': sig }, body });
}

const alice = mkKey(), bob = mkKey();
const AID = 'alice:a.org', BID = 'bob:b.org';

// ── Каталог ──────────────────────────────────────────────────────────────────
assert((await (await jpost('/api/directory/register', { userId: AID, ghostPubKey: alice.pub, displayName: 'Alice', listed: true })).json()).ok, 'Регистрация Alice в каталоге');
await jpost('/api/directory/register', { userId: BID, ghostPubKey: bob.pub, displayName: 'Bob', listed: true });
assert((await jget('/api/directory/lookup?userId=' + encodeURIComponent(AID))).domain === 'a.org', 'Lookup находит Alice и её сервер');
assert((await jget('/api/directory/search?q=ali')).results.some((r) => r.userId === AID), 'Поиск по каталогу находит Alice');
const contacts = (await (await jpost('/api/directory/contacts', { userIds: [AID, 'ghost:none.org'] })).json()).found;
assert(contacts.length === 1 && contacts[0].userId === AID, 'Проверка контактов: возвращены только зарегистрированные');

// ── TOFU: чужой не может переприсвоить имя без подписи ───────────────────────
const attacker = mkKey();
const reRes = await jpost('/api/directory/register', { userId: AID, ghostPubKey: attacker.pub, displayName: 'Fake' });
assert(reRes.status === 401, 'Перепривязка имени без подписи текущим ключом отклонена (анти-угон)');

// ── Банк Призраков: начисление по IPN, баланс, перевод ───────────────────────
await jpost('/api/dev/seed-payment', { ref: 'R1', userId: AID, ghosts: 100 });
const ipnBody = JSON.stringify({ data: { ref_trx: 'R1' }, status: 'completed' });
const ipnSig = crypto.createHmac('sha256', WEBHOOK).update(ipnBody).digest('hex');
await fetch(BASE + '/api/ipn', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'sha256=' + ipnSig }, body: ipnBody });
assert((await jget('/api/ghosts/balance?userId=' + encodeURIComponent(AID))).balance === 100, 'После оплаты (IPN) Alice получила 100 👻');

// повторный IPN не удваивает (идемпотентность)
await fetch(BASE + '/api/ipn', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'sha256=' + ipnSig }, body: ipnBody });
assert((await jget('/api/ghosts/balance?userId=' + encodeURIComponent(AID))).balance === 100, 'Повторный IPN не удваивает баланс (идемпотентно)');

// IPN с плохой подписью отвергается
const bad = await fetch(BASE + '/api/ipn', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'sha256=deadbeef' }, body: ipnBody });
assert(bad.status === 401, 'IPN с неверной подписью отвергнут');

// перевод Alice → Bob (подпись Ed25519)
const t = await signed('/api/ghosts/transfer', { userId: AID, to: BID, amount: 30 }, alice.priv);
assert(t.status === 200, 'Перевод 30 👻 Alice → Bob подписан и принят');
assert((await jget('/api/ghosts/balance?userId=' + encodeURIComponent(AID))).balance === 70, 'У Alice осталось 70 👻');
assert((await jget('/api/ghosts/balance?userId=' + encodeURIComponent(BID))).balance === 30, 'Bob получил 30 👻');

// подделка подписи перевода отвергается
const forged = await fetch(BASE + '/api/ghosts/transfer', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sig': hex(crypto.randomBytes(64)) }, body: JSON.stringify({ userId: AID, to: BID, amount: 999, ts: Math.floor(Date.now() / 1000), nonce: 'x' }) });
assert(forged.status === 401, 'Перевод с поддельной подписью отвергнут (нельзя украсть чужие 👻)');

// ── Обновления ────────────────────────────────────────────────────────────────
const upd = await jget('/api/update/latest?platform=mac');
assert(/^\d+\.\d+\.\d+$/.test(upd.version) && upd.download, 'Эндпоинт обновлений отдаёт версию и ссылку');

console.log('\n🎉 Все тесты PHP-бэкенда (каталог, Банк Призраков, IPN, подписи) пройдены.');
