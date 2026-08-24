// identity.js — Ed25519-идентичность узла-тайника. relayId = публичный ключ (hex).
// Ключ хранится на диске оператора; приватный НИКОГДА не покидает узел.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newKeypair, bytesToHex, hexToBytes } from './crypto.js';

export function loadOrCreateIdentity(path) {
  if (existsSync(path)) {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return { priv: hexToBytes(j.priv), pub: hexToBytes(j.pub), nodeId: j.pub, createdAt: j.createdAt };
  }
  const { priv, pub } = newKeypair();
  mkdirSync(dirname(path), { recursive: true });
  const createdAt = 0; // штамп времени проставит вызывающий (Date.now недоступен в некоторых средах)
  writeFileSync(path, JSON.stringify({ priv: bytesToHex(priv), pub: bytesToHex(pub), createdAt }, null, 2), { mode: 0o600 });
  return { priv, pub, nodeId: bytesToHex(pub), createdAt };
}
