// http-site.js — отдать сайт-личину как обычный HTTP/1.1-ответ прямо в сокет.
// Зонд/браузер, постучавшийся GET'ом, видит настоящий сайт и уходит.

export function serveSiteRaw(socket, site, path = '/') {
  try {
    const r = site.handle('GET', path, null);
    const body = Buffer.from(r.body || '', 'utf8');
    const head = [
      `HTTP/1.1 ${r.status || 200} ${r.status === 404 ? 'Not Found' : 'OK'}`,
      `content-type: ${(r.headers && r.headers['content-type']) || 'text/html; charset=utf-8'}`,
      `content-length: ${body.length}`,
      'connection: close',
      'server: nginx',
      '', '',
    ].join('\r\n');
    socket.write(head);
    socket.write(body);
    socket.end();
  } catch { try { socket.end(); } catch {} }
}
