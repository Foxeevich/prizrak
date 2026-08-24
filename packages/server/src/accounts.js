// accounts.js — аутентификация без телефона.
// Логин вида  user:domain  (двоеточие, как в Matrix; НЕ email со «собакой»).
// Пароль хранится как scrypt-хеш с солью. Телефон/почта не требуются.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const LOCALPART_RE = /^[a-z0-9_.-]{1,64}$/;

/** Проверка и разбор идентификатора user:domain. */
export function parseUserId(userId, expectedDomain) {
  if (typeof userId !== 'string' || !userId.includes(':')) {
    throw new Error('userId должен быть вида user:domain (например alice:example.org)');
  }
  const [localpart, domain] = userId.split(':');
  if (!LOCALPART_RE.test(localpart)) {
    throw new Error('Недопустимое имя: разрешены a-z, 0-9, точка, дефис, подчёркивание');
  }
  if (expectedDomain && domain !== expectedDomain) {
    throw new Error(`Домен ${domain} не обслуживается этим сервером (${expectedDomain})`);
  }
  return { localpart, domain };
}

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Пароль должен быть не короче 8 символов');
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const hash = scryptSync(password, Buffer.from(record.salt, 'hex'), 64);
  const expected = Buffer.from(record.hash, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export function newToken() {
  return randomBytes(32).toString('hex');
}
