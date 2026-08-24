// smoke.mjs — сквозной тест узла-тайника (Фаза 1) + детерминированное размещение.
import { startNode } from '../src/node.js';
import { placement } from '../src/placement.js';
import { newKeypair, bytesToHex, msgIdOf, mailboxOf, signAck, randomBytes } from '../src/crypto.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dd-'));
const PORT = 8899, base = `http://127.0.0.1:${PORT}`;
const node = startNode({ dataDir: dir, port: PORT, host: '127.0.0.1', sweepMs: 3600000 });
await new Promise((r) => setTimeout(r, 250));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const putBlob = (msgId, mailbox, epoch, expiry, body) =>
  fetch(base + '/dd/put', { method: 'PUT', headers: { 'x-dd-msgid': msgId, 'x-dd-mailbox': mailbox, 'x-dd-epoch': String(epoch), 'x-dd-expiry': String(expiry || 0) }, body });

try {
  const rcpt = newKeypair(), rcptPub = bytesToHex(rcpt.pub), epoch = 1;
  const mailbox = mailboxOf(rcptPub, epoch);
  const ct = Buffer.from(randomBytes(1000));           // «зашифрованный» конверт (для узла — просто байты)
  const msgId = msgIdOf(ct);

  let j = await (await putBlob(msgId, mailbox, epoch, Date.now() + 86400000, ct)).json();
  ok(j.ok && j.stored, 'PUT сохранил блоб');

  j = await (await putBlob('deadbeef', mailbox, epoch, 0, ct)).json();
  ok(!j.ok && j.reason === 'bad-msgid', 'PUT с неверным msgId отклонён (контент-адрес)');

  j = await (await fetch(base + '/dd/poll', { method: 'POST', body: JSON.stringify({ mailbox }) })).json();
  ok(j.ok && j.items.length === 1 && j.items[0].msgId === msgId, 'POLL нашёл блоб в ящике');

  j = await (await fetch(base + '/dd/poll', { method: 'POST', body: JSON.stringify({ mailbox: mailboxOf(rcptPub, 999) }) })).json();
  ok(j.ok && j.items.length === 0, 'POLL по другому ящику пуст (слепой ящик работает)');

  let got = Buffer.from(await (await fetch(base + '/dd/get/' + msgId)).arrayBuffer());
  ok(got.length === ct.length && msgIdOf(got) === msgId, 'GET вернул тот же шифртекст');

  const atk = newKeypair();
  j = await (await fetch(base + '/dd/ack', { method: 'POST', body: JSON.stringify({ msgId, pub: bytesToHex(atk.pub), sig: signAck(atk.priv, msgId) }) })).json();
  ok(!j.ok, 'ACK от чужого ключа отклонён (не владелец ящика)');
  ok((await fetch(base + '/dd/get/' + msgId)).status === 200, 'блоб на месте после поддельного ACK');

  j = await (await fetch(base + '/dd/ack', { method: 'POST', body: JSON.stringify({ msgId, pub: rcptPub, sig: signAck(rcpt.priv, msgId) }) })).json();
  ok(j.ok && j.deleted, 'ACK получателя принят, блоб удалён');
  ok((await fetch(base + '/dd/get/' + msgId)).status === 404, 'GET после ACK → 404');

  j = await (await fetch(base + '/dd/poll', { method: 'POST', body: JSON.stringify({ mailbox }) })).json();
  ok(j.items.length === 0, 'POLL после ACK пуст');

  j = await (await putBlob(msgId, mailbox, epoch, 0, ct)).json();
  ok(j.ok && j.stale, 'повторный PUT доставленного → stale (протухание, §4.4)');

  j = await (await fetch(base + '/dd/have', { method: 'POST', body: JSON.stringify({ msgIds: [msgId] }) })).json();
  ok(j.acked.includes(msgId), 'HAVE сообщает, что msgId доставлен');

  j = await (await fetch(base + '/dd/health')).json();
  ok(j.nodeId && typeof j.uptimeMs === 'number', 'health отдаёт nodeId/uptime');
  const html = await (await fetch(base + '/')).text();
  ok(html.includes('It works'), 'корень — страница-обманка');

  const stHtml = await (await fetch(base + '/status')).text();
  ok(stHtml.includes('узел-тайник') && stHtml.includes('/dd/health'), '/status отдаёт локальную страницу (без Electron)');

  // Детерминированное размещение (Ceph-аналог).
  const nodes = Array.from({ length: 40 }, (_, i) => ({ relayId: 'node' + i, weight: 1 }));
  const p1 = placement(msgId, nodes, 4), p2 = placement(msgId, nodes, 4);
  ok(p1.length === 4 && JSON.stringify(p1) === JSON.stringify(p2), 'placement детерминирован, RF=4');
  ok(JSON.stringify(placement('ffffffff' + msgId.slice(8), nodes, 4)) !== JSON.stringify(p1), 'placement зависит от msgId');
} catch (e) {
  fail++; console.log('  ✗ исключение:', e.message);
} finally {
  node.stop();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅ ВСЁ ОК' : '❌ ЕСТЬ ПАДЕНИЯ'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
