// shadow.js — «Тень»: ядро протокола Prizrak VPN.
//
// ГЛАВНЫЙ ПРИНЦИП: криптографию не изобретаем — изобретаем упаковку.
// Примитивы взяты проверенные (X25519 / ChaCha20-Poly1305 / HKDF-SHA256),
// шаблон рукопожатия — Noise NK (разобранный криптографами). Своё у нас то,
// что видно на проводе: фрейминг, паддинг, отсутствие любых магических байтов.
//
// Noise NK, если коротко:
//   N — у клиента НЕТ постоянного ключа (он анонимен для узла);
//   K — постоянный ключ узла клиент знает заранее (приходит вместе со ссылкой).
// Даёт: прямую секретность, аутентификацию узла, анонимность клиента, 1 круг.
//
//   клиент → узел:  e, es                (эфемер + метка времени/nonce)
//   узел → клиенту: e, ee                (эфемер узла)
//   дальше — поток, зашифрованный разными ключами в каждую сторону.
//
// Защита от повтора: в первом сообщении метка времени и одноразовое число.
// Узел держит окно свежести и помнит уже виденные числа — записанный
// цензором хендшейк переиграть нельзя.
import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes, bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

const utf8 = (s) => new TextEncoder().encode(s);
const PROTO = 'prizrak/shadow/v1';

// Свежесть хендшейка: ±90 секунд. Шире — растёт окно для повтора, уже —
// ломаются клиенты с плывущими часами.
export const FRESH_WINDOW_SEC = 90;
// Перемотка ключей: по объёму и по времени, что раньше.
export const REKEY_BYTES = 64 * 1024 * 1024;
export const REKEY_MS = 10 * 60 * 1000;

const kdf = (secret, info, len = 32) => hkdf(sha256, secret, utf8(PROTO), utf8(info), len);

/** Пара ключей узла. Публичный отдаём клиентам вместе со ссылкой. */
export function generateNodeKeys() {
  const priv = x25519.utils.randomPrivateKey();
  return { privateKey: bytesToHex(priv), publicKey: bytesToHex(x25519.getPublicKey(priv)) };
}

// ── Шифрованный поток с перемоткой ключей ────────────────────────────────────
// Nonce = 4 байта соли из рукопожатия + 8 байт счётчика: повторов не бывает
// по построению, а соль разводит потоки разных сессий.
class Cipher {
  constructor(key, salt) { this.key = key; this.salt = salt; this.seq = 0n; this.bytes = 0; this.since = Date.now(); this.epoch = 0; }
  _nonce() {
    const n = new Uint8Array(12);
    n.set(this.salt, 0);
    new DataView(n.buffer).setBigUint64(4, this.seq);
    return n;
  }
  // Перемотка: новый ключ выводим из текущего — старый трафик назад не расшифровать.
  _maybeRekey() {
    if (this.bytes < REKEY_BYTES && Date.now() - this.since < REKEY_MS) return false;
    this.key = kdf(this.key, 'rekey/' + (++this.epoch));
    this.seq = 0n; this.bytes = 0; this.since = Date.now();
    return true;
  }
  seal(plain) {
    const rekeyed = this._maybeRekey();
    const n = this._nonce();
    const ct = chacha20poly1305(this.key, n).encrypt(plain);
    this.seq++; this.bytes += plain.length;
    return { ct, rekeyed };
  }
  open(ct) {
    this._maybeRekey();
    const n = this._nonce();
    const pt = chacha20poly1305(this.key, n).decrypt(ct);
    this.seq++; this.bytes += pt.length;
    return pt;
  }
}

// ── Рукопожатие ──────────────────────────────────────────────────────────────

/**
 * Клиент: первое сообщение. Возвращает {message, state}.
 * message — то, что уходит на провод (внутри несущей: тело POST и т.п.).
 * Никаких магических байтов: это просто 32 байта эфемерного ключа + шифртекст.
 */
