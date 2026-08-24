// ratchet.js
// ──────────────────────────────────────────────────────────────────────────
// Double Ratchet (по спецификации Signal) + X3DH-lite для инициализации.
//
// Что это даёт поверх OpenPGP:
//   • Forward secrecy — компрометация ключа сегодня не раскрывает вчерашние
//     сообщения (каждое сообщение шифруется одноразовым message key).
//   • Post-compromise security — после утечки состояние «самолечится» при
//     следующем DH-ратчете.
//
// Примитивы (все — из аудированных @noble/*):
//   DH  = X25519
//   KDF = HKDF-SHA256 (root chain), HMAC-SHA256 (symmetric chain)
//   AEAD= ChaCha20-Poly1305
//
// ⚠️  Это учебная реализация для прототипа: понятная и корректная по логике,
//     но перед продакшеном нужен независимый аудит и защита от side-channel.
// ──────────────────────────────────────────────────────────────────────────

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes, concatBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';

const enc = new TextEncoder();

// ── X3DH-lite: согласование первого общего секрета ─────────────────────────
// Инициатор (Alice) знает публичный prekey-bundle Боба (проверенный OpenPGP-подписью).
export function x3dhInitiator(aliceIK, bobBundle) {
  const ek = x25519.utils.randomPrivateKey();            // эфемерный ключ Alice
  const ekPub = x25519.getPublicKey(ek);

  const dh1 = x25519.getSharedSecret(aliceIK.priv, bobBundle.signedPreKey);
  const dh2 = x25519.getSharedSecret(ek, bobBundle.identityKey);
  const dh3 = x25519.getSharedSecret(ek, bobBundle.signedPreKey);
  let ikm = concatBytes(dh1, dh2, dh3);

  let usedOtk = null;
  if (bobBundle.oneTimePreKey) {
    const dh4 = x25519.getSharedSecret(ek, bobBundle.oneTimePreKey.pub);
    ikm = concatBytes(ikm, dh4);
    usedOtk = bobBundle.oneTimePreKey.id;
  }

  const sk = hkdf(sha256, ikm, new Uint8Array(32), enc.encode('prizrak/x3dh'), 32);
  return {
    sk,
    header: {
      identityKey: aliceIK.pub,   // чтобы Боб знал, кто инициатор
      ephemeralKey: ekPub,
      usedOtk,
    },
  };
}

// Ответчик (Bob) восстанавливает тот же секрет из своих приватных ключей.
export function x3dhResponder(bobIK, bobSPK, bobOTKpriv, header) {
  const dh1 = x25519.getSharedSecret(bobSPK.priv, header.identityKey);
  const dh2 = x25519.getSharedSecret(bobIK.priv, header.ephemeralKey);
  const dh3 = x25519.getSharedSecret(bobSPK.priv, header.ephemeralKey);
  let ikm = concatBytes(dh1, dh2, dh3);
  if (bobOTKpriv) {
    const dh4 = x25519.getSharedSecret(bobOTKpriv, header.ephemeralKey);
    ikm = concatBytes(ikm, dh4);
  }
  return hkdf(sha256, ikm, new Uint8Array(32), enc.encode('prizrak/x3dh'), 32);
}

// ── KDF для цепочек ────────────────────────────────────────────────────────
function kdfRootKey(rootKey, dhOut) {
  const out = hkdf(sha256, dhOut, rootKey, enc.encode('prizrak/root'), 64);
  return { rootKey: out.slice(0, 32), chainKey: out.slice(32, 64) };
}
function kdfChainKey(chainKey) {
  const messageKey = hmac(sha256, chainKey, Uint8Array.of(0x01));
  const nextChainKey = hmac(sha256, chainKey, Uint8Array.of(0x02));
  return { messageKey, nextChainKey };
}

// ── Double Ratchet session ─────────────────────────────────────────────────
export class RatchetSession {
  constructor() {
    this.DHs = null;          // наша текущая DH-пара {priv,pub}
    this.DHr = null;          // публичный DH-ключ собеседника
    this.RK = null;           // root key
    this.CKs = null;          // sending chain key
    this.CKr = null;          // receiving chain key
    this.Ns = 0; this.Nr = 0; // счётчики сообщений
    this.PN = 0;              // длина предыдущей sending-цепочки
    this.skipped = new Map(); // пропущенные message keys (out-of-order)
  }

  /** Инициатор: у него уже есть SK (из X3DH) и публичный SPK Боба как первый DHr. */
  static initiator(sk, bobSignedPreKeyPub) {
    const s = new RatchetSession();
    const priv = x25519.utils.randomPrivateKey();
    s.DHs = { priv, pub: x25519.getPublicKey(priv) };
    s.DHr = bobSignedPreKeyPub;
    const dh = x25519.getSharedSecret(s.DHs.priv, s.DHr);
    const { rootKey, chainKey } = kdfRootKey(sk, dh);
    s.RK = rootKey; s.CKs = chainKey;
    return s;
  }

