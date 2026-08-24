// App Lock: PIN-код (4 цифры) + биометрия для доступа к приложению.
// Хранится ГЛОБАЛЬНО (не по аккаунту): {salt, pinHash, biometric}.
// PIN не хранится в открытом виде — только соль + sha256(соль+PIN).
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils';
import {getJSON, setJSON, del} from './storage';

const KEY = 'pz:applock';

function hashPin(pin, saltHex) {
  return bytesToHex(sha256(utf8ToBytes(saltHex + '|' + String(pin))));
}

// Полная конфигурация замка (или null, если не настроен).
export async function loadLock() {
  return (await getJSON(KEY, null)) || null;
}

// Краткий статус для UI.
export async function lockStatus() {
  const l = await loadLock();
  return {
    pinSet: !!(l && l.pinHash),
    biometric: !!(l && l.biometric),
  };
}

// Через сколько секунд отсутствия просить PIN снова. 0 = сразу.
// По умолчанию 60 с: открыть галерею/камеру и вернуться — замок не срабатывает,
// а вот выключил экран и ушёл — попросит.
export const AUTOLOCK_CHOICES = [0, 30, 60, 300, 900];
export async function getAutolockSec() {
  const l = await loadLock();
  return l && Number.isFinite(l.autolockSec) ? l.autolockSec : 60;
}
export async function setAutolockSec(sec) {
  const l = await loadLock();
  if (!l || !l.pinHash) return;
  await setJSON(KEY, {...l, autolockSec: Math.max(0, Number(sec) || 0)});
}

// Замок активен, если задан PIN (биометрия — поверх PIN).
export async function lockEnabled() {
  const l = await loadLock();
  return !!(l && l.pinHash);
}

export async function setPin(pin) {
  const salt = bytesToHex(randomBytes(16));
  const cur = (await loadLock()) || {};
  await setJSON(KEY, {salt, pinHash: hashPin(pin, salt), biometric: !!cur.biometric});
}

export async function verifyPin(pin) {
  const l = await loadLock();
  if (!l || !l.pinHash) return false;
  return hashPin(pin, l.salt) === l.pinHash;
}

// Выключить PIN (и биометрию заодно — она поверх PIN не имеет смысла без него).
export async function clearLock() {
  await del(KEY);
}

export async function setBiometric(on) {
  const l = await loadLock();
  if (!l || !l.pinHash) return; // биометрия только вместе с PIN
  await setJSON(KEY, {...l, biometric: !!on});
}
