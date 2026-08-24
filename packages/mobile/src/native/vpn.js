// vpn.js — Призрак-VPN на Android: оплата → тап по стране → туннель.
//
// Пользователь НИЧЕГО не настраивает: узлы саморегистрируются в Банке, а по тапу
// клиент получает ПОДПИСАННЫЙ ордер (какой реле+выход) и строит по нему туннель.
// Всё, что клиент о себе знает — «оплачено до <дата>».
//
//   тап по стране → client.vpnConnect(country) → order → JS-SOCKS(order) →
//   native VpnService + tun2socks → весь трафик устройства через Призрак.

import {NativeModules, NativeEventEmitter, Platform} from 'react-native';
import {createSocks} from '../vpn/socks-rn.js';

const Native = NativeModules.PrizrakVpn || null;
const emitter = Native ? new NativeEventEmitter(Native) : null;
const SOCKS_PORT = 10808;

let socks = null;
let state = {state: 'off', country: null, node: false};

export function vpnAvailable() {
  return Platform.OS === 'android' && !!Native;
}
export function onVpnState(cb) {
  if (!emitter) return () => {};
  const sub = emitter.addListener('vpnState', cb);
  return () => sub.remove();
}
export function onVpnNotice(cb) {
  if (!emitter) return () => {};
  const sub = emitter.addListener('vpnNotice', cb);
  return () => sub.remove();
}

// Закрыть локальный SOCKS и ДОЖДАТЬСЯ освобождения порта. Без ожидания повторный
// listen на тот же порт может зависнуть (порт ещё занят) — отсюда «зависание».
function stopSocks() {
  return new Promise((resolve) => {
    const s = socks; socks = null;
    if (!s) return resolve();
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try { s.close(fin); } catch { fin(); }
    setTimeout(fin, 1500); // страховка: не ждём дольше 1.5 с
  });
}

// Поднять SOCKS с обработкой ошибок и таймаутом — чтобы listen никогда не завис.
function listenSocks(s) {
  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; reject(new Error('не удалось открыть локальный порт (занят?)')); } }, 6000);
    const okOnce = () => { if (!done) { done = true; clearTimeout(to); resolve(); } };
    const failOnce = (e) => { if (!done) { done = true; clearTimeout(to); reject(e instanceof Error ? e : new Error(String(e))); } };
    try { if (s.server && s.server.on) s.server.on('error', failOnce); } catch {}
    try { s.listen(okOnce); } catch (e) { failOnce(e); }
  });
}

// Промис с таймаутом — на случай, если натив не ответит (не вешаем UI навсегда).
function withTimeout(p, ms, msg) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(msg)), ms);
    Promise.resolve(p).then((v) => { clearTimeout(to); resolve(v); }, (e) => { clearTimeout(to); reject(e); });
  });
}

/**
 * Включить маскировку по ордеру Банка. order = { relay, exit, country, sig, ... }.
 * Ордер получают из client.vpnConnect(country) — здесь только поднимаем туннель.
 */
export async function maskOn(order, creds) {
  if (!vpnAvailable()) throw new Error('VPN недоступен на этой сборке');
  if (!order || !order.country) throw new Error('нет страны подключения');
  if (!creds || !creds.bankUrl || !creds.userId || !creds.ghostSeed) throw new Error('нет доступа к Банку');
  // ЖИВУЧИЙ режим: отдаём нативному сервису доступ к Банку и страну. Дальше сервис
  // САМ добывает ордер, продлевает его и переживает ребут (always-on) — без JS.
  // Системное окно согласия VpnService показывается тут (до 2 мин на ответ).
  await withTimeout(
    Native.enableVpn(String(creds.bankUrl), String(creds.userId), String(creds.ghostSeed), order.country || '', SOCKS_PORT),
    120000, 'таймаут запроса разрешения VPN',
  );
  state = {state: 'up', country: order.country || null, node: state.node};
  return {country: order.country};
}

export async function maskOff() {
  if (vpnAvailable()) {
    try { await Native.maskOff(); } catch {}
    try { await Native.stopNative(); } catch {}
  }
  state = {...state, state: 'off', country: null};
}

/** Смена страны: новый ордер строится в UI, сюда приходит готовый. */
export async function switchOrder(order) { await maskOff(); return maskOn(order); }

export async function nodeOn() { state = {...state, node: true}; return true; }
export async function nodeOff() { state = {...state, node: false}; return true; }

export async function vpnStatus() {
  if (!vpnAvailable()) return {state: 'off', country: null, node: false, available: false};
  return {...state, available: true};
}
