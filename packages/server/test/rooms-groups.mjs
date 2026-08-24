// rooms-groups.mjs — приватность/публичность, права участников, исключения,
// медленный режим (значение), настройки группы и их отражение в publicView.
import { makeRoom, canPost, canManage, addParticipant, setRoomSettings, effectivePerms, memberCan, publicView, defaultPerms, SLOWMODE_ALLOWED, MEMBER_PERM_KEYS } from '../src/rooms.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

try {
  const owner = 'fox:x.org', alice = 'alice:x.org', bob = 'bob:x.org';
  const g = makeRoom({ type: 'group', name: 'G', creator: owner, domain: 'x.org' });
  addParticipant(g, alice); addParticipant(g, bob);

  // ── Значения по умолчанию ──
  ok(g.privacy === 'private', 'новая группа — частная по умолчанию');
  ok(g.slowModeSec === 0 && g.historyVisible === true, 'медленный режим выкл, история видна');
  ok(JSON.stringify(g.perms) === JSON.stringify(defaultPerms()), 'perms по умолчанию');
  ok(defaultPerms().sendMessages === true && defaultPerms().changeOwnTag === false, 'дефолт: писать можно, менять тег — нет');

  // ── Права: owner/админ всё, рядовой — по perms ──
  ok(MEMBER_PERM_KEYS.every((k) => effectivePerms(g, owner)[k] === true), 'у владельца все права true');
  ok(effectivePerms(g, alice).sendMessages === true && effectivePerms(g, alice).changeOwnTag === false, 'рядовой: по дефолту');
  ok(canPost(g, alice) === true, 'рядовой пишет, когда sendMessages=true');

  // ── Запрет писать рядовым ──
  setRoomSettings(g, owner, { perms: { sendMessages: false } });
  ok(canPost(g, alice) === false, 'после запрета sendMessages рядовой НЕ пишет');
  ok(canPost(g, owner) === true, 'владелец пишет всегда');
  ok(memberCan(g, alice, 'sendMedia') === true, 'прочие права не сбились (sendMedia остался true)');

  // ── Исключение для одного участника (Telegram «Исключения») ──
  setRoomSettings(g, owner, { permExceptions: { [bob]: { sendMessages: true } } });
  ok(canPost(g, bob) === true && canPost(g, alice) === false, 'исключение: bob пишет, alice — нет');

  // ── Приватность / медленный режим / история ──
  setRoomSettings(g, owner, { privacy: 'public', slowModeSec: 30, historyVisible: false });
  ok(g.privacy === 'public' && g.slowModeSec === 30 && g.historyVisible === false, 'privacy/slowmode/history применились');
  setRoomSettings(g, owner, { slowModeSec: 999 });
  ok(g.slowModeSec === 0, 'недопустимый slowMode → 0');
  ok(SLOWMODE_ALLOWED.includes(3600), 'в наборе медленного режима есть 1 час');

  // ── Права менять настройки — только владелец/админ ──
  let threw = false; try { setRoomSettings(g, alice, { privacy: 'private' }); } catch { threw = true; }
  ok(threw && g.privacy === 'public', 'рядовой не может менять настройки');

  // ── publicView отдаёт новые поля ──
  const pv = publicView(g);
  ok(pv.privacy === 'public' && pv.slowModeSec === 0 && pv.historyVisible === false, 'publicView: privacy/slowmode/history');
  ok(pv.perms && pv.perms.sendMessages === false && pv.permExceptions[bob]?.sendMessages === true, 'publicView: perms + исключения');

  // ── Канал не ломается ──
  const ch = makeRoom({ type: 'channel', name: 'C', creator: owner, domain: 'x.org' });
  addParticipant(ch, alice);
  ok(canPost(ch, owner) === true && canPost(ch, alice) === false, 'канал: вещает владелец, подписчик — нет');
  ok(publicView(ch).privacy === 'private', 'канал тоже имеет privacy-поле');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
