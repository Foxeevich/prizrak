// client.js — клиент Prizrak VPN.
//
// Поднимает ЛОКАЛЬНЫЙ SOCKS5-прокси (127.0.0.1:1080) и уводит всё, что в него
// приходит, в stealth-туннель до выходного узла. Для системы это обычный
// прокси — работает в браузере и любом приложении без прав root.
//
// Почему SOCKS, а не tun-устройство: на десктопе прокси не требует привилегий
// и не ломает сеть при падении. Полный «весь трафик устройства» — это Android
// VpnService / tun на десктопе, следующий этап; протокол туннеля тот же.
import net from 'node:net';
import { connectStealth } from '../../transport/src/stealth.js';
import { T, packFrame, unpackFrame, asJson } from './protocol.js';

export async function connectVpn({ host, port = 443, servername = 'www.microsoft.com', psk, ticket = null }) {
  let nextId = 1;
  const streams = new Map(); // streamId → {socket, onOpen, onFail}
  let hello = null;

  const tun = await connectStealth({
    host, port, servername, psk,
    onFrame: (payload) => {
      let f; try { f = unpackFrame(payload); } catch { return; }
      if (f.type === T.HELLO_OK) { hello && hello.resolve(asJson(f.body) || {}); return; }
      if (f.type === T.HELLO_FAIL) { hello && hello.reject(new Error((asJson(f.body) || {}).error || 'узел отказал')); return; }
      const s = streams.get(f.streamId);
      if (!s) return;
      if (f.type === T.OPEN_OK) { s.onOpen && s.onOpen(); s.onOpen = null; return; }
      if (f.type === T.OPEN_FAIL) { const e = (asJson(f.body) || {}).error || 'узел не открыл соединение'; s.onFail && s.onFail(new Error(e)); streams.delete(f.streamId); return; }
      if (f.type === T.DATA) { try { s.socket.write(Buffer.from(f.body)); } catch {} return; }
      if (f.type === T.CLOSE) { streams.delete(f.streamId); try { s.socket.end(); } catch {} return; }
    },
  });

  // Представляемся билетом (или без него — на открытых узлах).
  const info = await new Promise((resolve, reject) => {
    hello = { resolve, reject };
    tun.sendFrame(packFrame(T.HELLO, 0, ticket ? { ticket } : {}));
    setTimeout(() => reject(new Error('узел не ответил на приветствие')), 10000);
  });

  /** Открыть TCP через узел. Возвращает объект с методами write/end. */
  const open = (targetHost, targetPort, socket) => new Promise((resolve, reject) => {
    const id = nextId++;
    streams.set(id, { socket, onOpen: () => resolve(id), onFail: reject });
    tun.sendFrame(packFrame(T.OPEN, id, { host: targetHost, port: targetPort }));
    setTimeout(() => { if (streams.get(id)?.onOpen) { streams.delete(id); reject(new Error('таймаут соединения через узел')); } }, 15000);
  });

  return {
    info,
    open,
    send: (id, chunk) => tun.sendFrame(packFrame(T.DATA, id, new Uint8Array(chunk))),
    closeStream: (id) => { streams.delete(id); tun.sendFrame(packFrame(T.CLOSE, id, {})); },
    close: () => tun.close(),
  };
}

/**
 * Локальный SOCKS5 → туннель. Возвращает {port, close}.
 * Поддерживаем то, что реально нужно браузеру: CONNECT по домену или IPv4/IPv6,
 * без авторизации (слушаем только на localhost).
 */
export async function startSocksProxy({ vpn, port = 1080, host = '127.0.0.1' } = {}) {
  const server = net.createServer((client) => {
    client.once('data', (greet) => {
      // [ver=5][nmethods][methods…] → отвечаем «без авторизации»
      if (greet[0] !== 0x05) return client.destroy();
      client.write(Buffer.from([0x05, 0x00]));

      client.once('data', async (req) => {
        // [ver][cmd][rsv][atyp][addr][port]
        if (req[0] !== 0x05 || req[1] !== 0x01) { // поддерживаем только CONNECT
          client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); return client.end();
        }
        let host2, p, off;
        const atyp = req[3];
        if (atyp === 0x01) { host2 = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`; off = 8; }
        else if (atyp === 0x03) { const len = req[4]; host2 = req.subarray(5, 5 + len).toString(); off = 5 + len; }
        else if (atyp === 0x04) { const parts = []; for (let i = 0; i < 16; i += 2) parts.push(req.readUInt16BE(4 + i).toString(16)); host2 = parts.join(':'); off = 20; }
        else { client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); return client.end(); }
        p = req.readUInt16BE(off);

        let id;
        try { id = await vpn.open(host2, p, client); }
        catch { client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); return client.end(); }

        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // успех
        client.on('data', (chunk) => vpn.send(id, chunk));
        const bye = () => { try { vpn.closeStream(id); } catch {} };
        client.on('close', bye); client.on('error', bye);
      });
    });
    client.on('error', () => {});
  });

  await new Promise((r) => server.listen(port, host, r));
  return { port: server.address().port, close: () => server.close() };
}
