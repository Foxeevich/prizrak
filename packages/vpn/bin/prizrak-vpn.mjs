#!/usr/bin/env node
// prizrak-vpn.mjs — единый CLI «Призрак-Транспорта»: три роли одной сети.
//
//   prizrak-vpn genkey                 — сгенерировать ключи узла
//   prizrak-vpn relay  [config.json]   — промежуточный узел (РФ), первый прыжок
//   prizrak-vpn exit   [config.json]   — выходной узел (заграница), выход в интернет
//   prizrak-vpn client [config.json]   — локальный SOCKS-прокси на своём устройстве
//   prizrak-vpn selftest               — проверить всю цепочку локально
//
// Топология: клиент(SOCKS на ноуте) → реле(РФ) → выход(заграница) → интернет.

import fs from 'node:fs';
import net from 'node:net';
import { generateNodeKeys, clientHandshake, clientComplete } from '../src/shadow.js';
import { createRelay } from '../src/relay-node.js';
import { createExit } from '../src/exit-node.js';
import { createSocks } from '../src/socks.js';
import { attachBreath } from '../src/wire.js';
import { packCtrl, readCtrl, OP } from '../src/estafeta.js';

const [cmd, arg] = process.argv.slice(2);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[${now()}] ${m}`);
const readCfg = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error('Не читается конфиг ' + p + ': ' + e.message); process.exit(1); } };
const needKeys = (c) => { if (!c.keys || !c.keys.privateKey) { console.error('В конфиге нет keys.privateKey — сгенерируйте: prizrak-vpn genkey'); process.exit(1); } };
const onStop = (srv) => { const off = () => { log('останов'); srv.close(() => process.exit(0)); }; process.on('SIGTERM', off); process.on('SIGINT', off); };

if (cmd === 'genkey') {
  console.log(JSON.stringify(generateNodeKeys(), null, 2));
}

else if (cmd === 'relay' || cmd === 'start') {
  const cfg = readCfg(arg || 'config.json'); needKeys(cfg);
  runNode('relay', cfg);
}

else if (cmd === 'exit') {
  const cfg = readCfg(arg || 'config.json'); needKeys(cfg);
  runNode('exit', cfg);
}

else if (cmd === 'client') {
  const cfg = readCfg(arg || 'client-config.json');
  if (!cfg.relay || !cfg.exit) { console.error('В конфиге клиента нужны relay {host,port,pub} и exit {host,port,pub}'); process.exit(1); }
  const socks = createSocks({ relay: cfg.relay, exit: cfg.exit, host: cfg.socksHost || '127.0.0.1', port: cfg.socksPort || 1080, log });
  socks.listen(() => {
    log(`КЛИЕНТ: SOCKS5-прокси на ${socks.address()}`);
    log(`маршрут: ваш трафик → реле ${cfg.relay.host}:${cfg.relay.port} → выход ${cfg.exit.host}:${cfg.exit.port} → интернет`);
    log('Укажите этот SOCKS5 в браузере/системе, чтобы пустить трафик через Призрак.');
  });
  setInterval(() => log(`клиент: активных ${socks.stats.active}, всего ${socks.stats.total}, ошибок ${socks.stats.failed}`), 300000).unref();
  onStop(socks);
}

async function fetchBankPub(bank) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(bank.replace(/\/$/, '') + '/api/vpn/pubkey');
      if (r.ok) { const j = await r.json(); if (j.pub) return j.pub; }
    } catch {}
    await new Promise((res) => setTimeout(res, 3000));
  }
  return null;
}

async function announce(bank, token, body) {
  try {
    const r = await fetch(bank.replace(/\/$/, '') + '/api/vpn/nodes/announce', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-node-token': token || '' },
      body: JSON.stringify(body),
    });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function runNode(role, cfg) {
  const port = cfg.port || 8443, host = cfg.host || '0.0.0.0';
  let bankPub = null;
  if (cfg.bank) {
    log(`получаю ключ Банка (${cfg.bank})…`);
    bankPub = await fetchBankPub(cfg.bank);
    if (!bankPub) { console.error('Не удалось получить ключ Банка — узел без него работал бы бесплатно для всех. Проверьте bank в конфиге и доступность Банка.'); process.exit(1); }
    log('ключ Банка получен — пускаем только по оплаченным ордерам');
  } else {
    log('⚠ bank не задан — узел работает БЕЗ проверки оплаты (только для тестов/приватной сети)');
  }

  // Релей сообщает Банку, достучался ли до выхода (то, что видит только он).
  // Не спамим: один и тот же вердикт по узлу шлём не чаще раза в 30 сек.
  const reportState = new Map();
  async function reportExit(exitId, ok) {
    if (!cfg.bank || !exitId) return;
    const prev = reportState.get(exitId), nowMs = Date.now();
    if (prev && prev.ok === ok && (nowMs - prev.at) < 30000) return;
    reportState.set(exitId, { ok, at: nowMs });
    log(`→ Банку: выход ${exitId} ${ok ? 'доступен' : 'НЕ достучался'}`);
    try {
      await fetch(cfg.bank.replace(/\/$/, '') + '/api/vpn/nodes/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-node-token': cfg.token || '' },
        body: JSON.stringify({ exitId, ok }),
      });
    } catch {}
  }

  // Учёт трафика по пользователям (только выход): копим и раз в 30 сек шлём Банку.
  const usage = new Map();
  const onUsage = (u) => { if (u && u.userId && u.bytes > 0) usage.set(u.userId, (usage.get(u.userId) || 0) + u.bytes); };
  async function flushUsage() {
    if (!cfg.bank || usage.size === 0) return;
    const batch = [...usage.entries()]; usage.clear();
    for (const [userId, bytes] of batch) {
      try {
        await fetch(cfg.bank.replace(/\/$/, '') + '/api/vpn/usage', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-node-token': cfg.token || '' },
          body: JSON.stringify({ userId, bytes }),
        });
      } catch { usage.set(userId, (usage.get(userId) || 0) + bytes); } // не потеряем при сбое
    }
  }
  if (role === 'exit' && cfg.bank) setInterval(flushUsage, 30000).unref();

  const node = role === 'relay'
    ? createRelay({ keys: cfg.keys, bankPub, log, reportExit })
    : createExit({ keys: cfg.keys, bankPub, onUsage, log });

  node.listen(port, host, () => {
    log(`${role === 'relay' ? 'РЕЛЕ' : 'ВЫХОД'} слушает ${host}:${port}`);
    log(`публичный ключ узла: ${cfg.keys.publicKey}`);
    if (role === 'exit') log('⚠ ВЫХОД светит своим IP в логах сайтов — ставьте осознанно.');
  });

  // Саморегистрация: раз в минуту говорим Банку «я живой». Ничего вписывать вручную не нужно.
  if (cfg.bank) {
    const beat = async () => {
      const res = await announce(cfg.bank, cfg.token, {
        role, pub: cfg.keys.publicKey, port, operator: cfg.operator || '', country: cfg.country || '',
      });
      if (res && res.ok) log(`зарегистрирован в Банке: ${res.nodeId} (страна ${res.country})`);
      else log('⚠ не удалось объявиться Банку (повторю через минуту)');
    };
    beat();
    setInterval(beat, 60000).unref();
  }

  const st = () => role === 'relay'
    ? `реле: соединений ${node.stats.conns}, туннелей ${node.stats.tunnels}, отказов ${node.stats.denied}`
    : `выход: сессий ${node.stats.sessions}, байт ${node.stats.bytes}, отказов ${node.stats.denied}`;
  setInterval(() => log(st()), 300000).unref();
  onStop(node);
}

if (cmd === 'selftest') {
  selftest().then((okAll) => {
    console.log(okAll ? '\n✅ Самопроверка пройдена: клиент→реле→выход→назначение работает.' : '\n❌ Самопроверка не прошла.');
    process.exit(okAll ? 0 : 1);
  });
}

else if (!['genkey', 'relay', 'start', 'exit', 'client', 'selftest'].includes(cmd)) {
  console.log('Использование:\n  prizrak-vpn genkey\n  prizrak-vpn relay  [config.json]\n  prizrak-vpn exit   [config.json]\n  prizrak-vpn client [client-config.json]\n  prizrak-vpn selftest');
  process.exit(cmd ? 1 : 0);
}

async function selftest() {
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const echo = net.createServer((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('ECHO:'), d]))));
  await listen(echo); const echoPort = echo.address().port;
  const ek = generateNodeKeys(); const exit = createExit({ keys: ek, allowPrivate: true });
  await listen(exit.server); const exitPort = exit.server.address().port;
  const rk = generateNodeKeys();
  const relay = createRelay({ keys: rk, exits: [{ id: 'self', host: '127.0.0.1', port: exitPort, pub: ek.publicKey }] });
  await listen(relay.server); const relayPort = relay.server.address().port;
  const socks = createSocks({ relay: { host: '127.0.0.1', port: relayPort, pub: rk.publicKey }, exit: { host: '127.0.0.1', port: exitPort, pub: ek.publicKey }, port: 0 });
  await new Promise((r) => socks.server.listen(0, '127.0.0.1', r));
  const socksPort = socks.server.address().port;
  log(`эхо :${echoPort}, выход :${exitPort}, реле :${relayPort}, SOCKS :${socksPort}`);

  const got = await new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: socksPort });
    let stage = 0, out = '';
    const to = setTimeout(() => { try { s.destroy(); } catch {} resolve(out); }, 10000);
    s.on('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])));
    s.on('data', (d) => {
      if (stage === 0) { const h = [127, 0, 0, 1]; s.write(Buffer.from([0x05, 0x01, 0x00, 0x01, ...h, (echoPort >> 8) & 0xff, echoPort & 0xff])); stage = 1; return; }
      if (stage === 1) { if (d[1] !== 0) { clearTimeout(to); resolve(''); return; } s.write(Buffer.from('selftest-ping')); stage = 2; if (d.length > 10) out += d.slice(10).toString(); return; }
      out += d.toString(); if (out.includes('ECHO:selftest-ping')) { clearTimeout(to); s.end(); resolve(out); }
    });
    s.on('error', () => { clearTimeout(to); resolve(''); });
  });
  const okAll = got.includes('ECHO:selftest-ping');
  log(okAll ? 'эхо вернулось через SOCKS→реле→выход' : 'ответ не получен');
  echo.close(); relay.close(); exit.close(); socks.close();
  return okAll;
}
