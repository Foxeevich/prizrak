#!/usr/bin/env node
// node.js — точка входа узла-тайника. Запуск: `node src/node.js` или через Electron-обёртку.
// Конфиг из ENV: DD_PORT (8820), DD_HOST (0.0.0.0), DD_DATA (~/.prizrak-deaddrop),
// DD_MAX_BYTES, DD_MAILBOX_BYTES, DD_BLOB_BYTES, DD_ACK_TTL_MS, DD_SWEEP_MS.
// Реестр (Фаза 2): DD_PUBLIC — публичный URL узла для других; DD_SEEDS — список сид-узлов
// через запятую; DD_GOSSIP_MS — период госсипа (30с).
// Самоисцеление (Фазы 4–5): DD_RF — число копий (4); DD_HEAL_MS — период исцеления (20с).
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { loadOrCreateIdentity } from './identity.js';
import { Store } from './store.js';
import { Registry, makeRecord } from './registry.js';
import { Directory } from './directory.js';
import { makeHealer } from './healer.js';
import { createServer } from './server.js';

export const VERSION = '0.8.1';
const num = (v) => (v && Number(v) > 0 ? Number(v) : undefined);
const log = (...a) => { try { console.log(...a); } catch {} };

export function startNode(opts = {}) {
  const dataDir = opts.dataDir || process.env.DD_DATA || join(homedir(), '.prizrak-deaddrop');
  const port = Number(opts.port || process.env.DD_PORT || 8820);
  const host = opts.host || process.env.DD_HOST || '0.0.0.0';

  const identity = loadOrCreateIdentity(join(dataDir, 'identity.json'));
  // Полный Node ID (relayId) — в файл рядом с данными, чтобы оператор мог прочитать
  // его на удалённой машине без открытия /status (например, cat .../node-id.txt).
  try { writeFileSync(join(dataDir, 'node-id.txt'), identity.nodeId + '\n'); } catch {}
  const store = new Store(dataDir, {
    maxBytes: opts.maxBytes || num(process.env.DD_MAX_BYTES),
    maxPerMailboxBytes: opts.maxPerMailboxBytes || num(process.env.DD_MAILBOX_BYTES),
    maxBlobBytes: opts.maxBlobBytes || num(process.env.DD_BLOB_BYTES),
    ackTtlMs: opts.ackTtlMs || num(process.env.DD_ACK_TTL_MS),
  });
  const startedAt = Date.now();

  // Реестр узлов + собственная запись. DD_PUBLIC — публичный URL этого узла (для других).
  const registry = new Registry(join(dataDir, 'registry.json'));
  const publicUrl = (opts.publicUrl || process.env.DD_PUBLIC || `http://127.0.0.1:${port}`).replace(/\/$/, '');
  const seeds = (opts.seeds || process.env.DD_SEEDS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  // Фаза 6: метка домена отказа (оператор/ASN/страна) — для anti-Sybil diversity в размещении.
  const group = opts.group || process.env.DD_GROUP || '';
  const ownRecord = () => makeRecord(identity, [publicUrl], undefined, group);
  // Фаза 6c: приватный (bridge) узел НЕ регистрирует себя в общем реестре и не участвует в
  // госсипе — значит его нет ни в одном /registry/list, и цензор не может его выкачать.
  // Он раздаётся вне сети: оператор передаёт «билет-мост» (подписанную запись) доверенным серверам.
  const isPrivate = opts.private ?? (process.env.DD_PRIVATE === '1' || process.env.DD_PRIVATE === 'true');
  if (!isPrivate) registry.upsert(ownRecord());
  // Директория серверов (Фаза 6a): узлы несут и разносят подписанные записи homeserver'ов.
  const directory = new Directory(join(dataDir, 'directory.json'));

  const listPageMax = Number(opts.listPageMax || process.env.DD_LIST_MAX || 24);
  const powBits = Number(opts.powBits ?? process.env.DD_POW_BITS ?? 0); // 0 = PoW выключен (аддитивно)
  // Удалённый доступ к /status и /dd/claim по секретному ключу (иначе — только localhost).
  const statusKey = opts.statusKey || process.env.DD_STATUS_KEY || '';
  const server = createServer({ store, identity, registry, directory, version: VERSION, startedAt, maxBlobBytes: store.maxBlobBytes, listPageMax, listRate: opts.listRate || null, powBits, statusKey });
  server.listen(port, host, () => {
    log(`[deaddrop] v${VERSION} слушает http://${host}:${port} · data=${dataDir}`);
    // Полный Node ID — заметным блоком, чтобы был виден в `journalctl -u prizrak-node`
    // и в `systemctl status prizrak-node` (последние строки журнала).
    log('');
    log('  ┌─ PRIZRAK NODE ──────────────────────────────────────────────────');
    log('  │ NODE ID (relayId) — для регистрации узла:');
    log(`  │   ${identity.nodeId}`);
    log(`  │ Статус (локально): http://127.0.0.1:${port}/status`);
    if (statusKey) log(`  │ Статус (удалённо): http://<ВАШ_IP>:${port}/status?key=${statusKey}`);
    log(`  │ Код привязки к аккаунту: curl "http://127.0.0.1:${port}/dd/claim?user=НИК:ДОМЕН"`);
    log(`  │ ID также записан в: ${join(dataDir, 'node-id.txt')}`);
    log('  └─────────────────────────────────────────────────────────────────');
    log('');
    if (seeds.length) log(`[deaddrop] сиды реестра: ${seeds.join(', ')}`);
    if (isPrivate) {
      log('[deaddrop] 🔒 ПРИВАТНЫЙ (bridge) узел: в общий реестр НЕ анонсируется.');
      log('[deaddrop] билет-мост (передайте доверенным серверам в deaddropBridges):');
      log('  ' + JSON.stringify(ownRecord()));
    }
  });
  server.on('error', (e) => log(`[deaddrop] ошибка сервера: ${e.message}`));

  // Фаза 6d — опциональный стелс-фронт: наружу торчит TLS-туннель (неотличим от HTTPS),
  // HTTP узла проксируется на него. Включается PSK (DD_STEALTH_PSK). Требует packages/transport.
  const stealthPsk = opts.stealthPsk || process.env.DD_STEALTH_PSK;
  const stealthPort = Number(opts.stealthPort || process.env.DD_STEALTH_PORT || 8443);
  let stealth = null;
  if (stealthPsk) {
    import('./stealth-front.js').then(({ createStealthFront }) => {
      stealth = createStealthFront({ psk: stealthPsk, target: { host: '127.0.0.1', port } });
      stealth.listen(stealthPort, host, () => log(`[deaddrop] 🥷 стелс-фронт (TLS) слушает :${stealthPort} → узел на :${port}`));
      stealth.on('error', (e) => log(`[deaddrop] стелс-фронт ошибка: ${e.message}`));
    }).catch((e) => log(`[deaddrop] стелс-фронт не запущен: ${e.message}`));
  }

  const sweepMs = Number(opts.sweepMs || process.env.DD_SWEEP_MS || 60000);
  const sweep = setInterval(() => {
    const r = store.sweep();
    if (r.delBlobs || r.delAcks) log(`[deaddrop] уборка: −${r.delBlobs} протухших блобов, −${r.delAcks} старых ACK`);
  }, sweepMs);
  sweep.unref?.();

  // Госсип реестра: анонсируем себя сидам/известным узлам и подтягиваем их списки.
  async function gossipOnce() {
    const self = ownRecord();
    registry.upsert(self); // heartbeat (свежий addedAt)
    const peers = new Set(seeds);
    for (const n of registry.nodes()) for (const e of n.endpoints) peers.add(e.replace(/\/$/, ''));
    peers.delete(publicUrl);
    for (const base of peers) {
      try {
        await fetch(base + '/registry/announce', { method: 'POST', body: JSON.stringify({ records: [self] }), signal: AbortSignal.timeout(5000) });
        const j = await (await fetch(base + '/registry/list', { signal: AbortSignal.timeout(5000) })).json();
        if (j && Array.isArray(j.records)) registry.upsertMany(j.records);
        // Разносим и директорию серверов (Фаза 6a): подтягиваем чужие подписанные записи.
        try { const d = await (await fetch(base + '/directory/list', { signal: AbortSignal.timeout(5000) })).json(); if (d && Array.isArray(d.records)) directory.upsertMany(d.records); } catch {}
      } catch {}
    }
  }
  const gossipMs = Number(opts.gossipMs || process.env.DD_GOSSIP_MS || 30000);
  let gossip = null;
  // Приватный (bridge) узел в госсипе не участвует: не анонсирует себя и не «светится» соединениями.
  if (opts.gossip !== false && !isPrivate) { gossipOnce(); gossip = setInterval(gossipOnce, gossipMs); gossip.unref?.(); }

  // Самоисцеление реплик (Фазы 4–5): backfill до RF, ACK-протухание, снятие лишних копий.
  const rf = Number(opts.rf || process.env.DD_RF || 4);
  const healOnce = makeHealer({ store, registry, identity }, { rf });
  const healMs = Number(opts.healMs || process.env.DD_HEAL_MS || 20000);
  let heal = null;
  if (opts.heal !== false) {
    heal = setInterval(() => { healOnce().then((r) => {
      if (r && (r.backfilled || r.droppedAck || r.droppedSurplus)) log(`[deaddrop] исцеление: +${r.backfilled} долив, −${r.droppedAck} доставлено, −${r.droppedSurplus} лишних`);
    }).catch(() => {}); }, healMs);
    heal.unref?.();
  }

  return {
    server, store, identity, registry, directory, rf, port, host, dataDir, startedAt, publicUrl, gossipOnce, healOnce, isPrivate, ticket: ownRecord(),
    stop: () => { clearInterval(sweep); if (gossip) clearInterval(gossip); if (heal) clearInterval(heal); try { server.close(); } catch {} try { stealth && stealth.close(); } catch {} },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) startNode();
