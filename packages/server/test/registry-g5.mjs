// registry-g5.mjs — реестр публичных групп: подпись/проверка, publish/search/unpublish,
// TOFU по домену, лимиты. Гоняет НАСТОЯЩИЙ registry-server in-process + подписи
// хелперами homeserver'а (проверка совместимости канонических байтов).
import { startRegistry } from '../../registry/src/registry-server.js';
import { loadServerIdentity, makeGroupRecord, verifyGroupRecord } from '../src/deaddrop-fed.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const dir = mkdtempSync(join(tmpdir(), 'reg-'));
let reg = null;

try {
  const idA = loadServerIdentity(join(dir, 'a.json')); // сервер a.org
  const idB = loadServerIdentity(join(dir, 'b.json')); // сервер b.org (чужой ключ)
  reg = await startRegistry({ port: 0, dbPath: join(dir, 'reg.sqlite'), wellKnownCheck: false });
  const base = `http://127.0.0.1:${reg.port}`;
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  const get = async (path) => (await fetch(base + path)).json();

  // ── Подпись совместима между homeserver и реестром ──
  const signed = makeGroupRecord(idA, { roomId: '!aaaa:a.org', domain: 'a.org', name: 'Рыбалка на Волге', description: 'Ловим сазана и судака', members: 42, type: 'group' });
  ok(verifyGroupRecord(signed.record, signed.sig), 'подпись записи проверяется хелпером сервера');

  // ── Publish + поиск по подстроке (регистронезависимо, кириллица) ──
  let r = await post('/api/publish', signed);
  ok(r.status === 200 && r.data.ok, 'publish публичной группы принят');
  const s2 = makeGroupRecord(idA, { roomId: '!bbbb:a.org', domain: 'a.org', name: 'Кулинария', description: 'Рецепты и рыбалка по выходным', members: 7, type: 'group' });
  await post('/api/publish', s2);
  let sr = await get('/api/search?q=' + encodeURIComponent('Рыбал'));
  ok(sr.results.length === 2, 'поиск «Рыбал» находит по названию И по описанию (2 группы)');
  ok(sr.results[0].roomId === '!aaaa:a.org', 'сортировка по числу участников (42 раньше 7)');
  sr = await get('/api/search?q=' + encodeURIComponent('рЫбАлКа'));
  ok(sr.results.length === 2, 'поиск регистронезависимый (рЫбАлКа)');
  sr = await get('/api/search?q=' + encodeURIComponent('носки'));
  ok(sr.results.length === 0, 'нерелевантный запрос — пусто');
  r = await get('/api/search?q=%D1%80'); // 1 символ
  ok(r.error, 'запрос короче 2 символов отклоняется');

  // ── Обновление записи (upsert) ──
  const upd = makeGroupRecord(idA, { roomId: '!aaaa:a.org', domain: 'a.org', name: 'Рыбалка и охота', description: 'Ловим всё', members: 50, type: 'group' });
  await post('/api/publish', upd);
  sr = await get('/api/search?q=' + encodeURIComponent('охота'));
  ok(sr.results.length === 1 && sr.results[0].members === 50, 'повторный publish обновляет запись (имя+участники)');

  // ── Защита: битая подпись, чужой ключ (TOFU), чужой roomId ──
  r = await post('/api/publish', { record: signed.record, sig: 'ab'.repeat(64) });
  ok(r.status === 403, 'битая подпись отклоняется');
  const evil = makeGroupRecord(idB, { roomId: '!cccc:a.org', domain: 'a.org', name: 'Фальшивка', description: '', members: 999, type: 'group' });
  r = await post('/api/publish', evil);
  ok(r.status === 403, 'TOFU: чужой ключ не может публиковать за домен a.org');
  const foreign = makeGroupRecord(idB, { roomId: '!dddd:a.org', domain: 'b.org', name: 'Чужая комната', description: '', members: 1, type: 'group' });
  r = await post('/api/publish', foreign);
  ok(r.status === 400, 'roomId с чужим доменом отклоняется');

  // ── Unpublish ──
  const un = makeGroupRecord(idA, { roomId: '!aaaa:a.org', domain: 'a.org', name: '', description: '', members: 0, type: 'group', del: true });
  r = await post('/api/unpublish', un);
  ok(r.status === 200 && r.data.removed, 'unpublish (del:true) удаляет запись');
  sr = await get('/api/search?q=' + encodeURIComponent('охота'));
  ok(sr.results.length === 0, 'после unpublish группа не ищется');
  // Флаг del обязан соответствовать эндпоинту.
  r = await post('/api/publish', un);
  ok(r.status === 400, 'запись с del:true нельзя отправить в /api/publish');

  // ── Статистика ──
  const st = await get('/api/stats');
  ok(st.groups === 1 && st.domains >= 1, 'stats: осталась 1 группа');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.stack || e.message);
} finally {
  if (reg) reg.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