  /** Ответчик: у него SK (из X3DH) и своя SPK-пара как стартовая DHs. */
  static responder(sk, bobSignedPreKeyPair) {
    const s = new RatchetSession();
    s.DHs = { priv: bobSignedPreKeyPair.priv, pub: bobSignedPreKeyPair.pub };
    s.RK = sk;
    return s;
  }

  encrypt(plaintext, associatedData = new Uint8Array()) {
    const { messageKey, nextChainKey } = kdfChainKey(this.CKs);
    this.CKs = nextChainKey;
    const header = { dh: this.DHs.pub, pn: this.PN, n: this.Ns };
    this.Ns += 1;

    const nonce = randomBytes(12);
    const aead = chacha20poly1305(messageKey, nonce, associatedData);
    const ct = aead.encrypt(enc.encode(plaintext));
    return { header, nonce, ciphertext: ct };
  }

  decrypt(message, associatedData = new Uint8Array()) {
    const { header, nonce, ciphertext } = message;

    // Попытка из пропущенных ключей (out-of-order доставка)
    const skippedKey = this._trySkipped(header, nonce, ciphertext, associatedData);
    if (skippedKey) return skippedKey;

    // Новый DH-ключ собеседника ⇒ DH-ратчет
    if (!this.DHr || !bytesEqual(header.dh, this.DHr)) {
      this._skipMessageKeys(header.pn);
      this._dhRatchet(header);
    }
    this._skipMessageKeys(header.n);

    const { messageKey, nextChainKey } = kdfChainKey(this.CKr);
    this.CKr = nextChainKey; this.Nr += 1;
    const aead = chacha20poly1305(messageKey, nonce, associatedData);
    return new TextDecoder().decode(aead.decrypt(ciphertext));
  }

  _dhRatchet(header) {
    this.PN = this.Ns; this.Ns = 0; this.Nr = 0;
    this.DHr = header.dh;
    let dh = x25519.getSharedSecret(this.DHs.priv, this.DHr);
    let r = kdfRootKey(this.RK, dh);
    this.RK = r.rootKey; this.CKr = r.chainKey;
    const priv = x25519.utils.randomPrivateKey();
    this.DHs = { priv, pub: x25519.getPublicKey(priv) };
    dh = x25519.getSharedSecret(this.DHs.priv, this.DHr);
    r = kdfRootKey(this.RK, dh);
    this.RK = r.rootKey; this.CKs = r.chainKey;
  }

  _skipMessageKeys(until) {
    if (this.CKr == null) return;
    while (this.Nr < until) {
      const { messageKey, nextChainKey } = kdfChainKey(this.CKr);
      this.skipped.set(`${bytesToHexShort(this.DHr)}:${this.Nr}`, messageKey);
      this.CKr = nextChainKey; this.Nr += 1;
    }
  }

  // ── Сериализация состояния (для сохранения входа/сессий на диск) ──────────
  serialize() {
    const hx = (b) => (b ? bytesToHex(b) : null);
    const skipped = {};
    for (const [k, v] of this.skipped) skipped[k] = bytesToHex(v);
    return {
      DHs: this.DHs ? { priv: hx(this.DHs.priv), pub: hx(this.DHs.pub) } : null,
      DHr: hx(this.DHr), RK: hx(this.RK), CKs: hx(this.CKs), CKr: hx(this.CKr),
      Ns: this.Ns, Nr: this.Nr, PN: this.PN, skipped,
    };
  }
  static fromJSON(o) {
    const s = new RatchetSession();
    const b = (h) => (h ? hexToBytes(h) : null);
    s.DHs = o.DHs ? { priv: b(o.DHs.priv), pub: b(o.DHs.pub) } : null;
    s.DHr = b(o.DHr); s.RK = b(o.RK); s.CKs = b(o.CKs); s.CKr = b(o.CKr);
    s.Ns = o.Ns; s.Nr = o.Nr; s.PN = o.PN;
    s.skipped = new Map(Object.entries(o.skipped || {}).map(([k, v]) => [k, hexToBytes(v)]));
    return s;
  }

  _trySkipped(header, nonce, ciphertext, ad) {
    const key = `${bytesToHexShort(header.dh)}:${header.n}`;
    const mk = this.skipped.get(key);
    if (!mk) return null;
    this.skipped.delete(key);
    const aead = chacha20poly1305(mk, nonce, ad);
    return new TextDecoder().decode(aead.decrypt(ciphertext));
  }
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function bytesToHexShort(b) {
  let s = ''; for (let i = 0; i < Math.min(b.length, 8); i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
