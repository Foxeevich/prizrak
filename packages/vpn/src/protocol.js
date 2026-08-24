// protocol.js — мультиплексор потоков внутри одного stealth-туннеля.
//
// Внутри туннеля живут десятки TCP-соединений сразу (вкладки браузера,
// приложения). Каждое — «поток» со своим id. На проводе это по-прежнему
// один TLS-канал: DPI видит обычный HTTPS к одному хосту.
//
// Кадр: [1 байт тип][4 байта streamId][полезная нагрузка]
// Полезная нагрузка у служебных кадров — JSON, у DATA — сырые байты.

export const T = {
  HELLO: 0x01,      // клиент → узел: билет доступа
  HELLO_OK: 0x02,   // узел → клиент: пустил, лимиты
  HELLO_FAIL: 0x03, // узел → клиент: причина отказа
  OPEN: 0x10,       // клиент → узел: открыть TCP на host:port
  OPEN_OK: 0x11,
  OPEN_FAIL: 0x12,
  DATA: 0x20,       // в обе стороны: байты потока
  CLOSE: 0x30,      // в обе стороны: поток закрыт
  PING: 0x40,
  PONG: 0x41,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export function packFrame(type, streamId, payload) {
  const body = payload == null ? new Uint8Array(0)
    : (payload instanceof Uint8Array ? payload : enc.encode(typeof payload === 'string' ? payload : JSON.stringify(payload)));
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, streamId >>> 0);
  out.set(body, 5);
  return out;
}

export function unpackFrame(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 5) throw new Error('короткий кадр');
  return {
    type: u8[0],
    streamId: new DataView(u8.buffer, u8.byteOffset).getUint32(1),
    body: u8.subarray(5),
  };
}

export const asJson = (body) => { try { return JSON.parse(dec.decode(body)); } catch { return null; } };
export const asText = (body) => dec.decode(body);
