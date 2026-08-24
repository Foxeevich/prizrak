// socks-rn.js — локальный SOCKS5 на React Native (react-native-tcp-socket).
// К нему подключается нативный tun2socks (hev-socks5-tunnel) и льёт весь трафик
// устройства; мы на каждое соединение поднимаем цепочку relay→exit.

import TcpSocket from 'react-native-tcp-socket';
import {openTunnel} from './client-tunnel-rn.js';

const u8 = b => (b instanceof Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

export function createSocks({order, relay, exit, host = '127.0.0.1', port = 10808, log = () => {}}) {
  // Ордер Банка (реле+выход внутри). В прямом режиме без Банка принимаем relay+exit.
  const ord = order || {relay, exit};
  const stats = {active: 0, total: 0, failed: 0};

  const server = TcpSocket.createServer(client => {
    client.on('error', () => {});
    let stage = 0;
    const onSetup = data => {
      const b = u8(data);
      if (stage === 0) {                       // приветствие SOCKS5
        if (b[0] !== 0x05) { try { client.destroy(); } catch {} return; }
        client.write(Buffer.from([0x05, 0x00]));
        stage = 1;
        return;
      }
      if (stage === 1) {                       // запрос CONNECT
        if (b[0] !== 0x05 || b[1] !== 0x01) { reply(client, 0x07); return; }
        const atyp = b[3];
        let dhost, off;
        if (atyp === 0x01) { dhost = `${b[4]}.${b[5]}.${b[6]}.${b[7]}`; off = 8; }
        else if (atyp === 0x03) { const len = b[4]; dhost = Buffer.from(b.slice(5, 5 + len)).toString('utf8'); off = 5 + len; }
        else { reply(client, 0x08); return; }
        const dport = (b[off] << 8) | b[off + 1];
        stage = 2;
        stats.total++;
        client.removeListener('data', onSetup);
        openTunnel({order: ord, dest: {host: dhost, port: dport}})
          .then(tun => {
            stats.active++;
            reply(client, 0x00);
            // Backpressure: не тянем из реле быстрее, чем клиент успевает принять.
            // Иначе на скачивании JS-поток захлёбывается буферами → приложение виснет.
            const HWM = 512 * 1024, LWM = 128 * 1024;
            let inflight = 0, paused = false;
            tun.onData(bytes => {
              const buf = Buffer.from(bytes);
              inflight += buf.length;
              if (inflight > HWM && !paused) { paused = true; try { tun.pause(); } catch {} }
              try {
                client.write(buf, undefined, () => {
                  inflight -= buf.length;
                  if (paused && inflight <= LWM) { paused = false; try { tun.resume(); } catch {} }
                });
              } catch { inflight -= buf.length; }
            });
            tun.onClose(() => { stats.active = Math.max(0, stats.active - 1); try { client.destroy(); } catch {} });
            // Аплоад: если реле не успевает — притормаживаем чтение с клиента.
            client.on('data', (d) => {
              const ok = tun.write(u8(d));
              if (ok === false) { try { client.pause(); } catch {} }
            });
            if (tun.onDrain) tun.onDrain(() => { try { client.resume(); } catch {} });
            client.on('close', () => tun.close());
            client.on('error', () => tun.close());
          })
          .catch(e => { stats.failed++; log('туннель не поднялся: ' + e.message); reply(client, 0x05); });
      }
    };
    client.on('data', onSetup);
  });

  function reply(client, code) {
    try { client.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch {}
    if (code !== 0x00) { try { client.destroy(); } catch {} }
  }

  return {
    server, stats, port,
    listen: cb => server.listen({port, host}, cb),
    close: cb => { try { server.close(cb); } catch { cb && cb(); } },
  };
}
