// Реакции в личных чатах: эмодзи-реакция и платная реакция (донат) едут по
// E2E-каналу как служебные сообщения type='reaction'. Сервер их не читает —
// только пересылает шифртекст, поэтому доработок сервера не требуется.
// (Реальный перевод призраков идёт через отдельный Банк (PHP) и здесь не
// проверяется — проверяем доставку и декодирование самой реакции.)
import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const P = 8994, U = `http://127.0.0.1:${P}`;
const s = await createServer({ domain: 'r.org', port: P, storePath: null, storagePaths: ['/tmp/mDmRx'], registrationEnabled: true });
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exit(1); } console.log('✅', m); };
const mk = async (n) => { const c = await new PrizrakClient({ name: n, userId: `${n}:r.org`, baseUrl: U, bankBase: U }).init(); await c.register(`${n}-pass-123`); await c.serverConfig(); return c; };

const alice = await mk('alice');
const bob = await mk('bob');

// Алиса пишет Бобу.
const sent = await alice.send('bob:r.org', 'привет, Боб');
const bi = await bob.receive();
ok(bi.some((m) => m.kind === 'text' && m.text === 'привет, Боб'), 'Боб получил сообщение');
const msgId = sent.msgId;

// Боб ставит эмодзи-реакцию → Алиса её получает.
await bob.reactDirect('alice:r.org', msgId, '❤️', true);
let ar = await alice.receive();
const rx = ar.find((m) => m.kind === 'reaction' && m.target === msgId);
ok(rx && rx.emoji === '❤️' && rx.on === true, 'Алиса получила реакцию ❤️ от Боба (on=true)');

// Боб снимает реакцию → приходит on=false.
await bob.reactDirect('alice:r.org', msgId, '❤️', false);
ar = await alice.receive();
const off = ar.find((m) => m.kind === 'reaction' && m.target === msgId && m.emoji === '❤️');
ok(off && off.on === false, 'снятие реакции доставлено (on=false)');

// Платная реакция: служебное сообщение с paid>0 доставляется и декодируется
// (перевод призраков — забота Банка, тут проверяем транспорт метки доната).
await bob._sendWrapped('alice:r.org', { t: 'reaction', target: msgId, paid: 5 });
ar = await alice.receive();
const paid = ar.find((m) => m.kind === 'reaction' && m.target === msgId && m.paid === 5);
ok(paid, 'Алиса получила платную реакцию (paid=5)');

// Реакции переживают офлайн: складываются на сервере и отдаются позже.
const sent2 = await alice.send('bob:r.org', 'второе');
await bob.receive();
await bob.reactDirect('alice:r.org', sent2.msgId, '🔥', true);
await new Promise((r) => setTimeout(r, 50));
ar = await alice.receive();
ok(ar.some((m) => m.kind === 'reaction' && m.target === sent2.msgId && m.emoji === '🔥'), 'реакция на второе сообщение доставлена');

console.log('🎉 реакции и донат в личных чатах — ок');
s.server.close();
