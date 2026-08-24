import { firstUrl, buildLinkPreview } from '../src/link-preview.js';
import { createServer } from 'node:http';
let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++;console.log('  ✓',m);} else {fail++;console.log('  ✗',m);} };

// ── firstUrl ──
ok(firstUrl('глянь https://prizrak.im/ открывается?') === 'https://prizrak.im/', 'вытаскивает ссылку из текста');
ok(firstUrl('зайди на www.example.com,') === 'https://www.example.com/', 'www → https, хвостовая запятая отрезана');
ok(firstUrl('нет ссылок тут') === null, 'без ссылки — null');
ok(firstUrl('http://localhost:8801/x') === null, 'локалхост не превьюим');
ok(firstUrl('http://192.168.1.5/admin') === null, 'внутренняя сеть не превьюим');
ok(firstUrl('ftp://files.example.com') === null, 'не-HTTP схемы игнорируем');

// ── реальный разбор страницы ──
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082','hex');
const srv = createServer((req,res)=>{
  if (req.url === '/img.png') { res.writeHead(200,{'content-type':'image/png'}); return res.end(PNG); }
  if (req.url === '/plain')   { res.writeHead(200,{'content-type':'text/plain'}); return res.end('просто текст'); }
  if (req.url === '/empty')   { res.writeHead(200,{'content-type':'text/html'}); return res.end('<html><body>ничего</body></html>'); }
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  res.end(`<html><head>
    <title>Запасной заголовок</title>
    <meta property="og:site_name" content="Prizrak Instant Messenger"/>
    <meta property="og:title" content="Prizrak &mdash; &quot;Свобода общения&quot;"/>
    <meta property="og:description" content="Сквозное шифрование &amp; федерация"/>
    <meta property="og:image" content="/img.png"/>
  </head><body>x</body></html>`);
});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const base = 'http://127.0.0.1:' + srv.address().port;
// разрешаем локальный адрес только для теста — дергаем buildLinkPreview напрямую с обходом фильтра
const patched = async (u) => { const mod = await import('../src/link-preview.js'); return mod; };

// firstUrl режет 127.0.0.1 — проверим парсер, подсунув свой fetch и публичный URL
const fakeFetch = async (url, opts) => fetch(base + new URL(url).pathname, opts);
const p = await buildLinkPreview('https://example.com/page', { fetchImpl: fakeFetch });
ok(!!p, 'превью собралось');
ok(p && p.title === 'Prizrak — "Свобода общения"', 'og:title + HTML-сущности раскодированы');
ok(p && p.desc === 'Сквозное шифрование & федерация', 'og:description раскодирован');
ok(p && p.site === 'Prizrak Instant Messenger', 'og:site_name взят');
ok(p && p.image && p.image.mime === 'image/png' && p.image.data.length > 10, 'картинка скачана и в base64');

const p2 = await buildLinkPreview('https://example.com/empty', { fetchImpl: fakeFetch });
ok(p2 === null || (!p2.title && !p2.desc) === false, 'страница без og — берём <title> или null');

const p3 = await buildLinkPreview('https://example.com/plain', { fetchImpl: fakeFetch });
ok(p3 === null, 'не-HTML (text/plain) → null');

const p4 = await buildLinkPreview('https://example.com/x', { fetchImpl: async () => { throw new Error('нет сети'); } });
ok(p4 === null, 'сеть упала → null, отправка не ломается');

srv.close();
console.log(`\nПревью ссылок: ${pass} ок, ${fail} провалов`);
process.exit(fail?1:0);