export function clientHandshake(nodePubHex, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const nodePub = hexToBytes(nodePubHex);
  const ePriv = x25519.utils.randomPrivateKey();
  const ePub = x25519.getPublicKey(ePriv);
  const es = x25519.getSharedSecret(ePriv, nodePub);

  // Ключ первого сообщения привязан к эфемеру: подменить его нельзя.
  const k0 = kdf(concatBytes(es, ePub), 'msg0');
  const nonce16 = randomBytes(16);
  const inner = new Uint8Array(8 + 16);
  new DataView(inner.buffer).setBigUint64(0, BigInt(nowSec));
  inner.set(nonce16, 8);
  const ct = chacha20poly1305(k0, new Uint8Array(12)).encrypt(inner);

  return {
    message: concatBytes(ePub, ct),
    state: { ePriv, ePub, es, nonce: bytesToHex(nonce16) },
  };
}

/**
 * Узел: разбирает первое сообщение и отвечает.
 * seen — хранилище использованных nonce (Map nonceHex → сек). Повтор отвергаем.
 * Возвращает {ok:false, reason} — и тогда узел молча отдаёт НАСТОЯЩИЙ сайт,
 * никаких «ошибка авторизации» наружу.
 */
export function nodeHandshake(nodePrivHex, message, { seen = new Map(), nowSec = Math.floor(Date.now() / 1000) } = {}) {
  try {
    if (!message || message.length < 32 + 16) return { ok: false, reason: 'короткое сообщение' };
    const ePub = message.subarray(0, 32);
    const ct = message.subarray(32);
    const es = x25519.getSharedSecret(hexToBytes(nodePrivHex), ePub);
    const k0 = kdf(concatBytes(es, ePub), 'msg0');

    let inner;
    try { inner = chacha20poly1305(k0, new Uint8Array(12)).decrypt(ct); }
    catch { return { ok: false, reason: 'не расшифровалось (не наш клиент)' }; }
    if (inner.length !== 24) return { ok: false, reason: 'битая структура' };

    const ts = Number(new DataView(inner.buffer, inner.byteOffset).getBigUint64(0));
    if (Math.abs(nowSec - ts) > FRESH_WINDOW_SEC) return { ok: false, reason: 'несвежий хендшейк' };

    const nonceHex = bytesToHex(inner.subarray(8, 24));
    if (seen.has(nonceHex)) return { ok: false, reason: 'повтор записанного хендшейка' };
    seen.set(nonceHex, nowSec);
    // Чистим протухшие, чтобы карта не росла бесконечно.
    if (seen.size > 10000) for (const [k, t] of seen) if (nowSec - t > FRESH_WINDOW_SEC * 2) seen.delete(k);

    // Ответ: свой эфемер. Общий секрет = es + ee.
    const rPriv = x25519.utils.randomPrivateKey();
    const rPub = x25519.getPublicKey(rPriv);
    const ee = x25519.getSharedSecret(rPriv, ePub);
    const root = kdf(concatBytes(es, ee), 'root');
    const salt = kdf(root, 'salt', 4);

    return {
      ok: true,
      reply: rPub,
      session: makeSession(root, salt, /* isNode */ true),
      clientNonce: nonceHex,
    };
  } catch (e) {
    return { ok: false, reason: 'сбой разбора' };
  }
}

/** Клиент: получил ответ узла — достраивает сессию. */
export function clientComplete(state, reply) {
  if (!reply || reply.length !== 32) throw new Error('некорректный ответ узла');
  const ee = x25519.getSharedSecret(state.ePriv, reply);
  const root = kdf(concatBytes(state.es, ee), 'root');
  const salt = kdf(root, 'salt', 4);
  return makeSession(root, salt, /* isNode */ false);
}

// Разные ключи в каждую сторону: компрометация одного не вскрывает встречный поток.
function makeSession(root, salt, isNode) {
  const c2n = new Cipher(kdf(root, 'c2n'), salt);
  const n2c = new Cipher(kdf(root, 'n2c'), salt);
  const out = isNode ? n2c : c2n;
  const inb = isNode ? c2n : n2c;
  return {
    /** Зашифровать кадр для отправки. */
    seal: (plain) => out.seal(plain).ct,
    /** Расшифровать принятый кадр. */
    open: (ct) => inb.open(ct),
    /** Диагностика: сколько прокачано и сколько раз перематывали ключи. */
    stats: () => ({ outBytes: out.bytes, inBytes: inb.bytes, outEpoch: out.epoch, inEpoch: inb.epoch }),
  };
}
