// index.js — публичный API криптослоя Prizrak.
// Связывает OpenPGP-идентичность (identity.js) и Double Ratchet (ratchet.js)
// в удобную сессию и даёт сериализацию сообщений для передачи по сети.

import {
  createIdentity, createDeviceIdentity, publishPreKeys, verifyPreKeyBundle,
  pgpSign, pgpVerify, pgpEncrypt, pgpDecrypt, hexToBytes, fingerprintOf,
} from './identity.js';
import { x3dhInitiator, x3dhResponder, RatchetSession } from './ratchet.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { scrypt } from '@noble/hashes/scrypt';

export {
  createIdentity, createDeviceIdentity, publishPreKeys, verifyPreKeyBundle,
  pgpSign, pgpVerify, pgpEncrypt, pgpDecrypt, fingerprintOf,
};
export { RatchetSession } from './ratchet.js';
export { generateMnemonic, mnemonicToBytes, isValidMnemonic, normalizeMnemonic, mnemonicSeedHex } from './mnemonic.js';

/**
 * Alice начинает переписку с Бобом, имея его ПУБЛИЧНЫЙ prekey-bundle.
 * Bundle обязательно проверяется по OpenPGP-подписи (корень доверия).
 */
export async function startSession(aliceIdentity, bobPublicBundle) {
  await verifyPreKeyBundle(bobPublicBundle); // бросит исключение при MITM

  const bundle = {
    identityKey: hexToBytes(bobPublicBundle.identityKey),
    signedPreKey: hexToBytes(bobPublicBundle.signedPreKey),
    oneTimePreKey: bobPublicBundle.oneTimePreKeys?.[0]
      ? { id: bobPublicBundle.oneTimePreKeys[0].id, pub: hexToBytes(bobPublicBundle.oneTimePreKeys[0].pub) }
      : null,
  };

  const { sk, header } = x3dhInitiator(aliceIdentity.identityKey, bundle);
  const ratchet = RatchetSession.initiator(sk, bundle.signedPreKey);

  return {
    ratchet,
    // «prekey-конверт» — уходит в первом сообщении, чтобы Боб построил сессию
    handshake: {
      identityKey: bytesToHex(header.identityKey),
      ephemeralKey: bytesToHex(header.ephemeralKey),
      usedOtk: header.usedOtk,
    },
  };
}

/**
 * Боб принимает первое сообщение (с handshake-конвертом) и строит зеркальную сессию.
 */
export function acceptSession(bobIdentity, bobPrivateState, handshake) {
  const header = {
    identityKey: hexToBytes(handshake.identityKey),
    ephemeralKey: hexToBytes(handshake.ephemeralKey),
  };
  let otkPriv = null;
  if (handshake.usedOtk) {
    const otk = bobPrivateState.oneTimePreKeys.find((o) => o.id === handshake.usedOtk);
    if (otk) otkPriv = otk.priv;
  }
  const sk = x3dhResponder(
    bobIdentity.identityKey,
    bobPrivateState.signedPreKey,
    otkPriv,
    header,
  );
  return RatchetSession.responder(sk, bobPrivateState.signedPreKey);
}

// ── Шифрование блобов (вложения, голосовые, кадры звонка) ──────────────────
// Симметричное AEAD со случайным ключом. Ключ передаётся ПО E2E-каналу (внутри
// Double Ratchet-сообщения), поэтому сервер/relay видят только шифртекст.
export function encryptBlob(bytes, key = randomBytes(32)) {
  const nonce = randomBytes(12);
  const ciphertext = chacha20poly1305(key, nonce).encrypt(bytes);
  return { key, nonce, ciphertext };
}
export function decryptBlob(key, nonce, ciphertext) {
  return chacha20poly1305(key, nonce).decrypt(ciphertext);
}
export { bytesToHex, randomBytes, hexToBytes };

// ── Резервная копия приватных ключей (шифруется паролем) ────────────────────
// Позволяет войти на новом устройстве / после переустановки и получить ТУ ЖЕ
// личность, совпадающую с опубликованным bundle — иначе входящие сообщения не
// расшифровать («invalid tag»). Сервер хранит только шифртекст (ключ не знает).
const _te = new TextEncoder();
export function deriveKeyFromPassword(password, userId) {
  return scrypt(_te.encode(String(password)), _te.encode('prizrak/keybackup:' + userId), { N: 1 << 15, r: 8, p: 1, dkLen: 32 });
}
export function sealJSON(key, obj) {
  const nonce = randomBytes(12);
  const ct = chacha20poly1305(key, nonce).encrypt(_te.encode(JSON.stringify(obj)));
  return bytesToHex(nonce) + '.' + bytesToHex(ct);
}
export function openJSON(key, blob) {
  const [n, c] = String(blob).split('.');
  const pt = chacha20poly1305(key, hexToBytes(n)).decrypt(hexToBytes(c));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ── Сериализация сообщения для JSON/сети ───────────────────────────────────
export function serializeMessage(m) {
  return {
    header: { dh: bytesToHex(m.header.dh), pn: m.header.pn, n: m.header.n },
    nonce: bytesToHex(m.nonce),
    ciphertext: bytesToHex(m.ciphertext),
  };
}
export function deserializeMessage(o) {
  return {
    header: { dh: hexToBytes(o.header.dh), pn: o.header.pn, n: o.header.n },
    nonce: hexToBytes(o.nonce),
    ciphertext: hexToBytes(o.ciphertext),
  };
}
