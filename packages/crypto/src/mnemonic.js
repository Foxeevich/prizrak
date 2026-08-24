// mnemonic.js — фраза восстановления (сид-фраза).
// 128 бит энтропии = 16 слов + 1 слово-контрольная сумма (для отлова опечаток).
// Словарь из 256 коротких произносимых токенов строится детерминированно
// (onset+vowel+coda), поэтому кодирование/декодирование однозначно и без словаря-полотна.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

const ONSETS = ['b', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'br', 'tr'];
const VOWELS = ['a', 'e', 'i', 'o'];
const CODAS = ['', 'n', 'r', 's'];
export const WORDS = [];
for (const o of ONSETS) for (const v of VOWELS) for (const c of CODAS) WORDS.push(o + v + c); // 16*4*4 = 256
const INDEX = new Map(WORDS.map((w, i) => [w, i]));

export function normalizeMnemonic(s) { return String(s || '').trim().toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

// 16 случайных байт → 17 слов (16 данных + 1 контрольная сумма).
export function generateMnemonic(nBytes = 16) {
  const bytes = randomBytes(nBytes);
  const cksum = sha256(bytes)[0];
  const all = [...bytes, cksum];
  return all.map((b) => WORDS[b]).join(' ');
}

// Слова → 16 байт данных; бросает при неизвестном слове или неверной контрольной сумме.
export function mnemonicToBytes(mnemonic) {
  const words = normalizeMnemonic(mnemonic).split(' ').filter(Boolean);
  if (words.length < 2) throw new Error('Слишком короткая фраза');
  const idx = words.map((w) => { const i = INDEX.get(w); if (i === undefined) throw new Error('Неизвестное слово в фразе: ' + w); return i; });
  const data = Uint8Array.from(idx.slice(0, -1));
  const cksum = idx[idx.length - 1];
  if (sha256(data)[0] !== cksum) throw new Error('Ошибка в фразе восстановления (контрольная сумма) — проверьте слова');
  return data;
}

// Проверить, что фраза корректна (правильные слова + контрольная сумма).
export function isValidMnemonic(mnemonic) { try { mnemonicToBytes(mnemonic); return true; } catch { return false; } }

// Детерминированный 32-байтовый seed из фразы (для деривации ключа шифрования копии).
export function mnemonicSeedHex(mnemonic) { return bytesToHex(sha256(new TextEncoder().encode('prizrak-seed|' + normalizeMnemonic(mnemonic)))); }
