// Менеджер сессии Prizrak для мобильного клиента.
// Оборачивает PrizrakClient: устойчивый deviceId, регистрация/вход, восстановление
// состояния при перезапуске и его сохранение (как B1 на десктопе — история переживает
// перелогин на том же устройстве/аккаунте).
import {PrizrakClient} from './lib/client.js';
import {bytesToHex, randomBytes} from './lib/crypto/index.js';
import {K, getStr, setStr, getJSON, setJSON, del} from './storage.js';

// Устойчивый идентификатор устройства (одно на установку приложения).
export async function getDeviceId() {
  let id = await getStr(K.device);
  if (!id) {
    id = 'mob-' + bytesToHex(randomBytes(8));
    await setStr(K.device, id);
  }
  return id;
}

function makeUserId(login, domain) {
  // Если пользователь ввёл «root:server.org» — отрезаем сервер (он берётся из выбора).
  const clean = login.trim().replace(/:.*$/, '');
  return `${clean}:${domain.trim()}`;
}

// Сохранить состояние клиента (по аккаунту) + пометить активным.
export async function persist(client) {
  if (!client || !client.userId) return;
  await setJSON(K.state(client.userId), client.serializeState());
  await setStr(K.active, client.userId);
}

export async function saveChats(userId, chats) {
  await setJSON(K.chats(userId), chats);
}

export async function loadChats(userId) {
  return (await getJSON(K.chats(userId), [])) || [];
}

// Восстановить активную сессию после перезапуска приложения.
export async function restore() {
  const active = await getStr(K.active);
  if (!active) return null;
  const state = await getJSON(K.state(active));
  if (!state) return null;
  const deviceId = await getDeviceId();
  const client = PrizrakClient.fromState(state);
  client.deviceId = deviceId;
  const chats = await loadChats(active);
  return {client, chats};
}

// Общий помощник: собрать клиента под аккаунт и домен.
// onStage — колбэк с текстом текущего этапа (для живого статуса на кнопке).
async function buildClient(login, domain, onStage) {
  const stage = typeof onStage === 'function' ? onStage : () => {};
  stage('Соединение с сервером…');
  const baseUrl = await PrizrakClient.resolveBaseUrl(domain);
  const userId = makeUserId(login, domain);
  const deviceId = await getDeviceId();
  stage('Создание PGP-ключей…'); // самый долгий этап (генерация ключей шифрования)
  // Даём кадру отрисоваться перед тяжёлой криптографией, иначе текст на кнопке не обновится.
  await new Promise(r => setTimeout(r, 60));
  const client = await new PrizrakClient({
    name: login.trim().replace(/:.*$/, ''),
    userId,
    baseUrl,
    deviceId,
  }).init();
  return {client, userId};
}

export async function register({login, domain, password, onStage}) {
  const stage = typeof onStage === 'function' ? onStage : () => {};
  const {client, userId} = await buildClient(login, domain, onStage);
  stage('Регистрация на сервере…');
  await client.register(password);
  stage('Публикация устройства…');
  try {
    await client.publishDevice();
  } catch {}
  stage('Сохранение…');
  await persist(client);
  stage('Готово!');
  return {client, chats: await loadChats(userId)};
}

export async function login({login, domain, password, onStage}) {
  const stage = typeof onStage === 'function' ? onStage : () => {};
  const {client, userId} = await buildClient(login, domain, onStage);
  stage('Вход на сервер…');
  await client.login(password);
  // B1: если на этом устройстве уже было состояние этого аккаунта — перенимаем
  // ратчет-сессии, чтобы старая переписка осталась читаемой.
  const prev = await getJSON(K.state(userId));
  if (prev) {
    try {
      client.adoptSessionsFrom(prev);
    } catch {}
  }
  stage('Публикация устройства…');
  try {
    await client.publishDevice();
  } catch {}
  stage('Сохранение…');
  await persist(client);
  stage('Готово!');
  return {client, chats: await loadChats(userId)};
}

// Восстановление из файла-копии (B2): текст копии + пароль файла + пароль аккаунта.
// Домен и userId берутся из самого файла.
export async function importAccount({backupText, filePassword, accountPassword, onStage}) {
  const stage = typeof onStage === 'function' ? onStage : () => {};
  let file;
  try {
    file = JSON.parse(backupText);
  } catch {
    throw new Error('Это не файл копии (ожидается JSON)');
  }
  stage('Расшифровка копии…');
  const secret = PrizrakClient.openBackupBlob(filePassword, file); // бросит при неверном пароле
  const userId = file.userId;
  const login = userId.split(':')[0];
  const domain = userId.split(':').slice(1).join(':');
  stage('Соединение с сервером…');
  const baseUrl = await PrizrakClient.resolveBaseUrl(domain);
  const deviceId = await getDeviceId();
  stage('Создание PGP-ключей…');
  await new Promise(r => setTimeout(r, 60)); // дать кадру отрисоваться перед тяжёлой криптографией
  const client = await new PrizrakClient({name: login, userId, baseUrl, deviceId}).init();
  stage('Вход на сервер…');
  await client.loginWithSecret(accountPassword, secret);
  const prev = await getJSON(K.state(userId));
  if (prev) {
    try {
      client.adoptSessionsFrom(prev);
    } catch {}
  }
  stage('Публикация устройства…');
  try {
    await client.publishDevice();
  } catch {}
  stage('Сохранение…');
  await persist(client);
  stage('Готово!');
  return {client, chats: await loadChats(userId)};
}

// Выход: снимаем «активный» флаг, но состояние аккаунта не стираем (B1).
export async function logout() {
  await del(K.active);
}
