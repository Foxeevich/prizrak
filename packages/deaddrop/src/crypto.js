// crypto.js — крипто-примитивы узла-тайника. Согласовано с будущими homeserver'ами:
// эти форматы (msgId, mailbox, ACK) — часть спецификации сети тайников.
//
//  • msgId   = BLAKE3(ciphertext)                       — контент-адрес блоба (дедуп).
//  • mailbox = HKDF-SHA256(recipientPub, salt, epoch)   — «слепой ящик»: узел НЕ знает домен
//              получателя, только непрозрачный меняющийся токен.
//  • ACK     = Ed25519-подпись получателя над "…:msgId" — единственный пруф доставки; только
//              владелец recipientPub (тот, чей это ящик) может авторизовать удаление блоба.
import { ed25519 } from '@noble/curves/ed25519';
import { blake3 } from '@noble/hashes/blake3';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';

export { bytesToHex, hexToBytes, randomBytes };

export function newKeypair() {
  const priv = randomBytes(32);
  const pub = ed25519.getPublicKey(priv);
  return { priv, pub };
}
export function sign(priv, msgBytes) { return ed25519.sign(msgBytes, priv); }
export function verify(pubBytes, sigBytes, msgBytes) {
  try { return ed25519.verify(sigBytes, msgBytes, pubBytes); } catch { return false; }
}

/** Контент-адрес блоба: BLAKE3(ciphertext) → hex (32 байта). */
export function msgIdOf(ciphertext) { return bytesToHex(blake3(ciphertext)); }

// «Слепой почтовый ящик» получателя.
const MB_SALT = utf8ToBytes('prizrak/deaddrop/mailbox/v1');
export function mailboxOf(recipientPubHex, epoch) {
  const info = utf8ToBytes('epoch:' + String(epoch));
  return bytesToHex(hkdf(sha256, hexToBytes(recipientPubHex), MB_SALT, info, 16));
}

// Код привязки узла к аккаунту оператора (Фаза 7): подпись узла над (relayId + userId).
// Оператор берёт этот код на локальной /status и вставляет в приложении → банк проверяет и
// начисляет призраки его аккаунту. Привязка к userId в подписи не даёт «угнать» узел.
export function nodeClaimMsg(relayId, userId) { return utf8ToBytes('prizrak/dd/node-claim/v1:' + relayId + ':' + userId); }
export function signNodeClaim(priv, relayId, userId) { return bytesToHex(sign(priv, nodeClaimMsg(relayId, userId))); }

// Подписанный получателем ACK — пруф доставки (авторизует удаление блоба на узлах).
function ackMessage(msgId) { return utf8ToBytes('prizrak/dd/ack/v1:' + msgId); }
export function signAck(recipientPriv, msgId) { return bytesToHex(sign(recipientPriv, ackMessage(msgId))); }
export function verifyAck(recipientPubHex, msgId, sigHex) {
  try { return verify(hexToBytes(recipientPubHex), hexToBytes(sigHex), ackMessage(msgId)); } catch { return false; }
}
