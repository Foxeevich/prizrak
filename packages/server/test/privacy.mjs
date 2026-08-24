// privacy.mjs — «Конфиденциальность»: чёрный список, политика «Группы и каналы».
// Боевой тест: настоящий homeserver + живые клиенты.
//   • заблокированный НЕ доставляет личные сообщения (и не знает об этом);
//   • разблокировка возвращает доставку;
//   • групповые сообщения блокировкой не режутся;
//   • приглашение в группу блокируется по ЧС и по политике groups (none/contacts/all).
import { createServer } from '../src/server.js';
import { PrizrakClient } from '../../client/src/client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const dir = mkdtempSync(join(tmpdir(), 'privacy-'));
const PORT = 8987, D = 'p.invalid', BASE = `http://127.0.0.1:${PORT}`;
let hs;
try {
  hs = await createServer({ domain: D, port: PORT, ports: [PORT], storePath: join(dir, 'store.json'), resolver: { [D]: BASE } });

  const mk = async (name) => {
    const c = await new PrizrakClient({ name, userId: `${name}:${D}`, baseUrl: BASE, deviceId: name + '-dev' }).init();
    await c.register('password-123'); await c.publishDevice(); return c;
  };
  const fox = await mk('fox');      // хозяин настроек
  const spam = await mk('spam');    // кого блокируем
  const pal = await mk('pal');      // обычный собеседник
  const textsFrom = async (cl, from) => (await cl.receive()).filter((m) => m.kind === 'text' && m.from === from).map((m) => m.text);

  // ── База: до блокировки сообщения ходят ──
  await spam.send(fox.userId, 'до блокировки');
  await sleep(500);
  ok((await textsFrom(fox, spam.userId)).includes('до блокировки'), 'до блокировки сообщение доходит');

  // ── Настройки приватности сохраняются ──
  const def = await fox.getPrivacy();
  ok(def.groups === 'all' && Array.isArray(def.blocked) && !def.blocked.length, 'дефолт: ЧС пуст, группы «Все»');
  await fox.setPrivacy({ ...def, blocked: [spam.userId] });
  ok((await fox.getPrivacy()).blocked.includes(spam.userId), 'чёрный список сохранён на сервере');

  // ── Блокировка: сообщение НЕ доходит, отправитель не в курсе ──
  const r = await spam.send(fox.userId, 'после блокировки');
  ok(r.delivered === true, 'отправителю сервер отвечает как обычно (факт блокировки не палится)');
  await sleep(500);
  ok(!(await textsFrom(fox, spam.userId)).includes('после блокировки'), 'сообщение от заблокированного НЕ доставлено');

  // ── Незаблокированный ходит свободно ──
  await pal.send(fox.userId, 'привет от друга');
  await sleep(500);
  ok((await textsFrom(fox, pal.userId)).includes('привет от друга'), 'от остальных сообщения доходят');

  // ── Группы: блокировка личек не режет групповые сообщения ──
  // Группу собирает pal (он не в ЧС): зовёт и fox, и заблокированного spam.
  const g = await pal.createGroup('Общая');
  const roomId = g.roomId || g.id;
  await pal.invite(roomId, fox.userId);            // fox ещё не ограничивал группы
  await pal.invite(roomId, spam.userId);
  await sleep(300);
  await spam.sendToRoom(roomId, 'пост в группе');
  await sleep(600);
  const inRoom = (await fox.receive()).filter((m) => m.kind === 'text' && m.roomId === roomId).map((m) => m.text);
  ok(inRoom.includes('пост в группе'), 'групповые сообщения блокировкой не режутся');

  // ── Приглашения: ЧС ──
  const g2 = await spam.createGroup('Вторая');
  let err = null;
  try { await spam.invite(g2.roomId || g2.id, fox.userId); } catch (e) { err = e.message; }
  ok(!!err, 'заблокированный НЕ может пригласить в группу');

  // ── Приглашения: политика «Никто» ──
  await fox.setPrivacy({ ...(await fox.getPrivacy()), groups: 'none' });
  const g3 = await pal.createGroup('Третья');
  err = null;
  try { await pal.invite(g3.roomId || g3.id, fox.userId); } catch (e) { err = e.message; }
  ok(!!err, 'при «Никто» даже друг не может добавить в группу');

  // ── Политика «Мои контакты»: кому Я писал — тот контакт ──
  await fox.setPrivacy({ ...(await fox.getPrivacy()), groups: 'contacts' });
  await fox.send(pal.userId, 'ты мой контакт'); // теперь pal — контакт fox
  await sleep(400);
  const g4 = await pal.createGroup('Четвёртая');
  err = null;
  try { await pal.invite(g4.roomId || g4.id, fox.userId); } catch (e) { err = e.message; }
  ok(!err, '«Мои контакты»: тот, кому я писал, добавить может');

  const stranger = await mk('stranger');
  const g5 = await stranger.createGroup('Пятая');
  err = null;
  try { await stranger.invite(g5.roomId || g5.id, fox.userId); } catch (e) { err = e.message; }
  ok(!!err, '«Мои контакты»: незнакомец добавить НЕ может');

  // ── Исключение: «Всегда разрешать» перебивает политику ──
  await fox.setPrivacy({ ...(await fox.getPrivacy()), groups: 'none', groupsAllow: [stranger.userId] });
  const g6 = await stranger.createGroup('Шестая');
  err = null;
  try { await stranger.invite(g6.roomId || g6.id, fox.userId); } catch (e) { err = e.message; }
  ok(!err, 'исключение «Всегда разрешать» работает поверх «Никто»');

  // ── Разблокировка возвращает доставку ──
  await fox.setPrivacy({ ...(await fox.getPrivacy()), blocked: [] });
  await spam.send(fox.userId, 'снова на связи');
  await sleep(500);
  ok((await textsFrom(fox, spam.userId)).includes('снова на связи'), 'после разблокировки сообщения снова доходят');

  // ── Валидация входных данных ──
  const bad = await fox.setPrivacy({ blocked: ['мусор', 'ok:dom'], groups: 'ЧТО-ТО', calls: 'none' });
  ok(bad.groups === 'all' && bad.calls === 'none' && bad.blocked.length === 1, 'сервер чистит мусор во входных данных');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.message, e.stack?.split('\n')[1] || '');
} finally {
  try { hs?.closeAll?.(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(`\nПриватность: ${pass} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
