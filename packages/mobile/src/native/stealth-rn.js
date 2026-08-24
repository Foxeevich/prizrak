// connectStealth для React Native — поверх react-native-tcp-socket (TLS).
// Эквивалент packages/transport/src/stealth.js connectStealth, но на нативном
// TCP/TLS-сокете телефона. Формат кадров и auth-токен идентичны десктопу.
import TcpSocket from 'react-native-tcp-socket';
import {Buffer} from 'buffer';
import {frameKey, authToken, encodeFrame, makeFrameDecoder} from './stealth-frame';

export function connectStealth({host, port, servername, psk, onFrame}) {
  const key = frameKey(psk);
  const AUTH = authToken(psk);
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    try {
      socket = TcpSocket.connectTLS(
        {
          host,
          port: Number(port),
          servername: servername || undefined,
          rejectUnauthorized: false, // relay использует самоподписанный сертификат
        },
        () => {
          // TLS поднят → шлём скрытый auth-токен, дальше — кадры.
          socket.write(Buffer.from(AUTH));
          const decode = makeFrameDecoder(key, payload => {
            try {
              onFrame && onFrame(payload);
            } catch {}
          });
          socket.on('data', data => {
            // react-native-tcp-socket отдаёт Buffer или base64-строку.
            const u8 =
              typeof data === 'string'
                ? new Uint8Array(Buffer.from(data, 'base64'))
                : new Uint8Array(data);
            try {
              decode(u8);
            } catch {}
          });
          settled = true;
          resolve({
            sendFrame: payload =>
              socket.write(Buffer.from(encodeFrame(key, payload))),
            close: () => {
              try {
                socket.destroy();
              } catch {}
            },
            socket,
          });
        },
      );
      socket.on('error', e => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    } catch (e) {
      if (!settled) reject(e);
    }
  });
}
