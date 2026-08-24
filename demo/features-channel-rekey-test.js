// Владелец потерял ключ текущей эпохи канала (например, ключ был выдан на прежнюю
// личность и не расшифровывается). Публикация должна авто-перевыпустить ключ и
// пройти — без ручной ротации.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8996, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'k.org', port: P, storePath: null, storagePaths: ['/tmp/mKk'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:k.org`, baseUrl: U, bankBase: U }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };

const owner = await mk('owner');
const ch = await owner.createChannel('Тест');

// Первый пост в норме.
const p1 = await owner.postChannel(ch.id, 'привет');
ok(p1.msgId, 'обычная публикация работает');

// Симулируем ПОТЕРЮ ключа: чистим локальные ключи и портим серверный grant так,
// что расшифровать его нельзя (как ключ, выданный на старую личность).
owner.channelKeys[ch.id] = {};
s.store.data.channelKeys[ch.id] = { 'owner:k.org': { '1': 'НЕ_РАСШИФРОВЫВАЕТСЯ' } };
s.store.data.channelSecrets[ch.id] = {}; // и серверный ключ тоже недоступен (полная потеря)

// Публикация должна авто-перевыпустить ключ (новая эпоха) и пройти.
const p2 = await owner.postChannel(ch.id, 'после потери ключа');
ok(p2.msgId, 'публикация прошла после авто-перевыпуска ключа');

const room = await owner.getRoom(ch.id);
ok(room.keyEpoch >= 2, 'эпоха ключа увеличилась (ключ перевыпущен)');

// Новый пост читается свежим ключом.
const hist = await owner.getChannelHistory(ch.id);
const got = hist.find((h) => h.text === 'после потери ключа');
ok(got && !got.error, 'новый пост расшифровывается свежим ключом');

// Второй пост подряд НЕ должен снова ротировать (ключ уже есть локально).
const before = (await owner.getRoom(ch.id)).keyEpoch;
await owner.postChannel(ch.id, 'ещё пост');
const after = (await owner.getRoom(ch.id)).keyEpoch;
ok(before === after, 'повторная публикация не ротирует ключ лишний раз');

// Подписчик, которому при инвайте НЕ достался ключ (битый бандл), всё равно
// начинает читать после ближайшего поста владельца (ключ раздаётся перед фанаутом).
const bob = await mk('bob');
await owner.invite(ch.id, 'bob:k.org');
delete s.store.data.channelKeys[ch.id]['bob:k.org']; // стираем гранты bob
bob.channelKeys = {};
ok(Object.keys(s.store.getChannelKeys(ch.id, 'bob:k.org')).length === 0, 'у bob нет ключей (симуляция сбоя инвайта)');
await owner.postChannel(ch.id, 'пост для bob');
ok(Object.keys(s.store.getChannelKeys(ch.id, 'bob:k.org')).length > 0, 'после поста владельца bob получил ключ');
const bh = await bob.getChannelHistory(ch.id);
ok(bh.some((p) => p.text === 'пост для bob' && !p.error), 'bob читает пост после раздачи ключа');

console.log('🎉 авто-перевыпуск ключа канала + доставка подписчикам — ок');
s.server.close();
