// Быстрый самотест криптослоя: X3DH + Double Ratchet + OpenPGP-подпись prekeys.
import {
  createIdentity, publishPreKeys, startSession, acceptSession,
  serializeMessage, deserializeMessage,
} from '../packages/crypto/src/index.js';

function assert(cond, msg) { if (!cond) { console.error('❌ FAIL:', msg); process.exit(1); } console.log('✅', msg); }

const alice = await createIdentity('Alice', '@alice:a.org');
const bob = await createIdentity('Bob', '@bob:b.org');
console.log('Alice fp:', alice.fingerprint, '| Bob fp:', bob.fingerprint);

const bobKeys = await publishPreKeys(bob, 5);

// Alice начинает сессию по проверенному bundle Боба
const { ratchet: aliceRatchet, handshake } = await startSession(alice, bobKeys.publicBundle);

// Alice -> Bob (первое сообщение несёт handshake)
const m1 = aliceRatchet.encrypt('Привет, Боб! Это forward-secret канал.');
const wire1 = serializeMessage(m1);

// Bob строит зеркальную сессию из handshake и расшифровывает
const bobRatchet = acceptSession(bob, bobKeys.privateState, handshake);
const p1 = bobRatchet.decrypt(deserializeMessage(wire1));
assert(p1 === 'Привет, Боб! Это forward-secret канал.', 'Bob расшифровал первое сообщение Alice');

// Bob -> Alice (запускает DH-ратчет на стороне Alice)
const m2 = bobRatchet.encrypt('Привет, Alice! Слышу тебя.');
const p2 = aliceRatchet.decrypt(deserializeMessage(serializeMessage(m2)));
assert(p2 === 'Привет, Alice! Слышу тебя.', 'Alice расшифровала ответ Bob (DH-ратчет сработал)');

// Несколько сообщений подряд в обе стороны
for (let i = 0; i < 5; i++) {
  const a = aliceRatchet.encrypt(`a#${i}`);
  assert(bobRatchet.decrypt(deserializeMessage(serializeMessage(a))) === `a#${i}`, `Bob получил a#${i}`);
  const b = bobRatchet.encrypt(`b#${i}`);
  assert(aliceRatchet.decrypt(deserializeMessage(serializeMessage(b))) === `b#${i}`, `Alice получила b#${i}`);
}

// Out-of-order: Alice шлёт 3 сообщения, Bob получает в порядке 3,1,2
const o1 = serializeMessage(aliceRatchet.encrypt('порядок-1'));
const o2 = serializeMessage(aliceRatchet.encrypt('порядок-2'));
const o3 = serializeMessage(aliceRatchet.encrypt('порядок-3'));
assert(bobRatchet.decrypt(deserializeMessage(o3)) === 'порядок-3', 'Bob получил #3 первым (skipped keys)');
assert(bobRatchet.decrypt(deserializeMessage(o1)) === 'порядок-1', 'Bob получил #1 из пропущенных');
assert(bobRatchet.decrypt(deserializeMessage(o2)) === 'порядок-2', 'Bob получил #2 из пропущенных');

// Проверка защиты от MITM: подменяем signedPreKey — verify должен упасть
try {
  const tampered = JSON.parse(JSON.stringify(bobKeys.publicBundle));
  tampered.signedPreKey = '00'.repeat(32);
  await startSession(alice, tampered);
  assert(false, 'MITM-bundle НЕ должен приниматься');
} catch (e) {
  assert(/подпись|подписан|НЕ прошла/i.test(e.message), 'Подменённый prekey-bundle отвергнут по OpenPGP-подписи');
}

console.log('\n🎉 Все криптотесты пройдены.');
