// dpi-analyzer.js
// ──────────────────────────────────────────────────────────────────────────
// Игрушечная модель DPI (как в ТСПУ), чтобы НАГЛЯДНО показать, что палится,
// а что нет. Настоящий DPI сложнее, но принципы детекции те же:
//   он ищет ФИКСИРОВАННЫЕ СИГНАТУРЫ и характерные структуры в первых байтах.
//
// Ключевая мысль для проекта: протоколы реального времени (STUN/DTLS/WebRTC,
// WireGuard, OpenVPN) имеют узнаваемые «магические» байты в открытом виде в
// самом начале — их DPI ловит на лету и режет. Наш stealth-транспорт таких
// сигнатур не имеет: снаружи это неотличимо от TLS-записи обычного HTTPS.
// ──────────────────────────────────────────────────────────────────────────

/** @returns {{protocol:string, flagged:boolean, reason:string}} */
export function classify(bytes) {
  const b = bytes;
  if (b.length < 2) return { protocol: 'unknown', flagged: false, reason: 'слишком короткий' };

  // STUN: первые 2 бита = 00, затем на смещении 4 — magic cookie 0x2112A442.
  // Именно так DPI опознаёт STUN/ICE и рвёт установку WebRTC-звонка.
  if ((b[0] & 0xc0) === 0 && b.length >= 8 &&
      b[4] === 0x21 && b[5] === 0x12 && b[6] === 0xa4 && b[7] === 0x42) {
    return { protocol: 'STUN/ICE (WebRTC)', flagged: true, reason: 'magic cookie 0x2112A442 в открытом виде' };
  }

  // DTLS: record type 22 (handshake) + версия 0xFEFD/0xFEFF (DTLS 1.x).
  // Так палится медиапоток WebRTC (DTLS-SRTP).
  if (b[0] === 22 && b[1] === 0xfe && (b[2] === 0xfd || b[2] === 0xff)) {
    return { protocol: 'DTLS (WebRTC media)', flagged: true, reason: 'DTLS record-type=22 + версия 0xFE**' };
  }

  // WireGuard: message type 1..4 в первом байте, затем 3 нулевых байта (reserved).
  if (b.length >= 4 && b[0] >= 1 && b[0] <= 4 && b[1] === 0 && b[2] === 0 && b[3] === 0) {
    return { protocol: 'WireGuard', flagged: true, reason: 'type + 3 reserved-нуля (фикс. заголовок)' };
  }

  // OpenVPN (tls-crypt): часто узнаётся по opcode в старших битах первого байта.
  if (b[0] === 0x38 || b[0] === 0x40) {
    return { protocol: 'OpenVPN (возможно)', flagged: true, reason: 'характерный opcode в первом байте' };
  }

  // TLS application data: type 23 (0x17) + версия 0x03 0x0X. Обычный HTTPS-трафик.
  if (b[0] === 0x17 && b[1] === 0x03) {
    return { protocol: 'TLS application data (HTTPS)', flagged: false, reason: 'обычная TLS-запись — не отличить от веб-сёрфинга' };
  }
  // TLS handshake: type 22 (0x16) + версия 0x03 0x0X.
  if (b[0] === 0x16 && b[1] === 0x03) {
    return { protocol: 'TLS handshake (HTTPS)', flagged: false, reason: 'нормальный TLS 1.x ClientHello/ServerHello' };
  }

  // Всё остальное: оценим энтропию. Высокая энтропия без сигнатуры — подозрительно
  // для эвристического DPI («неизвестный шифрованный протокол»), но не детерминированно.
  const H = shannonEntropy(b.slice(0, 64));
  if (H > 7.5) return { protocol: 'неизвестный HE-поток', flagged: true, reason: `энтропия ${H.toFixed(2)} bit/байт без известной оболочки` };
  return { protocol: 'неизвестный', flagged: false, reason: `энтропия ${H.toFixed(2)}` };
}

export function shannonEntropy(bytes) {
  if (!bytes.length) return 0;
  const freq = new Array(256).fill(0);
  for (const x of bytes) freq[x]++;
  let H = 0;
  for (const f of freq) if (f) { const p = f / bytes.length; H -= p * Math.log2(p); }
  return H;
}
