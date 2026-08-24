// antienum.js — Фаза 6c: анти-энумерация листингов узла-тайника.
// Цель: не дать цензору дёшево выкачать ВЕСЬ список узлов/серверов, чтобы разом внести их
// в чёрные списки. Два средства, применяемые к /registry/list и /directory/list:
//   1) Token-bucket rate-limit по IP — частые запросы с одного адреса throttle'ятся (429).
//   2) Частичное представление — за один ответ отдаём лишь СЛУЧАЙНОЕ подмножество записей
//      (≤ pageMax). Легитимный госсип сходится за несколько раундов (объединение подмножеств),
//      а скраперу приходится делать много медленных запросов, чтобы собрать всё.
// Приватные (bridge) узлы в листинги не попадают вовсе — они раздаются вне сети (см. node.js).

// Простой token-bucket. capacity — «всплеск», refillPerSec — установившийся темп.
export class RateLimiter {
  constructor({ capacity = 20, refillPerSec = 0.5, maxKeys = 5000 } = {}) {
    this.capacity = capacity;
    this.refill = refillPerSec;
    this.maxKeys = maxKeys;
    this.buckets = new Map();  // key → { tokens, ts }
  }
  // now передаётся для тестируемости (иначе Date.now()).
  allow(key, now = Date.now(), cost = 1) {
    if (this.buckets.size > this.maxKeys) this._evict(now);
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, ts: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.ts) / 1000) * this.refill);
    b.ts = now;
    if (b.tokens >= cost) { b.tokens -= cost; return true; }
    return false;
  }
  _evict(now) {
    // выкидываем «полные» (давно не использованные) корзины, чтобы не течь по памяти
    for (const [k, b] of this.buckets) { if (b.tokens >= this.capacity) this.buckets.delete(k); if (this.buckets.size <= this.maxKeys) break; }
    if (this.buckets.size > this.maxKeys) this.buckets.clear();
  }
}

// Случайное подмножество не более n элементов (частичное представление списка).
export function sampleSubset(arr, n, rnd = Math.random) {
  if (!Array.isArray(arr) || arr.length <= n) return arr ? [...arr] : [];
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

// Достать IP клиента (учитываем локальный прокси/стелс-фронт через x-forwarded-for).
export function clientKey(req) {
  const xff = (req.headers && (req.headers['x-forwarded-for'] || '')).split(',')[0].trim();
  if (xff) return xff;
  const a = (req.socket && req.socket.remoteAddress) || 'unknown';
  return a.replace('::ffff:', '');
}
