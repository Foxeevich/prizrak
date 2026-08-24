// link-preview.js — превью ссылок «как в Telegram», но приватно.
//
// ПРИНЦИП: карточку собирает ОТПРАВИТЕЛЬ и кладёт её внутрь зашифрованного
// сообщения. Получатель ничего никуда не запрашивает — его IP не утекает
// владельцу ссылки, а карточка остаётся видна, даже если сайт уже умер.
// (В Telegram превью строит сервер; у нас сервер содержимое не видит в принципе.)
//
// Всё best-effort: любая ошибка/таймаут → просто нет превью, сообщение уходит.

export const LINK_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/i;

const FETCH_MS = 6000;          // не тормозим отправку
const MAX_HTML = 512 * 1024;    // читаем только начало страницы — <head> в нём
const MAX_IMG = 400 * 1024;     // картинку берём, только если она разумного размера
const UA = 'Mozilla/5.0 (compatible; PrizrakBot/1.0; +https://prizrak.im)';

/** Первая ссылка в тексте (с отрезанной хвостовой пунктуацией) или null. */
export function firstUrl(text) {
  const m = String(text || '').match(LINK_RE);
  if (!m) return null;
  let url = m[0];
  const tail = (url.match(/[).,!?;:»”"']+$/) || [''])[0];
  if (tail) url = url.slice(0, url.length - tail.length);
  if (/^www\./i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Не ходим по внутренним адресам: незачем сканировать чужую локалку.
    const h = u.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h) || !h.includes('.')) return null;
    return u.toString();
  } catch { return null; }
}

// HTML-сущности: именованные (частые в заголовках сайтов) + числовые dec/hex.
const NAMED = {
  quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘',
  rsquo: '’', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  deg: '°', times: '×', euro: '€', pound: '£', shy: '', amp: '&',
};
const decodeEntities = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&([a-z]+);/gi, (m, name) => {
    const v = NAMED[name.toLowerCase()];
    return v === undefined ? m : v;      // неизвестную сущность оставляем как есть
  });

/** Достать <meta> по property/name (og:title, description, …). */
function meta(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${k}["'][^>]*>`, 'i');
  const tag = (html.match(re) || [])[0];
  if (!tag) return '';
  const val = tag.match(/content\s*=\s*["']([^"']*)["']/i) || tag.match(/content\s*=\s*([^\s>]+)/i);
  return val ? decodeEntities(val[1]).trim() : '';
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s || '');

/**
 * Собрать превью для ссылки. Возвращает {url, site, title, desc, image} или null.
 * fetchImpl/imageThumb подставляет платформа (у мобилки свой ресайз картинок).
 */
export async function buildLinkPreview(rawUrl, { fetchImpl, makeThumb } = {}) {
  const url = firstUrl(rawUrl);
  if (!url) return null;
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return null;

  let html = '';
  let finalUrl = url;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_MS);
    const res = await f(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
    clearTimeout(t);
    if (!res.ok) return null;
    finalUrl = res.url || url;
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!ctype.includes('html')) return null;         // картинки/файлы не превьюим
    const text = await res.text();
    html = text.slice(0, MAX_HTML);
  } catch { return null; }

  const host = (() => { try { return new URL(finalUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const title = clip(meta(html, 'og:title') || meta(html, 'twitter:title')
    || decodeEntities(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()), 120);
  const desc = clip(meta(html, 'og:description') || meta(html, 'twitter:description') || meta(html, 'description'), 220);
  const site = clip(meta(html, 'og:site_name') || host, 60);
  if (!title && !desc) return null;                    // пустышку не шлём

  const preview = { url: finalUrl, site, title, desc };

  // Картинка — необязательна: нет или слишком тяжёлая → карточка без неё.
  let imgUrl = meta(html, 'og:image') || meta(html, 'og:image:url') || meta(html, 'twitter:image');
  if (imgUrl) {
    try {
      const abs = new URL(imgUrl, finalUrl).toString();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_MS);
      const r = await f(abs, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': UA } });
      clearTimeout(t);
      if (r.ok) {
        const ctype = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
        const len = Number(r.headers.get('content-length') || 0);
        if (ctype.startsWith('image/') && (!len || len <= MAX_IMG)) {
          const buf = new Uint8Array(await r.arrayBuffer());
          if (buf.length <= MAX_IMG) {
            const thumb = makeThumb ? await makeThumb(buf, ctype) : { mime: ctype, data: b64(buf) };
            if (thumb && thumb.data) preview.image = thumb;   // {mime, data(base64)}
          }
        }
      }
    } catch { /* без картинки — не беда */ }
  }
  return preview;
}

function b64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
