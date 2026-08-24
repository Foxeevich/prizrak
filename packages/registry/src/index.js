#!/usr/bin/env node
// Запуск реестра публичных групп Prizrak.
//   REGISTRY_PORT — порт (по умолчанию 8830, наружу отдаётся через Caddy/nginx на tech.prizrak.im)
//   REGISTRY_DB   — путь к SQLite-базе (по умолчанию ./data/registry.sqlite)
//   REGISTRY_NO_WELLKNOWN=1 — отключить сверку ключей с /.well-known (для оффлайн-тестов)
import { startRegistry } from './registry-server.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const port = Number(process.env.REGISTRY_PORT || 8830);
const dbPath = process.env.REGISTRY_DB || './data/registry.sqlite';
try { mkdirSync(dirname(dbPath), { recursive: true }); } catch {}

const { port: p } = await startRegistry({ port, dbPath, wellKnownCheck: process.env.REGISTRY_NO_WELLKNOWN !== '1' });
console.log(`[registry] Реестр публичных групп Prizrak слушает :${p} · БД: ${dbPath}`);
console.log('[registry] API: GET /api/search?q=…  POST /api/publish  POST /api/unpublish  GET /api/stats');
