// bootstrap.js — Фаза 6b: мультиканальный ПОДПИСАННЫЙ бутстрап сид-узлов.
//
// Проблема: чтобы войти в сеть тайников, серверу нужен ХОТЯ БЫ ОДИН живой сид-узел.
// Если этот адрес один и захардкожен — ТСПУ его заблокирует, и новые серверы не войдут.
//
// Решение: стартовый набор сидов оформляется как БАНДЛ, ПОДПИСАННЫЙ мейнтейнером
// (тот же Ed25519-ключ, что подписывает автообновления). Публичный ключ мейнтейнера
// ВШИТ в приложение — значит бандл нельзя подделать, откуда бы он ни пришёл. Поэтому
// его можно тянуть по НЕСКОЛЬКИМ независимым каналам, ни одному из которых не нужно
// доверять:
//   1) DNS-TXT через DoH (DNS-over-HTTPS) — запись трудно вырезать точечно, а DoH-резолвер
//      выглядит как обычный HTTPS к 1.1.1.1/8.8.8.8;
//   2) HTTPS/domain-fronting — забрать бандл с URL, при желании с чужим SNI (фронт под CDN);
//   3) ротируемые ВШИТЫЕ сиды — подписанный бандл, вкомпилированный в сборку (последний резерв).
// Берётся самый свежий валидный бандл (по epoch); результат кэшируется на диск.
//
// Важно: бандл несёт только адреса ВХОДА (сиды). Дальше сервер сам узнаёт всю сеть узлов
// через peer-exchange (Фаза 6a). Один живой сид из любого канала → сервер в сети.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

const clean = (u) => String(u || '').replace(/\/+$/, '');
// Каноничные байты бандла для подписи (без поля sig, стабильный порядок ключей).
const bundleBytes = (b) => utf8ToBytes(JSON.stringify({ v: 1, seeds: b.seeds, epoch: b.epoch, notAfter: b.notAfter }));

/** Смонтировать подписанный бандл сидов. maintainerPriv — 64-hex Ed25519 seed. */
export function makeBootstrapBundle(maintainerPrivHex, seeds, { epoch, ttlMs = 90 * 86400000, now } = {}) {
  const t = typeof now === 'number' ? now : Date.now();
  const base = {
    v: 1,
    seeds: [...new Set((seeds || []).map(clean).filter(Boolean))],
    epoch: typeof epoch === 'number' ? epoch : Math.floor(t / 86400000),
    notAfter: t + ttlMs,
  };
  const sig = bytesToHex(ed25519.sign(bundleBytes(base), hexToBytes(maintainerPrivHex)));
  return { ...base, sig };
}

/** Проверить бандл ключом мейнтейнера (подпись + срок). now — для тестов. */
export function verifyBootstrapBundle(bundle, maintainerPubHex, now) {
  if (!bundle || bundle.v !== 1 || !Array.isArray(bundle.seeds) || typeof bundle.epoch !== 'number' ||
      typeof bundle.notAfter !== 'number' || typeof bundle.sig !== 'string') return false;
  const t = typeof now === 'number' ? now : Date.now();
  if (t > bundle.notAfter) return false;                       // протух
  if (!bundle.seeds.every((s) => typeof s === 'string' && /^https?:\/\//.test(s))) return false;
  try { return ed25519.verify(hexToBytes(bundle.sig), bundleBytes(bundle), hexToBytes(maintainerPubHex)); } catch { return false; }
}

// ── Каналы доставки бандла. Каждый возвращает бандл-кандидат (объект) или null. ──

// DNS-TXT через DoH: TXT-запись содержит "prizrak-boot=<base64url(json бандла)>" (возможно
// склеенная из нескольких строк). Резолвер по умолчанию — Cloudflare DoH (JSON API).
export function dohChannel(name, { dohUrl = 'https://cloudflare-dns.com/dns-query', fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  return async () => {
    const u = `${dohUrl}?name=${encodeURIComponent(name)}&type=TXT`;
    const r = await f(u, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const txts = (j.Answer || []).map((a) => String(a.data || '').replace(/^"|"$/g, '').replace(/"\s+"/g, '')).join('');
    const m = /prizrak-boot=([A-Za-z0-9\-_]+=*)/.exec(txts);
    if (!m) return null;
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  };
}

// HTTPS/domain-fronting: забрать JSON-бандл с URL. host — опциональный Host-заголовок,
// чтобы фронтить запрос под безобидный CDN-домен (SNI≠Host на прод-фронте).
export function httpsChannel(url, { host, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  return async () => {
    const headers = host ? { host } : {};
    const r = await f(url, { headers, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    return await r.json();
  };
}

// Вшитый бандл: подписанный бандл, вкомпилированный в сборку (ротируемый резерв).
export function bakedChannel(bundle) { return async () => bundle || null; }

/**
 * Бутстрап: пробует каналы (все параллельно), проверяет подписи ключом мейнтейнера,
 * выбирает самый свежий валидный бандл, кэширует его и отдаёт сиды.
 *  - maintainerPubHex — ВШИТЫЙ публичный ключ (корень доверия к бандлу).
 *  - channels — массив функций-каналов (doh/https/baked).
 *  - cachePath — куда сохранить последний валидный бандл (переживает падение всех каналов).
 */
export class Bootstrap {
  constructor({ maintainerPubHex, channels = [], cachePath = null, log } = {}) {
    this.pub = maintainerPubHex;
    this.channels = channels;
    this.cachePath = cachePath;
    this.log = log || (() => {});
    this.bundle = null;             // текущий лучший валидный бандл
    this._loadCache();
  }
  _loadCache() {
    if (!this.cachePath || !existsSync(this.cachePath)) return;
    try { const b = JSON.parse(readFileSync(this.cachePath, 'utf8')); if (verifyBootstrapBundle(b, this.pub)) this.bundle = b; } catch {}
  }
  _saveCache() {
    if (!this.cachePath || !this.bundle) return;
    try { mkdirSync(dirname(this.cachePath), { recursive: true }); writeFileSync(this.cachePath, JSON.stringify(this.bundle)); } catch {}
  }

  /** Опросить каналы, принять самый свежий валидный бандл. Возвращает список сидов. */
  async resolve(now) {
    const results = await Promise.allSettled(this.channels.map((ch) => ch()));
    let best = this.bundle;                                    // старт — кэш (если был)
    let updated = false;
    for (const res of results) {
      if (res.status !== 'fulfilled' || !res.value) continue;
      const b = res.value;
      if (!verifyBootstrapBundle(b, this.pub, now)) continue;  // подделка/протухший — мимо
      if (!best || b.epoch > best.epoch) { best = b; updated = true; }
    }
    if (best && best !== this.bundle) { this.bundle = best; updated = true; }
    if (updated) { this._saveCache(); this.log(`[bootstrap] принят бандл epoch=${this.bundle.epoch}, сидов=${this.bundle.seeds.length}`); }
    return this.seeds();
  }
  seeds() { return this.bundle ? [...this.bundle.seeds] : []; }
}

// Собрать каналы из конфига сервера (deaddropBootstrap).
export function channelsFromConfig(cfg = {}, fetchImpl) {
  const ch = [];
  for (const d of (cfg.doh || [])) ch.push(dohChannel(d.name, { dohUrl: d.url, fetchImpl }));
  for (const h of (cfg.https || [])) ch.push(httpsChannel(h.url, { host: h.host, fetchImpl }));
  if (cfg.baked) ch.push(bakedChannel(cfg.baked));
  return ch;
}
