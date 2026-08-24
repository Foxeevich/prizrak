// flock.mjs — тест «Стаи»: раздача адресов, защита от перечисления, автозамена.
import {
  epochFor, assignSet, packShare, readShare, makeAddressBook, EPOCH_LEN_SEC,
} from '../src/flock.js';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// Директория и её ключ.
const dirSeed = bytesToHex(ed25519.utils.randomPrivateKey());
const dirPub = bytesToHex(ed25519.getPublicKey(dirSeed));
const secret = bytesToHex(randomBytes(32));
const pool = Array.from({ length: 200 }, (_, i) => 'node-' + i);

// ── Эпохи ─────────────────────────────────────────────────────────────────────
ok(epochFor(0) === 0 && epochFor(EPOCH_LEN_SEC) === 1, 'эпохи считаются от времени');
ok(epochFor(1000) === epochFor(2000), 'внутри одной недели эпоха одна');

// ── Назначение набора ─────────────────────────────────────────────────────────
const setA = assignSet({ pool, clientId: 'alice', epoch: 5, k: 3, secret });
ok(setA.length === 3 && new Set(setA).size === 3, 'клиенту выдаётся ровно k различных адресов');
const setA2 = assignSet({ pool, clientId: 'alice', epoch: 5, k: 3, secret });
ok(setA.join() === setA2.join(), 'набор стабилен внутри эпохи (детерминирован)');
const setABob = assignSet({ pool, clientId: 'bob', epoch: 5, k: 3, secret });
ok(setABob.join() !== setA.join(), 'у другого клиента — другой набор');
const setANext = assignSet({ pool, clientId: 'alice', epoch: 6, k: 3, secret });
ok(setANext.join() !== setA.join(), 'в новой эпохе набор ротируется');

// Без секрета директории набор не воспроизвести (защита от предугадывания).
const setWrong = assignSet({ pool, clientId: 'alice', epoch: 5, k: 3, secret: bytesToHex(randomBytes(32)) });
ok(setWrong.join() !== setA.join(), 'без секрета директории чужой набор не вычислить');

// ── Защита от перечисления пула ───────────────────────────────────────────────
// Цензор поднимает 20 ложных клиентов. Проверяем, что весь пул так не собрать и
// что охват растёт медленно (мало адресов на клиента + секретное распределение).
const seen = new Set();
for (let i = 0; i < 20; i++) for (const id of assignSet({ pool, clientId: 'sybil-' + i, epoch: 5, k: 3, secret })) seen.add(id);
ok(seen.size < pool.length, '20 ложных клиентов НЕ собрали весь пул');
ok(seen.size <= 20 * 3, 'охват не больше суммы выданного (пересечения не помогают цензору)');
ok(seen.size / pool.length < 0.4, 'даже 20 клиентов видят меньше 40% пула');

// ── Доли: подпись, разбор, подделка ───────────────────────────────────────────
const node = { id: 'node-7', pub: 'ab'.repeat(32), addrs: ['relay1.example:443'], roles: ['relay'], country: 'RU', epoch: 5 };
const share = packShare(dirSeed, node);
const parsed = readShare(share, [dirPub]);
ok(parsed.ok && parsed.node.id === 'node-7' && parsed.node.country === 'RU', 'доля подписана директорией и разобрана');
ok(!readShare(share, [bytesToHex(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()))]).ok, 'доля с чужим доверенным ключом не принимается');
const tampered = new Uint8Array(share); tampered[tampered.length - 5] ^= 0xff;
ok(!readShare(tampered, [dirPub]).ok, 'подделанная доля отвергнута (подпись не сходится)');
ok(!readShare(randomBytes(80), [dirPub]).ok, 'случайный мусор — не доля');

// ── Адресная книга: приём, отжиг, автозамена, дозаправка ──────────────────────
const book = makeAddressBook({ trustedPubs: [dirPub], k: 3 });
const relays = [
  { id: 'r1', addrs: ['r1:443'], roles: ['relay'], country: 'RU', epoch: 5 },
  { id: 'r2', addrs: ['r2:443'], roles: ['relay'], country: 'RU', epoch: 5 },
  { id: 'r3', addrs: ['r3:443'], roles: ['relay'], country: 'RU', epoch: 5 },
].map((n) => packShare(dirSeed, n));
for (const s of relays) ok(book.accept(s) != null, 'доля принята в книгу');
ok(book.usable({ role: 'relay' }).length === 3, 'три пригодных реле в книге');

ok(book.next({ role: 'relay' }).id === 'r1', 'следующий пригодный — первый живой');
book.burn('r1');
ok(book.next({ role: 'relay' }).id === 'r2', 'сожгли r1 — автоматически берём r2');
ok(!book.needsRefill({ role: 'relay' }), 'пока живых хватает — дозаправка не нужна');
book.burn('r2');
ok(book.needsRefill({ role: 'relay' }), 'осталось мало живых — пора просить новые доли');
book.burn('r3');
ok(book.next({ role: 'relay' }) === null && book.needsRefill({ role: 'relay' }), 'все сожжены — нет пригодных, нужна дозаправка');

// Ротация эпохи
const b2 = makeAddressBook({ trustedPubs: [dirPub], k: 3 });
b2.accept(packShare(dirSeed, { id: 'x', addrs: ['x:443'], roles: ['relay'], country: 'RU', epoch: 5 }));
ok(!b2.staleEpoch(5 * EPOCH_LEN_SEC + 10), 'в своей эпохе набор не устарел');
ok(b2.staleEpoch(7 * EPOCH_LEN_SEC + 10), 'эпоха сменилась — пора обновить набор');

// Непроверенная доля (без доверенного ключа) в книгу не попадает
ok(makeAddressBook({ trustedPubs: [], k: 3 }).accept(share) === null, 'без доверенного ключа доля не принимается');

console.log(`\n«Стая»: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
