// rendezvous.js — «наш STUN», невидимый для ТСПУ.
// ──────────────────────────────────────────────────────────────────────────
// Публичного STUN нет: клиент шлёт один UDP-пакет (по форме — QUIC short header)
// на этот порт, а мы отвечаем, какой ПУБЛИЧНЫЙ адрес источника увидели. Это ровно
// функция STUN (server-reflexive), но нашим сервером и по виду неотличимо от QUIC.
// Никакого STUN magic-cookie на проводе — только QUIC-подобная форма.
//
// Формат пакета (1:1 с QuicMimic.java на клиенте):
//   [0]=0x40 (short header) | [1..8]=Connection ID | [9..10]=pkt num |
//   [11]=inner type (1=probe, 2=probe-ack) | [12..]=тело.
// На probe отвечаем probe-ack с телом "ip:port" источника (эхо connId — чтобы клиент
// узнал свой пакет).
// ──────────────────────────────────────────────────────────────────────────
import dgram from 'node:dgram';

const SHORT_HEADER = 0x40;
const INNER_PROBE = 1;
const INNER_PROBE_ACK = 2;

export function createRendezvous({ port = 8811, host = '0.0.0.0' } = {}) {
  const sock = dgram.createSocket('udp4');

  sock.on('message', (msg, rinfo) => {
    try {
      if (msg.length < 12) return;
      if (msg[0] !== SHORT_HEADER) return;      // не наш/не QUIC-подобный — игнор
      const innerType = msg[11];
      if (innerType !== INNER_PROBE) return;    // отвечаем только на probe
      const connId = msg.subarray(1, 9);        // эхо
      const body = Buffer.from(`${rinfo.address}:${rinfo.port}`, 'utf8');
      const out = Buffer.alloc(12 + body.length);
      out[0] = SHORT_HEADER;
      connId.copy(out, 1);
      out[9] = msg[9]; out[10] = msg[10];       // эхо pkt num
      out[11] = INNER_PROBE_ACK;
      body.copy(out, 12);
      sock.send(out, rinfo.port, rinfo.address);
    } catch { /* мусор/скан — игнорируем, не роняем сокет */ }
  });
  sock.on('error', () => {}); // не роняем процесс

  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, host, () => {
      sock.removeListener('error', reject);
      console.log(`[rendezvous] UDP reflect (наш STUN) слушает :${port}`);
      resolve({ socket: sock, port });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createRendezvous({ port: Number(process.env.PRIZRAK_RENDEZVOUS_PORT || 8811) });
}
