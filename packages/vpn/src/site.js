// site.js — «Личина»: настоящий сайт, за которым прячется дверь.
//
// Узел это НЕ замаскированный VPN, а работающий веб-ресурс со скучным
// легальным содержимым: он реально открывается в браузере, отдаёт страницы и
// картинки, индексируется. Туннель прячется за ОДНИМ из обычных endpoint'ов
// сайта (форма/загрузка). Цензор, пришедший с зондом, не находит ничего, кроме
// сайта — потому что здесь и правда только сайт.
//
// Важное свойство: обработчик сайта НЕ ЗНАЕТ про туннель. Он честно отвечает на
// любой запрос так, как ответил бы настоящий сайт. Решение «это турист или
// туннель» принимает doorman (lichina.js) ДО сайта и, если это не туннель,
// отдаёт запрос сюда без изменений. Значит поведение на зонд неотличимо от
// поведения на настоящего посетителя — разного кода нет.

const H = (s) => s; // маркер: строка это HTML

// Немного «живого» контента, чтобы сайт выглядел как сайт, а не как заглушка.
const ARTICLES = [
  { slug: 'nginx-tuning', title: 'Тонкая настройка nginx под статику', date: '2026-07-14' },
  { slug: 'sqlite-wal', title: 'Почему WAL быстрее для встроенной БД', date: '2026-06-30' },
  { slug: 'http3-notes', title: 'HTTP/3 на практике: что поменялось', date: '2026-06-02' },
  { slug: 'backup-rsync', title: 'Инкрементные бэкапы на rsync без боли', date: '2026-05-19' },
];

function page(title, bodyHtml) {
  return H(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Заметки о железе и софте</title>
<link rel="stylesheet" href="/assets/style.css"></head>
<body><header><a href="/">Заметки о железе и софте</a></header>
<main>${bodyHtml}</main>
<footer>© 2026. Личный блог. <a href="/feed.xml">RSS</a></footer></body></html>`);
}

function homeHtml() {
  const items = ARTICLES.map((a) =>
    `<li><a href="/p/${a.slug}">${a.title}</a> <time>${a.date}</time></li>`).join('');
  return page('Главная', `<h1>Последние заметки</h1><ul class="posts">${items}</ul>
<section><h2>Обратная связь</h2>
<form method="post" action="/contact/send" enctype="application/octet-stream">
<textarea name="msg" placeholder="Сообщение"></textarea>
<button type="submit">Отправить</button></form></section>`);
}

function articleHtml(slug) {
  const a = ARTICLES.find((x) => x.slug === slug);
  if (!a) return null;
  return page(a.title, `<article><h1>${a.title}</h1><time>${a.date}</time>
<p>Короткая практическая заметка. Здесь был бы длинный текст с примерами
конфигов и замерами. Содержимое не важно — важно, что страница настоящая,
кэшируется и отдаёт осмысленные байты.</p>
<pre><code>worker_processes auto;\nsendfile on;\ntcp_nopush on;</code></pre></article>`);
}

const STYLE = `body{max-width:720px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui}
header a{font-weight:600;text-decoration:none}main{margin:2rem 0}
.posts{list-style:none;padding:0}.posts li{margin:.4rem 0}time{color:#888;font-size:.85em}
textarea{width:100%;height:6rem}footer{color:#999;border-top:1px solid #eee;padding-top:1rem}`;

/**
 * Собрать сайт-личину.
 * @param {string} ingestPath — endpoint, за которым прячется дверь туннеля.
 *   Это ОБЫЧНЫЙ путь сайта (по умолчанию форма обратной связи). Для туриста и
 *   зонда он ведёт себя как настоящая форма.
 */
export function makeSite({ ingestPath = '/contact/send' } = {}) {
  const notFound = () => ({ status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, body: page('Не найдено', '<h1>404</h1><p>Страница не найдена.</p>') });

  function handle(method, path, body) {
    const p = (path || '/').split('?')[0];

    if (method === 'GET') {
      if (p === '/') return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=300' }, body: homeHtml() };
      if (p === '/assets/style.css') return { status: 200, headers: { 'content-type': 'text/css', 'cache-control': 'max-age=86400' }, body: STYLE };
      if (p === '/feed.xml') return { status: 200, headers: { 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><rss version="2.0"><channel><title>Заметки</title></channel></rss>' };
      if (p.startsWith('/p/')) { const h = articleHtml(p.slice(3)); return h ? { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=600' }, body: h } : notFound(); }
      return notFound();
    }

    if (method === 'POST' && p === ingestPath) {
      // Настоящая форма: приняла сообщение — сказала спасибо. Никаких намёков,
      // что здесь бывает что-то ещё. Именно это видит зонд, отправивший мусор.
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: page('Отправлено', '<h1>Спасибо!</h1><p>Сообщение отправлено.</p>') };
    }

    return notFound();
  }

  return { handle, ingestPath };
}
