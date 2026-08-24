// identity.js
// ──────────────────────────────────────────────────────────────────────────
// Слой ИДЕНТИЧНОСТИ и КОРНЯ ДОВЕРИЯ.
//
// Здесь живёт OpenPGP — ровно там, где он силён: долговременный ключ личности,
// подпись, верификация и «прозрачность ключей» (key transparency).
//
// Важно понимать разделение ответственности:
//   • OpenPGP-ключ  = паспорт пользователя. Он редко меняется, публикуется,
//     его отпечаток можно сверить лично («safety number»). Им пользователь
//     ПОДПИСЫВАЕТ свои эфемерные ключи для Double Ratchet.
//   • X25519 identity-ключ + prekeys = рабочие ключи для forward-secret сессий
//     (см. ratchet.js). Они часто ротируются, но каждому из них доверяют только
//     потому, что он подписан OpenPGP-ключом-паспортом.
//
// Такой гибрид даёт то, что просил пользователь (встроенный OpenPGP с открытым/
// закрытым ключом), но чинит главную слабость «чистого PGP-мессенджера» —
// отсутствие forward secrecy — вынося сам поток сообщений в Double Ratchet.
// ──────────────────────────────────────────────────────────────────────────

import * as openpgp from 'openpgp';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

/**
 * Создать новую личность: OpenPGP-паспорт + X25519 identity-ключ.
 * @param {string} name  человекочитаемое имя
 * @param {string} userId  federated id вида @alice:example.org
 */
export async function createIdentity(name, userId) {
  // 1. OpenPGP-паспорт (Curve25519 / EdDSA). Долговременный корень доверия.
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [{ name, comment: userId }],
    format: 'armored',
  });

  // 2. X25519 identity-ключ для X3DH/Double Ratchet.
  const ikPriv = x25519.utils.randomPrivateKey();
  const ikPub = x25519.getPublicKey(ikPriv);

  return {
    name,
    userId,
    pgp: { privateKey, publicKey },        // armored строки
    identityKey: { priv: ikPriv, pub: ikPub }, // Uint8Array
    fingerprint: bytesToHex(sha256(publicKey ? new TextEncoder().encode(publicKey) : ikPub)).slice(0, 32),
  };
}

// MD1: «личность устройства» — тот же PGP-корень (паспорт, общий на всех устройствах),
// но СВЕЖИЙ X25519 identity-ключ, уникальный для этого устройства. Через publishPreKeys
// её prekeys подпишутся корневым PGP → собеседник доверяет устройству, потому что оно
// подписано известным паспортом пользователя. Аккаунт-корень остаётся в keyBackup/сид-фразе.
export function createDeviceIdentity(root) {
  const ikPriv = x25519.utils.randomPrivateKey();
  return { name: root.name, userId: root.userId, pgp: root.pgp, identityKey: { priv: ikPriv, pub: x25519.getPublicKey(ikPriv) } };
}

/**
 * Выпустить «связку prekeys»: подписанный prekey (SPK) + пачку одноразовых (OPK).
 * Каждый публичный prekey ПОДПИСАН OpenPGP-ключом — это и есть корень доверия.
 * Сервер раздаёт эти публичные bundle'ы, приватные части остаются у владельца.
 */
export async function publishPreKeys(identity, count = 10) {
  const spkPriv = x25519.utils.randomPrivateKey();
  const spkPub = x25519.getPublicKey(spkPriv);

  const signature = await pgpSign(identity.pgp.privateKey, spkPub);

  const oneTime = [];
  for (let i = 0; i < count; i++) {
    const p = x25519.utils.randomPrivateKey();
    oneTime.push({ id: bytesToHex(randomBytes(4)), priv: p, pub: x25519.getPublicKey(p) });
  }

  const publicBundle = {
    userId: identity.userId,
    pgpPublicKey: identity.pgp.publicKey,
    identityKey: bytesToHex(identity.identityKey.pub),
    signedPreKey: bytesToHex(spkPub),
    signedPreKeySignature: signature,       // OpenPGP-подпись SPK
    oneTimePreKeys: oneTime.map((o) => ({ id: o.id, pub: bytesToHex(o.pub) })),
  };

  const privateState = {
    signedPreKey: { priv: spkPriv, pub: spkPub },
    oneTimePreKeys: oneTime,
  };

  return { publicBundle, privateState };
}

/** Проверить, что prekey-bundle действительно подписан заявленным OpenPGP-ключом. */
export async function verifyPreKeyBundle(bundle) {
  const spkPub = hexToBytes(bundle.signedPreKey);
  const ok = await pgpVerify(bundle.pgpPublicKey, spkPub, bundle.signedPreKeySignature);
  if (!ok) throw new Error(`Подпись prekey от ${bundle.userId} НЕ прошла проверку — возможна атака MITM`);
  return true;
}

// ── OpenPGP detached-подпись произвольных байт ─────────────────────────────
export async function pgpSign(armoredPrivateKey, data) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
  const message = await openpgp.createMessage({ binary: data });
  const detached = await openpgp.sign({
    message,
    signingKeys: privateKey,
    detached: true,
    format: 'armored',
  });
  return detached;
}

export async function pgpVerify(armoredPublicKey, data, armoredSignature) {
  const publicKey = await openpgp.readKey({ armoredKey: armoredPublicKey });
  const signature = await openpgp.readSignature({ armoredSignature });
  const message = await openpgp.createMessage({ binary: data });
  const result = await openpgp.verify({ message, signature, verificationKeys: publicKey });
  try {
    await result.signatures[0].verified;
    return true;
  } catch {
    return false;
  }
}

/**
 * OpenPGP-шифрование «в архив»: для оффлайн-сообщений (пуш, письмо-инвайт),
 * где нет живой ратчет-сессии. Здесь классический PGP уместен.
 */
export async function pgpEncrypt(armoredRecipientPublicKey, plaintext) {
  const publicKey = await openpgp.readKey({ armoredKey: armoredRecipientPublicKey });
  const message = await openpgp.createMessage({ text: plaintext });
  return openpgp.encrypt({ message, encryptionKeys: publicKey, format: 'armored' });
}

export async function pgpDecrypt(armoredPrivateKey, armoredCiphertext) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
  const message = await openpgp.readMessage({ armoredMessage: armoredCiphertext });
  const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey });
  return data;
}

/** Отпечаток (safety-number) из armored OpenPGP-ключа. Тот же расчёт, что и у
 *  createIdentity — поэтому у собеседника он совпадёт с тем, что видит он сам. */
export function fingerprintOf(armoredPublicKey) {
  return bytesToHex(sha256(new TextEncoder().encode(armoredPublicKey))).slice(0, 32);
}

// util
export function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
