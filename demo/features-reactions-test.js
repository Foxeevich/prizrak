// Реакции в каналах: бесплатные (тоггл, счётчики), платные (донат 👻),
// настройки (вкл/выкл), а также отключение реакций.
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8994, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'r.org', port: P, storePath: null, storagePaths: ['/tmp/mRx'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:r.org`, baseUrl: U, bankBase: U }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };

const owner = await mk('owner');   // создатель канала
const sub = await mk('sub');       // подписчик

// Канал + подписчик.
const ch = await owner.createChannel('Новости');
await owner.invite(ch.id, 'sub:r.org');
const post = await owner.postChannel(ch.id, 'Первый пост!');
ok(post.msgId, 'пост опубликован');

// По умолчанию реакции включены, платные — выключены.
let room = await owner.getRoom(ch.id);
ok(room.reactionsEnabled === true, 'реакции включены по умолчанию');
ok(room.paidReactionsEnabled === false, 'платные реакции выключены по умолчанию');

// Подписчик ставит 👍.
let sum = await sub.reactChannel(ch.id, post.msgId, '👍');
ok(sum.counts['👍'] === 1 && sum.mine.includes('👍'), 'подписчик поставил 👍 (счётчик=1, mine)');

// Владелец тоже ставит 👍 → счётчик 2.
sum = await owner.reactChannel(ch.id, post.msgId, '👍');
ok(sum.counts['👍'] === 2, 'второй 👍 → счётчик=2');

// Подписчик снимает свою реакцию → счётчик 1.
sum = await sub.reactChannel(ch.id, post.msgId, '👍');
ok(sum.counts['👍'] === 1 && !sum.mine.includes('👍'), 'снятие реакции → счётчик=1, mine пусто');

// Сводка по каналу для владельца.
const all = await owner.channelReactions(ch.id);
ok(all[post.msgId] && all[post.msgId].counts['👍'] === 1, 'сводка реакций по каналу отдаётся');

// Платная реакция выключена → ошибка (проверяем серверный эндпоинт напрямую,
// минуя банковский перевод: ownerId === сам автор → sendGhosts не вызывается).
let threw = false; try { await owner.reactPaidChannel(ch.id, post.msgId, 5, 'owner:r.org'); } catch { threw = true; }
ok(threw, 'платная реакция отклонена, пока выключена');

// Владелец включает платные реакции.
room = await owner.setRoomReactions(ch.id, { paidReactionsEnabled: true });
ok(room.paidReactionsEnabled === true, 'владелец включил платные реакции');

// Запись платной реакции (донат 👻 через Банк тестируется отдельно; здесь автор
// «донатит» на свой пост — банковский перевод пропускается, проверяем метаданные).
sum = await owner.reactPaidChannel(ch.id, post.msgId, 10, 'owner:r.org');
ok(sum.paid === 10 && sum.myPaid === 10, 'платная реакция записана (paid=10)');
sum = await owner.reactPaidChannel(ch.id, post.msgId, 5, 'owner:r.org');
ok(sum.paid === 15, 'платные реакции суммируются (paid=15)');

// Лимит РАЗНЫХ реакций на публикацию.
const post2 = await owner.postChannel(ch.id, 'Второй пост');
room = await owner.setRoomReactions(ch.id, { maxReactions: 2 });
ok(room.maxReactions === 2, 'сохранён лимит реакций на публикацию (2)');
await owner.reactChannel(ch.id, post2.msgId, '👍');
await sub.reactChannel(ch.id, post2.msgId, '❤️');
let limited = false; try { await owner.reactChannel(ch.id, post2.msgId, '🔥'); } catch { limited = true; }
ok(limited, 'третья РАЗНАЯ реакция отклонена по лимиту');
// но снять уже поставленную можно
const s2 = await owner.reactChannel(ch.id, post2.msgId, '👍');
ok(!s2.mine.includes('👍'), 'свою реакцию снять можно даже при достигнутом лимите');

// Набор эмодзи реакций сохраняется.
room = await owner.setRoomReactions(ch.id, { reactionEmojis: ['👍', '🔥', '🎉'] });
ok(JSON.stringify(room.reactionEmojis) === JSON.stringify(['👍', '🔥', '🎉']), 'набор эмодзи реакций сохранён');

// Отключаем реакции полностью → нельзя реагировать.
await owner.setRoomReactions(ch.id, { reactionsEnabled: false });
threw = false; try { await sub.reactChannel(ch.id, post.msgId, '❤️'); } catch { threw = true; }
ok(threw, 'при отключённых реакциях реагировать нельзя');

// ── Реакции в ГРУППАХ (как в каналах, включая платные) ──────────────────────
const gr = await owner.createGroup('Тусовка');
await owner.invite(gr.id, 'sub:r.org');
const gm = await owner.sendToRoom(gr.id, 'сообщение в группе');
ok(gm.msgId, 'сообщение в группе отправлено');
let gs = await sub.reactChannel(gr.id, gm.msgId, '🔥');
ok(gs.counts['🔥'] === 1, 'реакция в группе работает (🔥=1)');
const groom = await owner.setRoomReactions(gr.id, { paidReactionsEnabled: true });
ok(groom.paidReactionsEnabled === true, 'платные реакции включаются и в группе');
gs = await owner.reactPaidChannel(gr.id, gm.msgId, 3, 'owner:r.org');
ok(gs.paid === 3, 'платная реакция в группе записана (paid=3)');

console.log('🎉 реакции в каналах и группах — ок');
s.server.close();
