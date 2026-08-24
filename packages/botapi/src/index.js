#!/usr/bin/env node
// Запуск Prizrak Bot API (упрощённый аналог Telegram Bot API, свой на каждом сервере).
//   BOTAPI_PORT        — порт (по умолчанию 8840)
//   BOTAPI_DB          — путь к SQLite (по умолчанию ./data/botapi.sqlite)
//   BOTAPI_ADMIN_TOKEN — секрет админа (роль BotFather) — ОБЯЗАТЕЛЕН
//   BOTAPI_DOMAIN      — домен вашего homeserver'а (напр. prizrak.webcluster.org) — ОБЯЗАТЕЛЕН
//   BOTAPI_BASE_URL    — явный адрес homeserver'а (иначе подберётся по домену)
import { startBotApi } from './botapi-server.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const dbPath = process.env.BOTAPI_DB || './data/botapi.sqlite';
try { mkdirSync(dirname(dbPath), { recursive: true }); } catch {}

const { port } = await startBotApi({
  port: Number(process.env.BOTAPI_PORT || 8840),
  dbPath,
  adminToken: process.env.BOTAPI_ADMIN_TOKEN,
  domain: process.env.BOTAPI_DOMAIN,
  baseUrl: process.env.BOTAPI_BASE_URL || null,
});
console.log(`[botapi] Prizrak Bot API слушает :${port} · БД: ${dbPath}`);
console.log('[botapi] Методы: /bot<token>/getMe · sendMessage · getUpdates  |  Админ: /admin/createBot · /admin/bots · /admin/deleteBot');
