// Тонкая обёртка над AsyncStorage: JSON get/set + ключи Prizrak.
import AsyncStorage from '@react-native-async-storage/async-storage';

export const K = {
  device: 'pz:deviceId',
  active: 'pz:active', // userId активного аккаунта
  state: uid => `pz:state:${uid}`, // сериализованное состояние клиента по аккаунту
  chats: uid => `pz:chats:${uid}`, // список чатов (peer userId) по аккаунту
};

export async function getJSON(key, fallback = null) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export async function setJSON(key, value) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export async function getStr(key, fallback = null) {
  try {
    return (await AsyncStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setStr(key, value) {
  try {
    await AsyncStorage.setItem(key, value);
  } catch {}
}

export async function del(key) {
  try {
    await AsyncStorage.removeItem(key);
  } catch {}
}
