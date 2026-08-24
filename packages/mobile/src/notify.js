// Уведомления о входящих сообщениях со звуком ICQ (как на десктопе).
// Локальные уведомления через notifee — без Google-сервисов; работают, пока
// приложение запущено (в т.ч. свёрнуто). Настоящий push (FCM/UnifiedPush) — MOB6.
import notifee, {AndroidImportance} from '@notifee/react-native';
import {getJSON, setJSON} from './storage';

const CHANNEL_ID = 'messages';
let _ready = false;
let _soundOn = true;

export async function initNotifications() {
  try {
    await notifee.requestPermission(); // Android 13+: POST_NOTIFICATIONS
    // Канал со звуком incoming (res/raw/incoming.mp3) — «Oh-oh!» из ICQ.
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Сообщения',
      importance: AndroidImportance.HIGH,
      sound: 'incoming',
      vibration: true,
    });
    // Тихий канал — когда звук выключен в настройках.
    await notifee.createChannel({
      id: 'messages-silent',
      name: 'Сообщения (без звука)',
      importance: AndroidImportance.HIGH,
      vibration: true,
    });
    _soundOn = (await getJSON('pz:sound', true)) !== false;
    _ready = true;
  } catch {}
}

export function soundEnabled() {
  return _soundOn;
}
export async function setSoundEnabled(on) {
  _soundOn = !!on;
  await setJSON('pz:sound', _soundOn);
}

// Показать уведомление о сообщении. title — от кого/чат, body — текст.
export async function notifyMessage(threadId, title, body) {
  if (!_ready) return;
  try {
    await notifee.displayNotification({
      id: 'msg-' + threadId, // одно уведомление на чат — обновляется
      title,
      body: body && body.length > 120 ? body.slice(0, 117) + '…' : body || 'Новое сообщение',
      android: {
        channelId: _soundOn ? CHANNEL_ID : 'messages-silent',
        smallIcon: 'ic_launcher',
        pressAction: {id: 'default', launchActivity: 'default'},
      },
    });
  } catch {}
}

// Убрать уведомление чата (открыли его / прочитали на другом устройстве).
export async function clearThreadNotification(threadId) {
  try {
    await notifee.cancelNotification('msg-' + threadId);
  } catch {}
}

export async function clearAllNotifications() {
  try {
    await notifee.cancelAllNotifications();
  } catch {}
}
