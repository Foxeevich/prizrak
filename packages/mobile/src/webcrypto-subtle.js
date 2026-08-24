// Полифилл WebCrypto (crypto.subtle) для React Native / Hermes на базе @noble.
// Hermes не имеет WebCrypto, а браузерная сборка openpgp требует его. Реализуем
// ровно тот набор операций, который использует openpgp в сценариях Prizrak
// (выяснено «шпионом»): digest SHA-1/256/512, AES-CBC (PKCS#7 как в WebCrypto),
// AES-KW wrap/unwrap, AES-GCM (на будущее), HMAC, Ed25519 (gen/sign/verify),
// X25519 (gen/deriveBits), import/export raw+jwk.
import {sha256, sha512} from '@noble/hashes/sha2';
import {sha1} from '@noble/hashes/sha1';
import {hmac} from '@noble/hashes/hmac';
import {cbc, gcm, aeskw} from '@noble/ciphers/aes';
import {ed25519, x25519} from '@noble/curves/ed25519';

// ── Утилиты ────────────────────────────────────────────────────────────────
const toU8 = d => {
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  throw new TypeError('BufferSource expected');
};
const toAB = u8 => u8.slice().buffer; // отдаём копию как ArrayBuffer (семантика WebCrypto)
const algName = a => String(typeof a === 'string' ? a : (a && a.name) || '').toUpperCase();
const hashName = a => algName(a && a.hash ? a.hash : a);

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64urlEncode(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 3) {
    const n = (u8[i] << 16) | ((u8[i + 1] || 0) << 8) | (u8[i + 2] || 0);
    s += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] +
      (i + 1 < u8.length ? B64URL[(n >> 6) & 63] : '') +
      (i + 2 < u8.length ? B64URL[n & 63] : '');
  }
  return s;
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = (typeof atob === 'function') ? atob(s) : Buffer.from(s, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── CryptoKey (упрощённый) ─────────────────────────────────────────────────
class PolyCryptoKey {
  constructor(type, algorithm, extractable, usages, raw) {
    this.type = type;                 // 'secret' | 'private' | 'public'
    this.algorithm = algorithm;       // { name, ... }
    this.extractable = extractable;
    this.usages = usages || [];
    this._raw = raw;                  // Uint8Array (для private EC — seed/scalar)
  }
}

function hashFn(name) {
  switch (name) {
    case 'SHA-1': return sha1;
    case 'SHA-256': return sha256;
    case 'SHA-512': return sha512;
    default: throw new Error('Unsupported hash: ' + name);
  }
}

// ── subtle ─────────────────────────────────────────────────────────────────
export const subtle = {
  async digest(alg, data) {
    return toAB(hashFn(algName(alg))(toU8(data)));
  },

  async importKey(format, keyData, algorithm, extractable, usages) {
    const name = algName(algorithm);
    if (format === 'raw') {
      const raw = toU8(keyData).slice();
      if (name === 'HMAC') {
        return new PolyCryptoKey('secret', {name: 'HMAC', hash: {name: hashName(algorithm)}}, extractable, usages, raw);
      }
      if (name === 'AES-CBC' || name === 'AES-KW' || name === 'AES-GCM') {
        return new PolyCryptoKey('secret', {name, length: raw.length * 8}, extractable, usages, raw);
      }
      if (name === 'ED25519') return new PolyCryptoKey('public', {name: 'Ed25519'}, extractable, usages, raw);
      if (name === 'X25519') return new PolyCryptoKey('public', {name: 'X25519'}, extractable, usages, raw);
      throw new Error('importKey raw: unsupported ' + name);
    }
    if (format === 'jwk') {
      const jwk = keyData;
      if (jwk.kty === 'OKP' && (jwk.crv === 'Ed25519' || jwk.crv === 'X25519')) {
        const isPriv = !!jwk.d;
        const raw = isPriv ? b64urlDecode(jwk.d) : b64urlDecode(jwk.x);
        return new PolyCryptoKey(isPriv ? 'private' : 'public', {name: jwk.crv}, extractable, usages, raw);
      }
      if (jwk.kty === 'oct') { // симметричный ключ в JWK
        const raw = b64urlDecode(jwk.k);
        if (name === 'HMAC') return new PolyCryptoKey('secret', {name: 'HMAC', hash: {name: hashName(algorithm)}}, extractable, usages, raw);
        return new PolyCryptoKey('secret', {name, length: raw.length * 8}, extractable, usages, raw);
      }
      throw new Error('importKey jwk: unsupported kty ' + jwk.kty);
    }
    throw new Error('importKey: unsupported format ' + format);
  },

  async exportKey(format, key) {
    const name = algName(key.algorithm);
    if (format === 'raw') {
      if (name === 'ED25519' && key.type === 'private') return toAB(ed25519.getPublicKey(key._raw));
      if (name === 'X25519' && key.type === 'private') return toAB(x25519.getPublicKey(key._raw));
      return toAB(key._raw);
    }
    if (format === 'jwk') {
      if (name === 'ED25519' || name === 'X25519') {
        const crv = name === 'ED25519' ? 'Ed25519' : 'X25519';
        const pub = key.type === 'private'
          ? (crv === 'Ed25519' ? ed25519.getPublicKey(key._raw) : x25519.getPublicKey(key._raw))
          : key._raw;
        const jwk = {kty: 'OKP', crv, x: b64urlEncode(pub), ext: true};
        if (key.type === 'private') jwk.d = b64urlEncode(key._raw);
        return jwk;
      }
      return {kty: 'oct', k: b64urlEncode(key._raw), ext: true};
    }
    throw new Error('exportKey: unsupported format ' + format);
  },

  async generateKey(algorithm, extractable, usages) {
    const name = algName(algorithm);
    if (name === 'ED25519') {
      const priv = ed25519.utils.randomPrivateKey();
      return {
        privateKey: new PolyCryptoKey('private', {name: 'Ed25519'}, extractable, ['sign'], priv),
        publicKey: new PolyCryptoKey('public', {name: 'Ed25519'}, true, ['verify'], ed25519.getPublicKey(priv)),
      };
    }
    if (name === 'X25519') {
      const priv = x25519.utils.randomPrivateKey();
      return {
        privateKey: new PolyCryptoKey('private', {name: 'X25519'}, extractable, ['deriveBits', 'deriveKey'], priv),
        publicKey: new PolyCryptoKey('public', {name: 'X25519'}, true, [], x25519.getPublicKey(priv)),
      };
    }
    if (name === 'HMAC') {
      const raw = crypto.getRandomValues(new Uint8Array(64));
      return new PolyCryptoKey('secret', {name: 'HMAC', hash: {name: hashName(algorithm)}}, extractable, usages, raw);
    }
    if (name === 'AES-CBC' || name === 'AES-KW' || name === 'AES-GCM') {
      const raw = crypto.getRandomValues(new Uint8Array((algorithm.length || 256) / 8));
      return new PolyCryptoKey('secret', {name, length: raw.length * 8}, extractable, usages, raw);
    }
    throw new Error('generateKey: unsupported ' + name);
  },

  async sign(algorithm, key, data) {
    const name = algName(algorithm.name ? algorithm : key.algorithm);
    if (name === 'ED25519') return toAB(ed25519.sign(toU8(data), key._raw));
    if (name === 'HMAC') return toAB(hmac(hashFn(hashName(key.algorithm)), key._raw, toU8(data)));
    throw new Error('sign: unsupported ' + name);
  },

  async verify(algorithm, key, signature, data) {
    const name = algName(algorithm.name ? algorithm : key.algorithm);
    if (name === 'ED25519') {
      try { return ed25519.verify(toU8(signature), toU8(data), key._raw); } catch { return false; }
    }
    if (name === 'HMAC') {
      const mac = hmac(hashFn(hashName(key.algorithm)), key._raw, toU8(data));
      const sig = toU8(signature);
      if (mac.length !== sig.length) return false;
      let diff = 0; for (let i = 0; i < mac.length; i++) diff |= mac[i] ^ sig[i];
      return diff === 0;
    }
    throw new Error('verify: unsupported ' + name);
  },

  async deriveBits(algorithm, baseKey, length) {
    const name = algName(algorithm);
    if (name === 'X25519') {
      const pub = algorithm.public; // PolyCryptoKey
      const shared = x25519.getSharedSecret(baseKey._raw, pub._raw);
      const n = length == null ? shared.length : Math.ceil(length / 8);
      return toAB(shared.slice(0, n));
    }
    throw new Error('deriveBits: unsupported ' + name);
  },

  async encrypt(algorithm, key, data) {
    const name = algName(algorithm);
    if (name === 'AES-CBC') return toAB(cbc(key._raw, toU8(algorithm.iv)).encrypt(toU8(data))); // PKCS#7 как WebCrypto
    if (name === 'AES-GCM') {
      const aad = algorithm.additionalData ? toU8(algorithm.additionalData) : undefined;
      return toAB(gcm(key._raw, toU8(algorithm.iv), aad).encrypt(toU8(data)));
    }
    throw new Error('encrypt: unsupported ' + name);
  },

  async decrypt(algorithm, key, data) {
    const name = algName(algorithm);
    if (name === 'AES-CBC') return toAB(cbc(key._raw, toU8(algorithm.iv)).decrypt(toU8(data)));
    if (name === 'AES-GCM') {
      const aad = algorithm.additionalData ? toU8(algorithm.additionalData) : undefined;
      return toAB(gcm(key._raw, toU8(algorithm.iv), aad).decrypt(toU8(data)));
    }
    throw new Error('decrypt: unsupported ' + name);
  },

  async wrapKey(format, key, wrappingKey, wrapAlgo) {
    if (algName(wrapAlgo) !== 'AES-KW') throw new Error('wrapKey: unsupported ' + algName(wrapAlgo));
    const raw = toU8(await subtle.exportKey(format, key));
    return toAB(aeskw(wrappingKey._raw).encrypt(raw));
  },

  async unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgo, unwrappedKeyAlgo, extractable, usages) {
    if (algName(unwrapAlgo) !== 'AES-KW') throw new Error('unwrapKey: unsupported ' + algName(unwrapAlgo));
    const raw = aeskw(unwrappingKey._raw).decrypt(toU8(wrappedKey));
    return subtle.importKey(format, raw, unwrappedKeyAlgo, extractable, usages);
  },
};

export function installWebCrypto() {
  const g = globalThis;
  if (!g.crypto) g.crypto = {};
  if (!g.crypto.subtle) {
    try { g.crypto.subtle = subtle; }
    catch { // crypto может быть frozen — заменяем объект целиком
      const rnd = g.crypto.getRandomValues ? g.crypto.getRandomValues.bind(g.crypto) : null;
      g.crypto = { getRandomValues: rnd, subtle };
    }
  }
  if (!g.crypto.randomUUID) {
    g.crypto.randomUUID = () => {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
  }
}
