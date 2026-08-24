// store-sqlite.mjs — хранилище на SQLite: тот же API, индексы, WAL, автоперенос store.json.
import { Store } from '../src/store.js';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const dir = mkdtempSync(join(tmpdir(), 'st-'));

try {
  // ── Базовые операции ──
  const s = new Store(join(dir, 'store.json'));
  s.createAccount('fox:x.org', { pw: 'h', isAdmin: true });
  ok(s.hasAccount('fox:x.org') && s.getAccount('fox:x.org').isAdmin === true, 'аккаунт + isAdmin');
  ok(s.listAdmins().join() === 'fox:x.org' && s.countAccounts() === 1, 'listAdmins + countAccounts');
  s.setAdmin('fox:x.org', false); ok(s.getAccount('fox:x.org').isAdmin === false, 'setAdmin снимает флаг');
  s.setAdmin('fox:x.org', true);
  s.setPassword('fox:x.org', { pw: 'h2' }); ok(s.getAccount('fox:x.org').pw === 'h2', 'setPassword мержит поля');
  s.putToken('t1', 'fox:x.org'); ok(s.getToken('t1')?.userId === 'fox:x.org', 'токен'); s.deleteToken('t1'); ok(!s.getToken('t1'), 'deleteToken');

  // ── Устройства (MD1/MD7 лимит) ──
  for (let i = 0; i < 12; i++) s.putDevice('fox:x.org', 'd' + i, { pub: i });
  ok(s.getDevices('fox:x.org').length === 10, 'лимит 10 активных устройств (эвикт старых)');
  ok(s.revokeDevice('fox:x.org', 'd11'), 'revokeDevice'); ok(!s.getDevice('fox:x.org', 'd11'), 'отозванное устройство не отдаётся');

  // ── История + курсор seq + адресация на устройство ──
  const e1 = s.appendHistory('bob:x.org', { roomId: null, envelope: { from: 'fox:x.org', msgId: 'm1' } });
  const e2 = s.appendHistory('bob:x.org', { roomId: null, envelope: { from: 'fox:x.org', msgId: 'm2', toDevice: 'devA' } });
  ok(e2.seq === e1.seq + 1, 'seq монотонно растёт');
  ok(s.historySince('bob:x.org', 0).length === 2 && s.historySince('bob:x.org', 0, 'devB').length === 1, 'адресация toDevice в historySince');
  ok(s.hasMessage('bob:x.org', 'm2', 'devA') && !s.hasMessage('bob:x.org', 'm2', null), 'hasMessage учитывает toDevice');
  ok(s.dmPeers('bob:x.org')[0]?.peer === 'fox:x.org', 'dmPeers по метаданным');
  ok(s.findMessage('m1')?.msgId === 'm1', 'findMessage');
  ok(s.deleteMessage('m1').join() === 'bob:x.org', 'deleteMessage возвращает затронутых');
  // prune: удалить старше 1с
  s.appendHistory('carol:x.org', { roomId: null, envelope: { msgId: 'old' } });
  const removed = s.pruneHistory((e) => 0); // 0 сек → всё старьё под нож
  ok(removed >= 1, 'pruneHistory удаляет протухшее');

  // ── Кошелёк ──
  ok(s.credit('fox:x.org', 100, { kind: 'grant' }) === 100 && s.debit('fox:x.org', 30, { kind: 'send' }) === 70, 'credit/debit');
  let threw = false; try { s.debit('fox:x.org', 9999); } catch { threw = true; }
  ok(threw, 'debit при нехватке бросает');
  ok(s.wallet('fox:x.org').tx.length === 2, 'история кошелька (tx)');

  // ── Комнаты + членство ──
  s.createRoom({ id: 'r1', members: ['fox:x.org'], subscribers: ['bob:x.org'] });
  ok(s.roomsForUser('bob:x.org').map((r) => r.id).join() === 'r1', 'roomsForUser по подписчикам');
  s.saveRoom({ id: 'r1', members: ['fox:x.org'], subscribers: [] });
  ok(s.roomsForUser('bob:x.org').length === 0, 'saveRoom обновляет членство (bob отписан)');

  // ── Очереди с дедупом ──
  s.pushInvite('bob:x.org', { id: 'r1', from: 'fox:x.org' }); s.pushInvite('bob:x.org', { id: 'r1', from: 'fox:x.org' });
  ok(s.drainInvites('bob:x.org').length === 1 && s.drainInvites('bob:x.org').length === 0, 'invite дедуп + дренаж');
  s.pushReceipt('fox:x.org', { msgId: 'x', kind: 'read' }); ok(s.drainReceipts('fox:x.org').length === 1, 'receipts');

  // ── Каналы + реакции ──
  s.setChannelSecret('r1', 3, 'deadbeef'); ok(s.getChannelSecrets('r1')['3'] === 'deadbeef', 'секрет канала по эпохе');
  s.grantChannelKeys('r1', 'bob:x.org', [{ epoch: 3, wrapped: 'W' }]); ok(s.getChannelKeys('r1', 'bob:x.org')['3'] === 'W', 'wrapped-ключи канала');
  s.appendChannelPost('r1', { msgId: 'p1' }); ok(s.channelHistory('r1', 0).length === 1, 'посты канала');
  s.toggleReaction('r1', 'p1', '👍', 'bob:x.org'); s.addPaidReaction('r1', 'p1', 'bob:x.org', 5);
  const rs = s.reactionSummary('r1', 'p1', 'bob:x.org');
  ok(rs.counts['👍'] === 1 && rs.paid === 5 && rs.mine.includes('👍'), 'сводка реакций (бесплатные+платные)');
  s.removeReactions('r1', 'p1'); ok(!s.reactionSummary('r1', 'p1').total, 'removeReactions');

  // ── Outbox переживает рестарт ──
  s.enqueueOutbox({ id: 'o1', at: Date.now(), attempts: 1 });
  s.outboxAll()[0].attempts = 5; s.saveOutbox();
  const s2 = new Store(join(dir, 'store.json'));
  ok(s2.outboxAll()[0]?.attempts === 5, 'outbox (мутация attempts) переживает рестарт');

  // ── Миграция легаси store.json ──
  const md = mkdtempSync(join(tmpdir(), 'mig-'));
  const jp = join(md, 'store.json');
  writeFileSync(jp, JSON.stringify({
    accounts: { 'a:x.org': { isAdmin: true, createdAt: 1 } },
    history: { 'b:x.org': [{ seq: 7, at: 1, roomId: null, msgId: 'mm', toDevice: null, envelope: { from: 'a:x.org', msgId: 'mm' } }] },
    wallets: { 'a:x.org': { balance: 42, tx: [] } },
    seq: 7,
  }));
  const sm = new Store(jp);
  ok(sm.getAccount('a:x.org')?.isAdmin === true && sm.wallet('a:x.org').balance === 42, 'миграция: аккаунт+кошелёк');
  ok(sm.hasMessage('b:x.org', 'mm', null), 'миграция: история');
  ok(sm.appendHistory('c:x.org', { roomId: null, envelope: { msgId: 'z' } }).seq === 8, 'миграция: seq продолжается с максимума');
  ok(existsSync(jp + '.migrated') && !existsSync(jp), 'миграция: store.json → .migrated (бэкап)');
  const sm2 = new Store(jp);
  ok(sm2.getAccount('a:x.org')?.isAdmin === true, 'повторное открытие: данные на месте, без повторной миграции');
  rmSync(md, { recursive: true, force: true });
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
