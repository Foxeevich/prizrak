import React, {useEffect, useRef, useState, useCallback} from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  StyleSheet,
  AppState,
  Linking,
  Share,
  Switch,
  Alert,
  PermissionsAndroid,
  Image,
  Modal,
  PanResponder,
  BackHandler,
  Animated,
  Easing,
} from 'react-native';
import {CallManager, CALLS_SUPPORTED} from './src/call';
import {VIDEO_SUPPORTED} from './src/native/call-rn';
import VideoView from './src/native/VideoView';
import {
  VOICE_SUPPORTED,
  startVoice,
  stopVoice,
  cancelVoice,
  playVoice,
  pauseVoice,
  resumeVoice,
  stopVoicePlay,
  onVoiceProgress,
} from './src/native/voice';
import {
  VIDEONOTE_SUPPORTED,
  NoteView,
  startNote,
  stopNote,
  cancelNote,
  playNote,
  stopNotePlay,
  onNoteProgress,
} from './src/native/videonote';
import {SERVERS} from './src/servers';
import * as Session from './src/session';
import {getJSON, setJSON, getStr, setStr} from './src/storage';
import {buildLinkPreview, firstUrl} from './src/lib/link-preview';
import {BIOMETRIC_SUPPORTED, biometricAvailable, biometricAuth} from './src/native/biometric';
import {saveToDownloads} from './src/native/files';
import {lockStatus, lockEnabled, setPin as setPinStore, verifyPin, clearLock, setBiometric, loadLock, getAutolockSec, setAutolockSec, AUTOLOCK_CHOICES} from './src/applock';
import {
  initNotifications,
  notifyMessage,
  clearThreadNotification,
  clearAllNotifications,
  soundEnabled,
  setSoundEnabled,
} from './src/notify';
import {APP_VERSION, checkUpdate} from './src/updater';
import * as Vpn from './src/native/vpn';

// ── Страховка от «молчаливых» вылетов ───────────────────────────────────────
// В release-сборке фатальная JS-ошибка просто закрывает приложение. Перехватываем
// её и показываем текст ошибки — и для диагностики, и чтобы не терять работу.
let _reportFatal = null;
if (global.ErrorUtils && !global.__pzErrHooked) {
  global.__pzErrHooked = true;
  const prev = global.ErrorUtils.getGlobalHandler && global.ErrorUtils.getGlobalHandler();
  global.ErrorUtils.setGlobalHandler((e, isFatal) => {
    try {
      if (_reportFatal) {
        _reportFatal(`${isFatal ? 'Фатальная ошибка' : 'Ошибка'}: ${(e && e.message) || e}`);
        return;
      }
    } catch {}
    prev && prev(e, isFatal);
  });
}

// ── Тема (тёмная, в духе Telegram/десктоп-Prizrak) ──────────────────────────
const C = {
  bg: '#0e1621',
  panel: '#17212b',
  panel2: '#1d2733',
  accent: '#3390ec',
  accentDim: '#2b6cb0',
  text: '#e9edf1',
  sub: '#7d8e9e',
  bubbleIn: '#182533',
  bubbleOut: '#2b5278',
  danger: '#e0555a',
  line: '#0b1219',
  tickGrey: 'rgba(233,237,241,0.55)',
  tickBlue: '#5fd0ff',
};

const KIND_ICON = {dm: '', group: '👥 ', channel: '📢 '};

// Аватар в профиле/комнате хранится как {mime, data(base64)} → data-uri.
// Ссылки в тексте сообщений → кликабельные (тап открывает браузер по умолчанию).
const LINK_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
function renderTextWithLinks(text) {
  const s = String(text == null ? '' : text);
  if (!/https?:\/\/|www\./i.test(s)) return s;
  const out = [];
  let last = 0,
    m,
    i = 0;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    let url = m[0];
    const tail = (url.match(/[).,!?;:»”"']+$/) || [''])[0];
    if (tail) url = url.slice(0, url.length - tail.length);
    const href = /^www\./i.test(url) ? 'http://' + url : url;
    out.push(
      <Text
        key={'l' + i++}
        style={{color: '#7db0ff', textDecorationLine: 'underline'}}
        onPress={() => {
          try {
            markSystemScreen();
            Linking.openURL(href);
          } catch {}
        }}>
        {url}
      </Text>,
    );
    if (tail) out.push(tail);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function avatarToUri(a) {
  return a && a.data ? `data:${a.mime || 'image/png'};base64,${a.data}` : '';
}

// Кружок аватара: картинка, если есть; иначе буква на цветном фоне.
// Когда приложение САМО открывает системный экран (галерея, камера, «поделиться»,
// браузер), возврат в него — не «отлучка», и замок дёргать не надо. Флаг живёт
// не дольше 5 минут: если экран за это время погас, PIN всё равно спросим.
let _skipLockUntil = 0;
function markSystemScreen() { _skipLockUntil = Date.now() + 5 * 60 * 1000; }
function consumeSkipLock() {
  const ok = Date.now() < _skipLockUntil;
  _skipLockUntil = 0;
  return ok;
}

function Avatar({uri, label, kind, size = 48}) {
  const bg =
    kind === 'channel' ? '#6a5acd' : kind === 'group' ? '#3d7a4f' : C.accentDim;
  const st = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: bg,
    alignItems: 'center',
    justifyContent: 'center',
  };
  if (uri) {
    return <Image source={{uri}} style={[st, {backgroundColor: C.panel2}]} />;
  }
  return (
    <View style={st}>
      <Text style={{color: '#fff', fontSize: size * 0.42, fontWeight: '700'}}>
        {(label || '?').charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

// ── Хранилище сообщений (по аккаунту): { threadId: [{id,dir,from,text,ts}] } ─
async function loadMsgs(userId) {
  return (await getJSON(`pz:msgs:${userId}`, {})) || {};
}
async function saveMsgs(userId, msgs) {
  // `_b64` (сырые байты голосового для мгновенного переслушивания) храним только в
  // памяти — на диск не пишем, чтобы не раздувать хранилище. После отправки есть
  // mediaId/key/nonce, и байты при необходимости подтягиваются заново.
  let out = msgs;
  try {
    out = {};
    for (const k of Object.keys(msgs)) {
      out[k] = (msgs[k] || []).map(m => (m && m._b64 ? {...m, _b64: undefined} : m));
    }
  } catch {
    out = msgs;
  }
  await setJSON(`pz:msgs:${userId}`, out);
}

// Миграция списка чатов: раньше — массив строк (peer), теперь — [{id,kind,name}].
function normChats(list) {
  return (list || []).map(c =>
    typeof c === 'string' ? {id: c, kind: 'dm', name: c} : c,
  );
}

// Автозагрузка чатов с сервера: лички из /chats (метаданные), группы/каналы из /rooms.
// Локальные записи, которых сервер не знает (например, собеседник, которому я только
// писал), сохраняем.
async function fetchDirectory(client, localChats) {
  const out = [];
  const seen = new Set();
  try {
    const dms = await client.listChats(); // [{peer,lastAt,count}] по последней активности
    for (const d of dms) {
      if (!seen.has(d.peer)) {
        seen.add(d.peer);
        out.push({id: d.peer, kind: 'dm', name: d.peer});
      }
    }
  } catch {}
  try {
    const rooms = await client.listRooms(); // [{id,type,name,...}]
    for (const r of rooms) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        out.push({
          id: r.id,
          kind: r.type === 'channel' ? 'channel' : 'group',
          name: r.name || r.id,
          avatarObj: r.avatar || null,
          retention: r.retention || null, // автоудаление (G4): срок жизни сообщений комнаты
        });
      }
    }
  } catch {}
  for (const c of normChats(localChats)) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

// ── App Lock: точки PIN, клавиатура, экраны блокировки и установки PIN ──────────
function PinDots({len}) {
  return (
    <View style={styles.pinDots}>
      {[0, 1, 2, 3].map(i => (
        <View key={i} style={[styles.pinDot, i < len && styles.pinDotOn]} />
      ))}
    </View>
  );
}
function Keypad({onDigit, onDelete, onBio, showBio}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', showBio ? 'bio' : 'gap', '0', 'del'];
  return (
    <View style={styles.keypad}>
      {keys.map((k, i) => {
        if (k === 'gap') return <View key={i} style={styles.key} />;
        if (k === 'bio')
          return (
            <TouchableOpacity key={i} style={styles.key} onPress={onBio}>
              <Text style={styles.keyBio}>☝️</Text>
            </TouchableOpacity>
          );
        if (k === 'del')
          return (
            <TouchableOpacity key={i} style={styles.key} onPress={onDelete}>
              <Text style={styles.keyTxt}>⌫</Text>
            </TouchableOpacity>
          );
        return (
          <TouchableOpacity key={i} style={styles.key} onPress={() => onDigit(k)}>
            <Text style={styles.keyTxt}>{k}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
function LockScreen({biometric, onUnlock}) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const tryBio = useCallback(async () => {
    try {
      await biometricAuth('Prizrak', 'Разблокируйте приложение');
      onUnlock();
    } catch {}
  }, [onUnlock]);
  useEffect(() => {
    if (biometric) tryBio();
  }, [biometric, tryBio]);
  const onDigit = async d => {
    if (pin.length >= 4) return;
    const np = pin + d;
    setPin(np);
    setErr('');
    if (np.length === 4) {
      if (await verifyPin(np)) onUnlock();
      else {
        setErr('Неверный PIN-код');
        setTimeout(() => setPin(''), 180);
      }
    }
  };
  return (
    <View style={styles.lockWrap}>
      <Text style={styles.lockGhost}>👻</Text>
      <Text style={styles.lockTitle}>Prizrak заблокирован</Text>
      <Text style={[styles.lockHint, err && {color: C.danger}]}>{err || 'Введите PIN-код'}</Text>
      <PinDots len={pin.length} />
      <Keypad onDigit={onDigit} onDelete={() => setPin(p => p.slice(0, -1))} onBio={tryBio} showBio={biometric} />
    </View>
  );
}
function SetPinScreen({onDone, onSkip, canSkip, flash}) {
  const [stage, setStage] = useState('enter'); // enter | confirm
  const [first, setFirst] = useState('');
  const [pin, setPin] = useState('');
  const onDigit = async d => {
    if (pin.length >= 4) return;
    const np = pin + d;
    setPin(np);
    if (np.length === 4) {
      if (stage === 'enter') {
        setFirst(np);
        setTimeout(() => {
          setPin('');
          setStage('confirm');
        }, 150);
      } else if (np === first) {
        await setPinStore(np);
        onDone();
      } else {
        flash('PIN не совпал, начните заново', 'err');
        setFirst('');
        setStage('enter');
        setTimeout(() => setPin(''), 150);
      }
    }
  };
  return (
    <View style={styles.lockWrap}>
      <Text style={styles.lockGhost}>🔒</Text>
      <Text style={styles.lockTitle}>{stage === 'enter' ? 'Придумайте PIN-код' : 'Повторите PIN-код'}</Text>
      <Text style={styles.lockHint}>4 цифры для входа в приложение</Text>
      <PinDots len={pin.length} />
      <Keypad onDigit={onDigit} onDelete={() => setPin(p => p.slice(0, -1))} showBio={false} />
      {canSkip && (
        <TouchableOpacity onPress={onSkip} style={{marginTop: 20, padding: 8}}>
          <Text style={{color: C.sub, fontSize: 15}}>Пропустить</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

function AppInner() {
  const [screen, setScreen] = useState('loading'); // loading|auth|chats|chat|settings|setpin
  const [locked, setLocked] = useState(false); // App Lock активен → показываем LockScreen
  const [lockBio, setLockBio] = useState(false); // включена ли биометрия для замка
  // Системная кнопка «назад» (Android): ходит по экранам приложения, как ‹ в шапке.
  const screenRef2 = useRef('loading');
  screenRef2.current = screen;
  const lockedRef = useRef(false);
  lockedRef.current = locked;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (lockedRef.current) return true; // экран блокировки — назад не обходит замок
      const s = screenRef2.current;
      if (s === 'chat') { setScreen('chats'); return true; }       // из чата → к списку чатов
      if (s === 'settings') { setScreen('chats'); return true; }   // из настроек → к чатам
      if (s === 'setpin') { setScreen('chats'); return true; }     // экран PIN после входа → пропустить
      return false; // список чатов/логин — стандартное поведение (свернуть приложение)
    });
    return () => sub.remove();
  }, []);
  const [client, setClient] = useState(null);
  const [chats, setChats] = useState([]); // [{id,kind,name}]
  const [msgs, setMsgs] = useState({}); // threadId → [msg]
  const [unread, setUnread] = useState({}); // threadId → n
  const [openChatId, setOpenChatId] = useState(null);
  const [banner, setBanner] = useState(null);
  const [update, setUpdate] = useState(null); // {version, url, notes}
  const [callState, setCallState] = useState({phase: 'idle'});
  const [names, setNames] = useState({}); // userId → displayName (из профиля)
  const [aliases, setAliases] = useState({}); // userId → локальный псевдоним
  const [avatarsMap, setAvatarsMap] = useState({}); // id → data-uri аватара
  const [mutes, setMutes] = useState({}); // chatId → until (0 = навсегда) отключённых уведомлений
  const clientRef = useRef(null);
  const msgsRef = useRef({});
  const chatsRef = useRef([]);
  const namesRef = useRef({});
  const aliasesRef = useRef({});
  const mutesRef = useRef({});
  const openChatRef = useRef(null);
  const appStateRef = useRef('active');
  const bgSinceRef = useRef(0);        // когда ушли в фон (для паузы автоблокировки)
  const callRef = useRef(null);
  const callDurRef = useRef(null);
  const [callSecs, setCallSecs] = useState(0);

  msgsRef.current = msgs;
  clientRef.current = client;
  chatsRef.current = chats;
  namesRef.current = names;
  aliasesRef.current = aliases;
  mutesRef.current = mutes;

  // Превью ссылок: собирать или нет (тумблер в настройках). Держим в ref —
  // отправка читает актуальное значение, не пересоздавая колбэк.
  const previewsRef = useRef(true);
  useEffect(() => { getStr('pz:linkPreviews').then(v => { previewsRef.current = v !== '0'; }).catch(() => {}); }, []);

  // Приватность «Звонки»: обработчик входящего звонка создаётся один раз, поэтому
  // свежие настройки он читает через ref (иначе видел бы политику на момент входа).
  const privacyRef = useRef(null);
  const callAllowedRef = useRef(() => true);
  callAllowedRef.current = from => {
    const pv = privacyRef.current;
    if (!pv || !from) return true;
    if ((pv.blocked || []).includes(from)) return false;      // ЧС — всегда мимо
    if ((pv.callsAllow || []).includes(from)) return true;    // «Всегда разрешать»
    const m = pv.calls || 'all';
    if (m === 'all') return true;
    if (m === 'none') return false;
    return !!(chatsRef.current || []).some(c => c.kind === 'dm' && c.id === from); // «Мои контакты» = есть переписка
  };
  openChatRef.current = screen === 'chat' ? openChatId : null;

  const isMuted = useCallback(id => {
    const v = mutesRef.current[id];
    if (v === undefined) return false;
    if (v === 0) return true; // навсегда
    return Date.now() < v;
  }, []);

  const setMute = useCallback(async (chatId, durationMs) => {
    const cl = clientRef.current;
    const next = {...mutesRef.current};
    if (durationMs == null) delete next[chatId]; // включить уведомления
    else next[chatId] = durationMs === Infinity ? 0 : Date.now() + durationMs;
    setMutes(next);
    if (cl) await setJSON(`pz:mutes:${cl.userId}`, next);
  }, []);

  // Имя для показа: псевдоним (мой приватный) > отображаемое имя из профиля > логин.
  const nameOf = useCallback(
    id => {
      if (!id) return id;
      if (aliasesRef.current[id]) return aliasesRef.current[id];
      if (namesRef.current[id]) return namesRef.current[id];
      if (id.includes(':') && !id.startsWith('!')) return id.split(':')[0]; // user:server → user
      return id;
    },
    [],
  );

  // Подтянуть имена и аватары (профили). КЕШ: профиль хранится локально и
  // перезапрашивается с сервера не чаще раза в сутки (иначе берём из кеша мгновенно).
  const PROFILE_TTL = 24 * 3600e3;
  const refreshNames = useCallback(async (cl, chatList) => {
    // 1) мгновенно из кеша
    const cache = (await getJSON(`pz:prof:${cl.userId}`, {})) || {};
    const nn = {},
      av = {};
    for (const [id, c] of Object.entries(cache)) {
      if (c.displayName) nn[id] = c.displayName;
      if (c.avatarUri) av[id] = c.avatarUri;
    }
    if (Object.keys(nn).length) setNames(prev => ({...nn, ...prev}));
    if (Object.keys(av).length) setAvatarsMap(prev => ({...av, ...prev}));

    // 2) сеть — только для протухших (>24ч) записей
    let changed = false;
    const now = Date.now();
    for (const c of chatList || []) {
      if (c.kind === 'dm') {
        const cached = cache[c.id];
        if (cached && now - (cached.at || 0) < PROFILE_TTL) continue; // свежий кеш — не трогаем сервер
        try {
          const p = await cl.getProfile(c.id);
          const displayName = p && p.displayName ? p.displayName : '';
          const avatarUri = avatarToUri(p && p.avatar);
          cache[c.id] = {displayName, avatarUri, at: now};
          changed = true;
          if (displayName) setNames(prev => ({...prev, [c.id]: displayName}));
          if (avatarUri) setAvatarsMap(prev => ({...prev, [c.id]: avatarUri}));
        } catch {}
      } else if (c.avatarObj) {
        const uri = avatarToUri(c.avatarObj);
        if (uri) {
          setAvatarsMap(prev => ({...prev, [c.id]: uri}));
          cache[c.id] = {displayName: cache[c.id]?.displayName || '', avatarUri: uri, at: now};
          changed = true;
        }
      }
    }
    if (changed) await setJSON(`pz:prof:${cl.userId}`, cache);
  }, []);

  const setAlias = useCallback(async (peer, name) => {
    const cl = clientRef.current;
    const next = {...aliasesRef.current};
    if (name) next[peer] = name;
    else delete next[peer];
    setAliases(next);
    if (cl) {
      await setJSON(`pz:aliases:${cl.userId}`, next);
      try {
        await cl.setContactAlias(peer, name); // синхронизация между своими устройствами
      } catch {}
    }
  }, []);

  // Уведомления + слежение за фоном/фокусом + проверка обновлений.
  useEffect(() => {
    initNotifications();
    const sub = AppState.addEventListener('change', s => {
      const prev = appStateRef.current;
      appStateRef.current = s;
      if (s === 'background' || s === 'inactive') { bgSinceRef.current = Date.now(); return; }
      // Возврат из фона. Замок просим НЕ на каждое переключение окна:
      //  • если сами открыли системный экран (галерея, камера, «поделиться») — не просим вовсе;
      //  • иначе — только если отсутствовали дольше выбранной паузы (по умолчанию минуту).
      // Так выбор аватара из галереи больше не сбрасывает экран и не теряет картинку.
      if (s === 'active' && (prev === 'background' || prev === 'inactive')) {
        if (consumeSkipLock()) { bgSinceRef.current = 0; return; }
        const away = bgSinceRef.current ? Date.now() - bgSinceRef.current : 0;
        bgSinceRef.current = 0;
        lockEnabled().then(async on => {
          if (!on) return;
          const graceMs = (await getAutolockSec()) * 1000;
          if (away < graceMs) return;         // отлучились ненадолго — не мешаем
          const ls = await lockStatus();
          setLockBio(ls.biometric); setLocked(true);
        });
      }
    });
    const doCheck = () =>
      checkUpdate()
        .then(u => setUpdate(u && u.status === 'update' ? u : null))
        .catch(() => {});
    doCheck();
    const t = setInterval(doCheck, 6 * 3600e3); // как на десктопе — раз в 6 часов
    return () => {
      sub.remove();
      clearInterval(t);
    };
  }, []);

  const flash = useCallback((text, kind = 'info') => {
    setBanner({text, kind});
    setTimeout(() => setBanner(null), kind === 'err' ? 8000 : 3500);
  }, []);

  useEffect(() => {
    _reportFatal = msg => flash(msg, 'err');
    return () => {
      _reportFatal = null;
    };
  }, [flash]);

  const setChatsPersist = useCallback(list => {
    setChats(list);
    if (clientRef.current) Session.saveChats(clientRef.current.userId, list);
  }, []);

  // ── Автоудаление (G4): локальные копии сообщений стираются по сроку комнаты ──
  const RET_MS = {'1d': 86400e3, '3d': 259200e3, '1w': 604800e3, '2w': 1209600e3, '1mo': 2592000e3, '3mo': 7776000e3, '6mo': 15552000e3, '1y': 31536000e3};
  const sweepAutoDelete = useCallback(async () => {
    const cur = {...msgsRef.current};
    const nowT = Date.now();
    let changed = false;
    for (const [tid, list] of Object.entries(cur)) {
      const chat = chatsRef.current.find(x => x.id === tid);
      const ttl = chat && chat.retention && RET_MS[chat.retention];
      if (!ttl || !Array.isArray(list)) continue;
      const keep = list.filter(m => !m.ts || nowT - m.ts < ttl);
      if (keep.length !== list.length) {
        cur[tid] = keep;
        changed = true;
      }
    }
    if (changed) {
      setMsgs(cur);
      if (clientRef.current) await saveMsgs(clientRef.current.userId, cur);
    }
  }, []);
  useEffect(() => {
    const iv = setInterval(sweepAutoDelete, 10 * 60 * 1000);
    const t0 = setTimeout(sweepAutoDelete, 20000);
    return () => {
      clearInterval(iv);
      clearTimeout(t0);
    };
  }, [sweepAutoDelete]);

  // Убедиться, что чат есть в списке (входящее из неизвестной комнаты/от нового собеседника).
  const ensureChat = useCallback(
    (id, kind, name) => {
      if (chatsRef.current.some(c => c.id === id)) return;
      setChatsPersist([{id, kind, name: name || id}, ...chatsRef.current]);
    },
    [setChatsPersist],
  );

  const appendMsg = useCallback(async (threadId, msg) => {
    const cur = {...msgsRef.current};
    const thread = (cur[threadId] || []).slice();
    if (msg.id && thread.some(m => m.id === msg.id)) return false; // дубль
    thread.push(msg);
    cur[threadId] = thread;
    setMsgs(cur);
    if (clientRef.current) await saveMsgs(clientRef.current.userId, cur);
    return true;
  }, []);

  // Изменить сообщение по id (реакции, data-uri картинки и т.п.).
  const updateMsg = useCallback(async (threadId, msgId, updater) => {
    const cur = {...msgsRef.current};
    const thread = (cur[threadId] || []).map(m =>
      m.id === msgId ? updater({...m}) : m,
    );
    cur[threadId] = thread;
    setMsgs(cur);
    if (clientRef.current) await saveMsgs(clientRef.current.userId, cur);
  }, []);

  const removeMsg = useCallback(async (threadId, msgId) => {
    const cur = {...msgsRef.current};
    cur[threadId] = (cur[threadId] || []).filter(m => m.id !== msgId);
    setMsgs(cur);
    if (clientRef.current) await saveMsgs(clientRef.current.userId, cur);
  }, []);

  // Скачать вложение-картинку и подставить data-uri для показа в пузыре.
  const hydrateImage = useCallback(
    async (threadId, msgId, att) => {
      const cl = clientRef.current;
      if (!cl || !att || !(att.mime || '').startsWith('image/')) return;
      try {
        const bytes = await cl.fetchAttachment(att);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const uri = `data:${att.mime};base64,${global.btoa(bin)}`;
        await updateMsg(threadId, msgId, m => ({...m, uri}));
      } catch {}
    },
    [updateMsg],
  );

  // Входящее «чужое» сообщение: непрочитанное + уведомление со звуком,
  // если чат сейчас не открыт на экране (или приложение свёрнуто).
  const onIncoming = useCallback(
    (threadId, title, text) => {
      const isOpen =
        openChatRef.current === threadId && appStateRef.current === 'active';
      if (isOpen) return;
      setUnread(u => ({...u, [threadId]: (u[threadId] || 0) + 1}));
      if (!isMuted(threadId)) notifyMessage(threadId, title, text); // Mute → без звука/уведомления
    },
    [isMuted],
  );

  // Приём входящих событий real-time.
  const onEvent = useCallback(
    async d => {
      const cl = clientRef.current;
      if (!cl || !d) return;
      if (d.kind === 'text' && d.roomId) {
        // Группа или канал (посты каналов тоже приходят kind:'text' с roomId).
        ensureChat(d.roomId, 'group', null); // тип уточнится при следующем refresh
        const added = await appendMsg(d.roomId, {
          id: d.msgId || `r${Date.now()}${Math.random()}`,
          dir: d.from === cl.userId ? 'out' : 'in',
          from: d.from,
          text: d.text,
          preview: d.preview || null,
          ts: Date.now(),
        });
        if (added && d.from !== cl.userId) {
          const chat = chatsRef.current.find(c => c.id === d.roomId);
          onIncoming(d.roomId, chat ? chat.name : 'Группа', `${d.from}: ${d.text}`);
        }
      } else if (d.kind === 'text' && d.from && d.from !== cl.userId) {
        ensureChat(d.from, 'dm', d.from);
        const added = await appendMsg(d.from, {
          id: d.msgId || `r${Date.now()}${Math.random()}`,
          dir: 'in',
          from: d.from,
          text: d.text,
          preview: d.preview || null,
          ts: Date.now(),
        });
        if (added) onIncoming(d.from, nameOf(d.from), d.text);
        // Если чат открыт прямо сейчас — сразу «прочитано» (синие галочки у собеседника).
        if (d.msgId && openChatRef.current === d.from)
          cl.markRead(d.from, [d.msgId]).catch(() => {});
      } else if (d.kind === 'gift' && d.from && d.from !== cl.userId) {
        // 🎁 Входящий подарок.
        ensureChat(d.from, 'dm', d.from);
        const added = await appendMsg(d.from, {
          id: d.msgId || `g${Date.now()}${Math.random()}`,
          dir: 'in',
          from: d.from,
          kind: 'gift',
          gift: d.gift,
          ts: Date.now(),
        });
        if (added) onIncoming(d.from, nameOf(d.from), `🎁 Подарок: ${(d.gift && d.gift.name) || ''}`);
      } else if (d.kind === 'sync-sent' && d.inner && d.inner.t === 'gift') {
        // 🎁 Мой подарок с другого устройства.
        const threadId = d.peer;
        if (threadId) {
          ensureChat(threadId, 'dm', threadId);
          await appendMsg(threadId, {
            id: d.inner.msgId || d.msgId || `g${Date.now()}${Math.random()}`,
            dir: 'out',
            kind: 'gift',
            gift: {emoji: d.inner.emoji, name: d.inner.name, price: d.inner.price, msg: d.inner.msg || '', anon: !!d.inner.anon},
            ts: Date.now(),
          });
        }
      } else if (d.kind === 'call') {
        // Сигналинг звонка (offer/answer/hangup).
        const mgr = ensureCallManager(cl);
        if (d.call && d.call.event === 'offer') {
          // Приватность «Звонки»: молча сбрасываем, если звонить нельзя.
          if (!callAllowedRef.current(d.from)) {
            try { cl.hangupCall(d.from, d.call.callId); } catch {}
            return;
          }
          notifyMessage(d.from, nameOf(d.from), '📞 Входящий звонок');
        }
        mgr.handleSignal(d);
      } else if (d.kind === 'sync-read') {
        // MD4: чат прочитан на другом моём устройстве → гасим непрочитанные и тут.
        const id = d.peer;
        if (id) {
          setUnread(u => (u[id] ? {...u, [id]: 0} : u));
          clearThreadNotification(id);
        }
      } else if (d.kind === 'receipt' && d.from && Array.isArray(d.msgIds)) {
        // Квитанция доставки/прочтения от собеседника → апаем статус исходящих (галочки).
        const target = RECEIPT_RANK[d.status] ? d.status : 'received';
        const ids = new Set(d.msgIds);
        const cur = {...msgsRef.current};
        const thread = cur[d.from];
        if (thread) {
          let changed = false;
          cur[d.from] = thread.map(m => {
            if (
              m.dir === 'out' &&
              m.id &&
              ids.has(m.id) &&
              (RECEIPT_RANK[m.status] || 0) < RECEIPT_RANK[target]
            ) {
              changed = true;
              return {...m, status: target};
            }
            return m;
          });
          if (changed) {
            setMsgs(cur);
            if (clientRef.current) saveMsgs(clientRef.current.userId, cur);
          }
        }
      } else if (d.kind === 'alias' && d.peer) {
        // Псевдоним контакта изменён на другом моём устройстве → применяем и тут.
        const next = {...aliasesRef.current};
        if (d.name) next[d.peer] = d.name;
        else delete next[d.peer];
        setAliases(next);
        setJSON(`pz:aliases:${cl.userId}`, next);
      } else if (d.kind === 'sync-sent' && d.inner && d.inner.t === 'text') {
        // MD3: моё исходящее с другого устройства — личка (peer) или группа (roomId).
        const threadId = d.roomId || d.peer;
        if (!threadId) return;
        ensureChat(threadId, d.roomId ? 'group' : 'dm', threadId);
        await appendMsg(threadId, {
          id: d.inner.msgId || d.msgId || `s${Date.now()}${Math.random()}`,
          dir: 'out',
          text: d.inner.body,
          preview: d.inner.preview || null,
          ts: Date.now(),
        });
      } else if (d.kind === 'attachment' && d.attachment) {
        // Входящее вложение (файл/картинка/голосовое).
        const threadId = d.roomId || d.from;
        const isMine = d.from === cl.userId;
        ensureChat(threadId, d.roomId ? 'group' : 'dm', threadId);
        const mid = d.msgId || `a${Date.now()}${Math.random()}`;
        const added = await appendMsg(threadId, {
          id: mid,
          dir: isMine ? 'out' : 'in',
          from: d.from,
          kind: 'att',
          att: d.attachment,
          ts: Date.now(),
        });
        if (added) {
          hydrateImage(threadId, mid, d.attachment);
          if (!isMine) {
            const prev = d.attachment.voice
              ? '🎤 Голосовое сообщение'
              : d.attachment.videoNote
                ? '📹 Видео-сообщение'
                : (d.attachment.mime || '').startsWith('image/')
                  ? '🖼 Фото'
                  : '📎 ' + (d.attachment.filename || 'Файл');
            onIncoming(threadId, nameOf(d.from), prev);
          }
        }
      } else if (d.kind === 'reaction' && d.from) {
        // Реакция собеседника в личном чате (эмодзи или платный донат призраков).
        if (d.target && d.paid) {
          updateMsg(d.from, d.target, m => ({...m, paid: (m.paid || 0) + d.paid}));
        }
        const emoji = d.emoji;
        if (d.target && emoji) {
          updateMsg(d.from, d.target, m => {
            const theirs = (m.theirs || []).slice();
            if (d.on) {
              if (!theirs.includes(emoji)) theirs.push(emoji);
            } else {
              const i = theirs.indexOf(emoji);
              if (i >= 0) theirs.splice(i, 1);
            }
            return {...m, theirs};
          });
        }
      } else if (d.kind === 'delete') {
        // Собеседник удалил сообщение.
        const threadId = d.roomId || d.from;
        if (threadId && d.msgId) removeMsg(threadId, d.msgId);
      } else if (d.kind === 'sync-sent' && d.inner && d.inner.t === 'att') {
        // MD3: моё вложение с другого устройства.
        const threadId = d.roomId || d.peer;
        if (threadId) {
          const mid = d.inner.msgId || d.msgId || `a${Date.now()}`;
          const added = await appendMsg(threadId, {
            id: mid,
            dir: 'out',
            kind: 'att',
            att: d.inner,
            ts: Date.now(),
          });
          if (added) hydrateImage(threadId, mid, d.inner);
        }
      } else if (d.kind === 'invited' && d.room) {
        ensureChat(
          d.room.id,
          d.room.type === 'channel' ? 'channel' : 'group',
          d.room.name,
        );
      }
      try {
        await Session.persist(cl);
      } catch {}
    },
    [appendMsg, ensureChat, updateMsg, removeMsg, hydrateImage],
  );

  // Обновить список чатов с сервера.
  const refreshDirectory = useCallback(
    async cl => {
      try {
        const list = await fetchDirectory(cl, chatsRef.current);
        if (list.length) {
          setChats(list);
          await Session.saveChats(cl.userId, list);
          refreshNames(cl, list);
        }
      } catch {}
    },
    [refreshNames],
  );

  // Автовосстановление сессии при старте.
  useEffect(() => {
    (async () => {
      try {
        const r = await Session.restore();
        if (r && r.client) {
          // App Lock: если задан PIN — блокируем приложение до разблокировки.
          try {
            const ls = await lockStatus();
            if (ls.pinSet) {
              setLockBio(ls.biometric);
              setLocked(true);
            }
          } catch {}
          setClient(r.client);
          setChats(normChats(r.chats));
          const m = await loadMsgs(r.client.userId);
          setMsgs(m);
          const al = (await getJSON(`pz:aliases:${r.client.userId}`, {})) || {};
          setMutes((await getJSON(`pz:mutes:${r.client.userId}`, {})) || {});
          setAliases(al);
          setScreen('chats');
          ensureCallManager(r.client);
          r.client.connectRealtime(onEvent);
          r.client.getPrivacy().then(pv => { privacyRef.current = pv; }).catch(() => {});
          refreshDirectory(r.client);
          refreshNames(r.client, r.chats);
          return;
        }
      } catch (e) {}
      setScreen('auth');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Таймер длительности активного звонка.
  useEffect(() => {
    if (callState.phase === 'active') {
      setCallSecs(0);
      callDurRef.current = setInterval(() => setCallSecs(s => s + 1), 1000);
    } else if (callDurRef.current) {
      clearInterval(callDurRef.current);
      callDurRef.current = null;
    }
    return () => callDurRef.current && clearInterval(callDurRef.current);
  }, [callState.phase]);

  const ensureCallManager = useCallback(cl => {
    if (!callRef.current || callRef.current.client !== cl) {
      callRef.current = new CallManager(cl, setCallState);
    }
    return callRef.current;
  }, []);

  const afterAuth = useCallback(
    async res => {
      setClient(res.client);
      setChats(normChats(res.chats));
      const m = await loadMsgs(res.client.userId);
      setMsgs(m);
      const al = (await getJSON(`pz:aliases:${res.client.userId}`, {})) || {};
      setMutes((await getJSON(`pz:mutes:${res.client.userId}`, {})) || {});
      setAliases(al);
      ensureCallManager(res.client);
      res.client.connectRealtime(onEvent);
      res.client.getPrivacy().then(pv => { privacyRef.current = pv; }).catch(() => {});
      refreshDirectory(res.client);
      refreshNames(res.client, res.chats);
      // После входа один раз предлагаем задать PIN-код (можно пропустить).
      let prompted = false;
      try {
        prompted = (await getStr('pz:lockPrompted')) === '1' || (await lockEnabled());
      } catch {}
      setScreen(prompted ? 'chats' : 'setpin');
    },
    [onEvent, refreshDirectory, ensureCallManager, refreshNames],
  );

  const doLogout = useCallback(async () => {
    try {
      clientRef.current &&
        clientRef.current.disconnectRealtime &&
        clientRef.current.disconnectRealtime();
    } catch {}
    await Session.logout();
    clearAllNotifications();
    setClient(null);
    setChats([]);
    setMsgs({});
    setUnread({});
    setOpenChatId(null);
    setScreen('auth');
  }, []);

  // Открыть чат; для канала — подтянуть историю с сервера.
  const openChat = useCallback(
    chat => {
      setOpenChatId(chat.id);
      setScreen('chat');
      // Прочитано: гасим счётчик/уведомление и сообщаем другим устройствам (MD4).
      setUnread(u => (u[chat.id] ? {...u, [chat.id]: 0} : u));
      clearThreadNotification(chat.id);
      try {
        clientRef.current && clientRef.current.markReadSync(chat.id).catch(() => {});
      } catch {}
      const cl = clientRef.current;
      // Отправляем собеседнику «прочитано» по входящим (синие галочки).
      // ГОЛОСОВЫЕ исключаем: у них вторая синяя ставится только когда их РЕАЛЬНО
      // прослушали (как в Telegram) — это делает markVoiceListened при нажатии play.
      if (cl && chat.kind === 'dm') {
        const ids = (msgsRef.current[chat.id] || [])
          .filter(
            m =>
              m.dir === 'in' &&
              m.id &&
              !(m.kind === 'att' && m.att && (m.att.voice || m.att.videoNote)),
          )
          .map(m => m.id);
        if (ids.length) cl.markRead(chat.id, ids).catch(() => {});
      }
      if (cl && chat.kind === 'channel') {
        cl.getChannelHistory(chat.id, 0)
          .then(async posts => {
            for (const p of posts) {
              if (p && p.kind === 'text' && p.text != null) {
                await appendMsg(chat.id, {
                  id: p.msgId || `c${p.seq}`,
                  dir: p.from === cl.userId ? 'out' : 'in',
                  from: p.from,
                  text: p.text,
                  ts: Date.now(),
                });
              }
            }
          })
          .catch(() => {});
      }
    },
    [appendMsg],
  );

  const addChat = useCallback(
    peer => {
      const p = (peer || '').trim();
      if (!p || !p.includes(':')) {
        flash('Введите ID вида имя:сервер', 'err');
        return;
      }
      ensureChat(p, 'dm', p);
      openChat({id: p, kind: 'dm', name: p});
    },
    [flash, ensureChat, openChat],
  );

  // Создать группу/канал (тип 'group'|'channel').
  const createRoom = useCallback(
    async (type, name) => {
      const nm = (name || '').trim();
      if (!nm) {
        flash('Введите название', 'err');
        return;
      }
      if (!clientRef.current) return;
      try {
        const room =
          type === 'channel'
            ? await clientRef.current.createChannel(nm)
            : await clientRef.current.createGroup(nm);
        ensureChat(room.id, type, room.name || nm);
        openChat({id: room.id, kind: type, name: room.name || nm});
        flash(type === 'channel' ? 'Канал создан' : 'Группа создана', 'ok');
      } catch (e) {
        flash('Не удалось создать: ' + e.message, 'err');
      }
    },
    [flash, ensureChat, openChat],
  );

  // Вступить в комнату из поиска групп (G5): federated join по roomId.
  const joinRoom = useCallback(
    async (roomId, type, name) => {
      if (!clientRef.current) return;
      try {
        const room = await clientRef.current.join(roomId);
        const kind = (room && room.type) || type || 'group';
        ensureChat(roomId, kind, (room && room.name) || name || roomId);
        openChat({id: roomId, kind, name: (room && room.name) || name || roomId});
        flash('Вы вступили', 'ok');
      } catch (e) {
        flash('Не удалось вступить: ' + e.message, 'err');
      }
    },
    [flash, ensureChat, openChat],
  );

  // Вступить в комнату по пригласительной ссылке (prizrak://join/… или ?join=…).
  const joinLink = useCallback(
    async link => {
      const s = (link || '').trim();
      if (!s) {
        flash('Вставьте ссылку', 'err');
        return;
      }
      if (!clientRef.current) return;
      try {
        const room = await clientRef.current.joinByLink(s);
        const kind = room.type || 'group';
        ensureChat(room.id, kind, room.name || room.id);
        openChat({id: room.id, kind, name: room.name || room.id});
        flash('Вы вступили', 'ok');
      } catch (e) {
        flash('Не удалось вступить: ' + e.message, 'err');
      }
    },
    [flash, ensureChat, openChat],
  );

  const sendText = useCallback(
    async (chat, text) => {
      const cl = clientRef.current;
      const body = (text || '').trim();
      if (!cl || !body) return;
      let msgId = `s${Date.now()}`;
      let resp = null;
      // Превью ссылки собираем МЫ (отправитель) и кладём внутрь шифртекста:
      // получатель никуда не ходит, его IP не утекает владельцу ссылки.
      let preview = null;
      if (previewsRef.current && firstUrl(body)) {
        try { preview = await buildLinkPreview(body); } catch {}
      }
      try {
        resp =
          chat.kind === 'dm'
            ? await cl.send(chat.id, body, preview)
            : await cl.sendToRoom(chat.id, body, preview);
        if (resp && resp.msgId) msgId = resp.msgId;
      } catch (e) {
        flash('Не удалось отправить: ' + (e.message || e), 'err');
        return;
      }
      await appendMsg(chat.id, {
        id: msgId,
        dir: 'out',
        text: body,
        preview,
        ts: Date.now(),
        status: chat.kind === 'dm' ? sendStatus(resp) : undefined,
      });
      try {
        await Session.persist(cl);
      } catch {}
    },
    [flash, appendMsg],
  );

  // Отправить картинку (галерея) как вложение.
  const sendImage = useCallback(
    async chat => {
      const cl = clientRef.current;
      if (!cl) return;
      if (chat.kind !== 'dm')
        return flash('Вложения в группах/каналах — в следующем обновлении', 'err');
      let res;
      try {
        markSystemScreen(); // галерея — не повод просить PIN при возврате
        markSystemScreen(); // галерея — не повод просить PIN при возврате
      const {launchImageLibrary} = require('react-native-image-picker');
        res = await launchImageLibrary({
          mediaType: 'photo',
          includeBase64: true,
          quality: 0.85,
        });
      } catch (e) {
        return flash('Не удалось открыть галерею', 'err');
      }
      if (!res || res.didCancel || !res.assets || !res.assets[0]) return;
      const a = res.assets[0];
      if (!a.base64) return flash('Не удалось прочитать файл', 'err');
      const bin = global.atob(a.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const filename = a.fileName || 'photo.jpg';
      const mime = a.type || 'image/jpeg';
      flash('Отправка изображения…');
      try {
        const r = await cl.sendAttachment(chat.id, bytes, {filename, mime});
        const mid = (r && r.msgId) || `a${Date.now()}`;
        await appendMsg(chat.id, {
          id: mid,
          dir: 'out',
          kind: 'att',
          att: {filename, mime, size: bytes.length},
          uri: `data:${mime};base64,${a.base64}`,
          ts: Date.now(),
          status: sendStatus(r),
        });
      } catch (e) {
        flash('Ошибка отправки: ' + (e.message || e), 'err');
      }
    },
    [flash, appendMsg],
  );

  // Отправить голосовое сообщение (нативная запись → E2E-вложение voice:true).
  const sendVoice = useCallback(
    async (chat, rec) => {
      const cl = clientRef.current;
      if (!cl || !rec || !rec.base64) return;
      if (chat.kind !== 'dm')
        return flash('Голосовые в группах/каналах — в следующем обновлении', 'err');
      const bin = global.atob(rec.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const filename = 'voice.' + (rec.ext || 'm4a');
      const mime = rec.mime || 'audio/mp4';
      const dur = rec.dur || 0;
      const wave = Array.isArray(rec.wave) ? rec.wave : null;
      const mid0 = `a${Date.now()}`;
      // Оптимистично показываем своё голосовое сразу (с локальными байтами для мгновенного проигрывания).
      await appendMsg(chat.id, {
        id: mid0,
        dir: 'out',
        kind: 'att',
        att: {filename, mime, size: bytes.length, voice: true, dur, wave},
        _b64: rec.base64,
        ts: Date.now(),
        status: 'sent',
      });
      try {
        const r = await cl.sendAttachment(chat.id, bytes, {filename, mime, voice: true, dur, wave});
        // Досыпаем mediaId/key/nonce, чтобы можно было переслушать после перезапуска.
        await updateMsg(chat.id, mid0, m => ({
          ...m,
          id: (r && r.msgId) || m.id,
          att: {...m.att, mediaId: r && r.mediaId, key: r && r.key, nonce: r && r.nonce},
          status: sendStatus(r),
        }));
      } catch (e) {
        flash('Ошибка отправки голосового: ' + (e.message || e), 'err');
      }
    },
    [flash, appendMsg, updateMsg],
  );

  // Отправить видео-заметку («кружочек») — нативная запись → E2E-вложение videoNote:true.
  const sendVideoNote = useCallback(
    async (chat, rec) => {
      const cl = clientRef.current;
      if (!cl || !rec || !rec.base64) return;
      if (chat.kind !== 'dm')
        return flash('Видео-сообщения в группах — в следующем обновлении', 'err');
      const bin = global.atob(rec.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const filename = 'video.' + (rec.ext || 'mp4');
      const mime = rec.mime || 'video/mp4';
      const dur = rec.dur || 0;
      const mid0 = `a${Date.now()}`;
      await appendMsg(chat.id, {
        id: mid0,
        dir: 'out',
        kind: 'att',
        att: {filename, mime, size: bytes.length, videoNote: true, dur, w: rec.w, h: rec.h},
        _b64: rec.base64,
        ts: Date.now(),
        status: 'sent',
      });
      try {
        const r = await cl.sendAttachment(chat.id, bytes, {filename, mime, videoNote: true, dur});
        await updateMsg(chat.id, mid0, m => ({
          ...m,
          id: (r && r.msgId) || m.id,
          att: {...m.att, mediaId: r && r.mediaId, key: r && r.key, nonce: r && r.nonce},
          status: sendStatus(r),
        }));
      } catch (e) {
        flash('Ошибка отправки видео: ' + (e.message || e), 'err');
      }
    },
    [flash, appendMsg, updateMsg],
  );

  // Статус собеседника (в сети / был(а) в сети) — тянем с сервера.
  const getPresence = useCallback(userId => {
    const cl = clientRef.current;
    return cl && userId ? cl.presence(userId) : Promise.resolve(null);
  }, []);

  // Просмотрено видео: получатель открыл кружочек → отправитель видит вторую синюю.
  const markNoteWatched = useCallback((chat, item) => {
    const cl = clientRef.current;
    if (cl && chat && chat.kind === 'dm' && item && item.dir === 'in' && item.id)
      cl.markRead(chat.id, [item.id]).catch(() => {});
  }, []);

  // Прослушано: когда получатель нажал play на ВХОДЯЩЕМ голосовом — шлём «прочитано»
  // (вторая синяя галочка у отправителя ставится именно по факту прослушивания).
  const markVoiceListened = useCallback((chat, item) => {
    const cl = clientRef.current;
    if (cl && chat && chat.kind === 'dm' && item && item.dir === 'in' && item.id)
      cl.markRead(chat.id, [item.id]).catch(() => {});
  }, []);

  // Получить байты голосового (base64) для проигрывания: локальные если есть, иначе скачать+расшифровать.
  const getVoiceB64 = useCallback(async item => {
    if (item && item._b64) return item._b64;
    const cl = clientRef.current;
    if (!cl || !item || !item.att) throw new Error('нет данных');
    const bytes = await cl.fetchAttachment(item.att);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return global.btoa(bin);
  }, []);

  const reactMsg = useCallback(
    async (chat, msgId, emoji) => {
      const cl = clientRef.current;
      if (!cl || chat.kind !== 'dm') return;
      // Переключаем свою реакцию локально + шлём собеседнику.
      let on = true;
      await updateMsg(chat.id, msgId, m => {
        const mine = (m.mine || []).slice();
        const i = mine.indexOf(emoji);
        if (i >= 0) {
          mine.splice(i, 1);
          on = false;
        } else mine.push(emoji);
        return {...m, mine};
      });
      try {
        await cl.reactDirect(chat.id, msgId, emoji, on);
      } catch {}
    },
    [updateMsg],
  );

  const deleteMsg = useCallback(
    async (chat, msgId) => {
      const cl = clientRef.current;
      await removeMsg(chat.id, msgId);
      try {
        await cl.deleteMessage(msgId, chat.kind === 'dm' ? chat.id : undefined);
      } catch {}
    },
    [removeMsg],
  );

  // Донат призраков на сообщение (личка): переводит 👻 собеседнику + платная реакция.
  const donateGhosts = useCallback(
    async (chat, msgId, amount) => {
      const cl = clientRef.current;
      if (!cl || chat.kind !== 'dm') return;
      flash(`Отправляю ${amount} 👻…`);
      try {
        await cl.reactPaidDirect(chat.id, msgId, amount);
        await updateMsg(chat.id, msgId, m => ({...m, paid: (m.paid || 0) + amount}));
        flash(`Подарено ${amount} 👻`);
      } catch (e) {
        flash('Не хватает призраков или ошибка: ' + (e.message || e), 'err');
      }
    },
    [flash, updateMsg],
  );

  // ── Действия звонка ────────────────────────────────────────────────────────
  const requestCallPerms = useCallback(async video => {
    if (Platform.OS !== 'android') return true; // iOS: доступ запрашивает сам нативный модуль
    try {
      const perms = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
      if (video) perms.push(PermissionsAndroid.PERMISSIONS.CAMERA);
      const res = await PermissionsAndroid.requestMultiple(perms);
      return Object.values(res).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
    } catch {
      return false;
    }
  }, []);

  const placeCall = useCallback(
    async (peer, video, vcodec = 'vp8') => {
      if (!CALLS_SUPPORTED) return flash('Звонки недоступны на этом устройстве', 'err');
      const ok = await requestCallPerms(video);
      if (!ok) return flash('Нет доступа к микрофону/камере', 'err');
      try {
        if (video && vcodec === 'h264') flash('Видео H.264 (тест)', 'ok');
        await ensureCallManager(clientRef.current).place(peer, video, vcodec);
      } catch (e) {
        flash('Звонок: ' + (e.message || e), 'err');
      }
    },
    [flash, requestCallPerms, ensureCallManager],
  );

  const acceptCall = useCallback(async () => {
    const mgr = callRef.current;
    if (!mgr) return;
    const ok = await requestCallPerms(mgr.media === 'video');
    if (!ok) {
      mgr.decline();
      return flash('Нет доступа к микрофону/камере', 'err');
    }
    clearAllNotifications();
    try {
      await mgr.accept();
    } catch (e) {
      flash('Звонок: ' + (e.message || e), 'err');
    }
  }, [flash, requestCallPerms]);

  const openChatObj =
    chats.find(c => c.id === openChatId) ||
    (openChatId ? {id: openChatId, kind: 'dm', name: openChatId} : null);

  let body;
  if (screen === 'loading') {
    body = (
      <View style={styles.center}>
        <Text style={styles.logo}>👻</Text>
        <ActivityIndicator color={C.accent} size="large" />
      </View>
    );
  } else if (screen === 'auth') {
    body = <AuthScreen onDone={afterAuth} flash={flash} />;
  } else if (screen === 'setpin') {
    body = (
      <SetPinScreen
        canSkip
        flash={flash}
        onDone={async () => {
          try { await setStr('pz:lockPrompted', '1'); } catch {}
          flash('PIN-код установлен', 'ok');
          setScreen('chats');
        }}
        onSkip={async () => {
          try { await setStr('pz:lockPrompted', '1'); } catch {}
          setScreen('chats');
        }}
      />
    );
  } else if (screen === 'chats') {
    body = (
      <ChatsScreen
        client={client}
        chats={chats}
        msgs={msgs}
        unread={unread}
        update={update}
        nameOf={nameOf}
        avatarsMap={avatarsMap}
        isMuted={isMuted}
        onOpen={openChat}
        onAdd={addChat}
        onCreateGroup={name => createRoom('group', name)}
        onCreateChannel={name => createRoom('channel', name)}
        onJoinLink={joinLink}
        onSearchGroups={q => client.searchGroups(q)}
        onJoinRoom={joinRoom}
        onSettings={() => setScreen('settings')}
        onRefresh={() => client && refreshDirectory(client)}
      />
    );
  } else if (screen === 'settings') {
    body = (
      <SettingsScreen
        client={client}
        update={update}
        chats={chats}
        nameOf={nameOf}
        avatarsMap={avatarsMap}
        onSendGiftTo={async (peerId, gift, msg, anon) => {
          const r = await client.sendGift(peerId, {giftId: gift.id, msg, anon});
          await appendMsg(peerId, {
            id: r.msgId || `g${Date.now()}`,
            dir: 'out',
            kind: 'gift',
            gift: {emoji: gift.emoji, name: gift.name, price: gift.price, msg, anon},
            ts: Date.now(),
          });
          flash('Подарок отправлен! 🎁', 'ok');
        }}
        onPrivacy={pv => { privacyRef.current = pv; }} // чтобы звонки сразу учитывали новые правила
        onPreviews={v => { previewsRef.current = v; }}
        onBack={() => setScreen('chats')}
        onLogout={doLogout}
        onCheckUpdate={async () => {
          const u = await checkUpdate().catch(e => ({
            status: 'unreachable',
            reason: (e && e.message) || 'сбой',
          }));
          setUpdate(u && u.status === 'update' ? u : null);
          return u;
        }}
        flash={flash}
      />
    );
  } else if (screen === 'chat' && openChatObj) {
    body = (
      <ChatScreen
        chat={openChatObj}
        msgs={msgs[openChatObj.id] || []}
        onBack={() => setScreen('chats')}
        onSend={t => sendText(openChatObj, t)}
        onCall={placeCall}
        onImage={() => sendImage(openChatObj)}
        onSendVoice={rec => sendVoice(openChatObj, rec)}
        onSendVideoNote={rec => sendVideoNote(openChatObj, rec)}
        getVoiceB64={getVoiceB64}
        onVoiceListened={item => markVoiceListened(openChatObj, item)}
        onNoteWatched={item => markNoteWatched(openChatObj, item)}
        getPresence={getPresence}
        onReact={(mid, emoji) => reactMsg(openChatObj, mid, emoji)}
        onDonate={(mid, amt) => donateGhosts(openChatObj, mid, amt)}
        onDelete={mid => deleteMsg(openChatObj, mid)}
        onForwardAttach={async (att, to) => {
          try {
            await client.forwardAttachment(to, att);
            flash('Переслано: ' + to, 'ok');
          } catch (e) {
            flash('Не переслать: ' + e.message, 'err');
          }
        }}
        onSaveAttach={async m => {
          try {
            const b64 = await getVoiceB64(m); // те же байты: скачать+расшифровать → base64
            const where = await saveToDownloads(m.att && m.att.filename, m.att && m.att.mime, b64);
            flash('Сохранено: ' + where, 'ok');
          } catch (e) {
            flash('Не сохранить: ' + e.message, 'err');
          }
        }}
        onGiftCatalog={() => client.giftCatalog()}
        onGiftSend={async (gift, msg, anon) => {
          const r = await client.sendGift(openChatObj.id, {giftId: gift.id, msg, anon});
          await appendMsg(openChatObj.id, {
            id: r.msgId || `g${Date.now()}`,
            dir: 'out',
            kind: 'gift',
            gift: {emoji: gift.emoji, name: gift.name, price: gift.price, msg, anon},
            ts: Date.now(),
          });
          flash('Подарок отправлен! 🎁', 'ok');
        }}
        nameOf={nameOf}
        avatarUri={avatarsMap[openChatObj.id]}
        alias={aliases[openChatObj.id] || ''}
        onSetAlias={name => setAlias(openChatObj.id, name)}
        muted={isMuted(openChatObj.id)}
        onMute={ms => setMute(openChatObj.id, ms)}
        meId={client ? client.userId : ''}
        onGetRoom={roomId => client.getRoom(roomId)}
        onSaveGroup={async (roomId, settings, retention) => {
          await client.setRoomSettings(roomId, settings);
          try { await client.setRoomRetention(roomId, retention || 'forever'); } catch (e) {}
          // Обновить локальный срок автоудаления, чтобы чистка (G4) применилась сразу.
          setChatsPersist(chatsRef.current.map(c => (c.id === roomId ? {...c, retention: retention === 'forever' ? null : retention} : c)));
        }}
        onInvite={(roomId, userId) => client.invite(roomId, userId)}
        onSaveRoomProfile={async (roomId, fields) => {
          await client.setRoomProfile(roomId, fields);
          // Название/аватар видны сразу в списке чатов, без перезахода.
          setChatsPersist(chatsRef.current.map(c => (c.id === roomId
            ? {...c, name: fields.name || c.name, avatar: fields.avatar || c.avatar} : c)));
        }}
        onGetLink={async roomId => {
          const s = await client.roomShare(roomId);
          // Внешняя веб-ссылка (prizrak.paymoney.online/?join=…): открывается в браузере,
          // а он уже перебрасывает в приложение (prizrak://join/…). Работает у тех, у кого
          // установлен Призрак. Домен позже сменим на prizrak.im.
          return s.link || s.deepLink || '';
        }}
        flash={flash}
      />
    );
  }

  if (locked) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <LockScreen biometric={lockBio} onUnlock={() => setLocked(false)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.panel} />
      {banner && (
        <View
          style={[
            styles.banner,
            banner.kind === 'err' && {backgroundColor: C.danger},
          ]}>
          <Text style={styles.bannerText}>{banner.text}</Text>
        </View>
      )}
      {body}
      {callState.phase !== 'idle' && (
        <CallOverlay
          state={callState}
          title={nameOf(callState.peer)}
          avatarUri={avatarsMap[callState.peer]}
          secs={callSecs}
          onAccept={acceptCall}
          onDecline={() => callRef.current && callRef.current.decline()}
          onHangup={() => callRef.current && callRef.current.end()}
          onMute={m => callRef.current && callRef.current.setMuted(m)}
          onSpeaker={on => callRef.current && callRef.current.setSpeaker(on)}
          onSwitchCam={() => callRef.current && callRef.current.switchCamera()}
        />
      )}
    </SafeAreaView>
  );
}

// ── Экран звонка (входящий / исходящий / активный) ──────────────────────────
function CallOverlay({state, title, avatarUri, secs, onAccept, onDecline, onHangup, onMute, onSpeaker, onSwitchCam}) {
  const {phase, peer, media, muted, path, stats, speaker} = state;
  const shown = title || peer;
  const mmss = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  const status =
    phase === 'incoming'
      ? media === 'video'
        ? 'Входящий видеозвонок'
        : 'Входящий звонок'
      : phase === 'outgoing'
        ? 'Вызов…'
        : mmss;
  const videoActive = media === 'video' && phase === 'active' && VIDEO_SUPPORTED;

  return (
    <View style={styles.callOverlay}>
      {/* Видео собеседника: по центру, с сохранением пропорций (портрет 3:4) */}
      {videoActive && (
        <View style={[StyleSheet.absoluteFill, {alignItems: 'center', justifyContent: 'center', backgroundColor: '#000'}]}>
          <VideoView role="remote" style={{width: '100%', aspectRatio: 480 / 640}} />
        </View>
      )}

      {/* Верхняя плашка с именем/таймером (поверх видео) */}
      <View style={videoActive ? styles.callTopBar : {alignItems: 'center'}}>
        {!videoActive &&
          (avatarUri ? (
            <Image source={{uri: avatarUri}} style={styles.callAvatar} />
          ) : (
            <View style={styles.callAvatar}>
              <Text style={styles.callAvatarText}>
                {(shown || '?').charAt(0).toUpperCase()}
              </Text>
            </View>
          ))}
        <Text style={styles.callPeer}>{shown}</Text>
        <Text style={styles.callStatus}>
          {media === 'video' ? '📹 ' : '📞 '}
          {status}
        </Text>
        {phase === 'active' && (
          <Text style={styles.callPath}>
            {path === 'direct' ? '🔗 прямое соединение' : '📡 через сервер'}
            {stats
              ? `  ·  потери ${stats.loss || 0}‰${
                  media === 'video' && stats.kbps ? `  ·  ${stats.kbps} kbps` : ''
                }`
              : ''}
          </Text>
        )}
      </View>

      {/* Локальное превью в углу */}
      {videoActive && (
        <VideoView role="local" style={styles.localPreview} />
      )}

      {/* Компактный индикатор пути связи в углу: Direct (напрямую) / Relay (через сервер) */}
      {videoActive && phase === 'active' && (
        <View
          style={[
            styles.callPathBadge,
            {backgroundColor: path === 'direct' ? 'rgba(46,158,91,0.85)' : 'rgba(0,0,0,0.55)'},
          ]}>
          <Text style={styles.callPathBadgeText}>
            {path === 'direct' ? '🔗 Direct' : '📡 Relay'}
          </Text>
        </View>
      )}

      <View style={videoActive ? styles.callBtnsBottom : styles.callBtns}>
        {phase === 'incoming' ? (
          <>
            <TouchableOpacity
              style={[styles.callBtn, {backgroundColor: C.danger}]}
              onPress={onDecline}>
              <Text style={styles.callBtnIcon}>✕</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.callBtn, {backgroundColor: '#2e9e5b'}]}
              onPress={onAccept}>
              <Text style={styles.callBtnIcon}>✓</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {phase === 'active' && (
              <TouchableOpacity
                style={[styles.callBtn, {backgroundColor: muted ? C.accent : C.panel2}]}
                onPress={() => onMute(!muted)}>
                <Text style={styles.callBtnIcon}>{muted ? '🔇' : '🎤'}</Text>
              </TouchableOpacity>
            )}
            {phase === 'active' && (
              <TouchableOpacity
                style={[styles.callBtn, {backgroundColor: speaker ? C.accent : C.panel2}]}
                onPress={() => onSpeaker(!speaker)}>
                <Text style={styles.callBtnIcon}>{speaker ? '🔊' : '🔈'}</Text>
              </TouchableOpacity>
            )}
            {videoActive && (
              <TouchableOpacity
                style={[styles.callBtn, {backgroundColor: C.panel2}]}
                onPress={onSwitchCam}>
                <Text style={styles.callBtnIcon}>🔄</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.callBtn, {backgroundColor: C.danger}]}
              onPress={onHangup}>
              <Text style={styles.callBtnIcon}>✕</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

// ── Экран входа/регистрации ─────────────────────────────────────────────────
function AuthScreen({onDone, flash}) {
  const [mode, setMode] = useState('login'); // login|register|restore
  const [serverId, setServerId] = useState(SERVERS[0].id);
  const [customDomain, setCustomDomain] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [backupText, setBackupText] = useState('');
  const [filePass, setFilePass] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(''); // живой статус на кнопке («Создание PGP-ключей…» и т.д.)

  const domain =
    serverId === 'custom'
      ? customDomain.trim()
      : SERVERS.find(s => s.id === serverId).domain;

  const submit = async () => {
    if (mode === 'restore') {
      if (!backupText.trim()) return flash('Вставьте содержимое файла копии', 'err');
      if (!filePass) return flash('Введите пароль файла', 'err');
      if (!password) return flash('Введите пароль аккаунта', 'err');
      setBusy(true);
      setStage('Подготовка…');
      try {
        const res = await Session.importAccount({
          backupText: backupText.trim(),
          filePassword: filePass,
          accountPassword: password,
          onStage: setStage,
        });
        await onDone(res);
      } catch (e) {
        flash('Восстановление: ' + (e.message || e), 'err');
      } finally {
        setBusy(false);
        setStage('');
      }
      return;
    }
    if (!login.trim()) return flash('Введите логин', 'err');
    if (!domain) return flash('Укажите сервер', 'err');
    if (!password) return flash('Введите пароль', 'err');
    if (mode === 'register' && password !== confirm)
      return flash('Пароли не совпадают', 'err');
    setBusy(true);
    setStage(mode === 'register' ? 'Регистрация…' : 'Вход…');
    try {
      const args = {login: login.trim(), domain, password, onStage: setStage};
      const res =
        mode === 'register'
          ? await Session.register(args)
          : await Session.login(args);
      await onDone(res);
    } catch (e) {
      flash(
        (mode === 'register' ? 'Регистрация' : 'Вход') + ': ' + (e.message || e),
        'err',
      );
    } finally {
      setBusy(false);
      setStage('');
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{flex: 1}}>
      <ScrollView
        contentContainerStyle={styles.authWrap}
        keyboardShouldPersistTaps="handled">
        <Text style={styles.logoBig}>👻</Text>
        <Text style={styles.title}>Prizrak</Text>
        <Text style={styles.subtitle}>
          {mode === 'register'
            ? 'Создать аккаунт'
            : mode === 'restore'
              ? 'Восстановление из копии'
              : 'Вход в аккаунт'}
        </Text>

        {mode === 'restore' && (
          <>
            <Text style={styles.label}>Содержимое файла копии (вставьте текст)</Text>
            <TextInput
              style={[styles.input, {minHeight: 90, textAlignVertical: 'top'}]}
              placeholder='{"v":1,"kind":"prizrak-account-backup",…}'
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              value={backupText}
              onChangeText={setBackupText}
            />
            <Text style={styles.label}>Пароль файла</Text>
            <TextInput
              style={styles.input}
              placeholder="пароль, которым запечатан файл"
              placeholderTextColor={C.sub}
              secureTextEntry
              value={filePass}
              onChangeText={setFilePass}
            />
            <Text style={styles.label}>Пароль аккаунта</Text>
            <TextInput
              style={styles.input}
              placeholder="пароль на сервере"
              placeholderTextColor={C.sub}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
            <TouchableOpacity
              style={[styles.primaryBtn, busy && {opacity: 0.6}]}
              disabled={busy}
              onPress={submit}>
              {busy ? (
                <View style={styles.btnStageRow}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={styles.btnStageText}>{stage || 'Восстановление…'}</Text>
                </View>
              ) : (
                <Text style={styles.primaryBtnText}>Восстановить</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setMode('login')}>
              <Text style={styles.switchText}>← Назад ко входу</Text>
            </TouchableOpacity>
          </>
        )}

        {mode !== 'restore' && (
        <>
        <Text style={styles.label}>Сервер</Text>
        <View style={styles.serverRow}>
          {SERVERS.map(s => (
            <TouchableOpacity
              key={s.id}
              style={[
                styles.serverChip,
                serverId === s.id && styles.serverChipOn,
              ]}
              onPress={() => setServerId(s.id)}>
              <Text
                style={[
                  styles.serverChipText,
                  serverId === s.id && {color: '#fff'},
                ]}>
                {s.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        {serverId === 'custom' && (
          <TextInput
            style={styles.input}
            placeholder="домен, напр. my.server.org"
            placeholderTextColor={C.sub}
            autoCapitalize="none"
            autoCorrect={false}
            value={customDomain}
            onChangeText={setCustomDomain}
          />
        )}

        <Text style={styles.label}>Логин (без сервера — он добавится сам)</Text>
        <TextInput
          style={styles.input}
          placeholder="напр. root"
          placeholderTextColor={C.sub}
          autoCapitalize="none"
          autoCorrect={false}
          value={login}
          onChangeText={setLogin}
        />
        {!!login.trim() && (
          <Text style={styles.hint}>
            Ваш полный ID: {login.trim().replace(/:.*$/, '')}:{domain || '…'}
          </Text>
        )}

        <Text style={styles.label}>Пароль</Text>
        <TextInput
          style={styles.input}
          placeholder="пароль"
          placeholderTextColor={C.sub}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {mode === 'register' && (
          <>
            <Text style={styles.label}>Подтверждение пароля</Text>
            <TextInput
              style={styles.input}
              placeholder="повторите пароль"
              placeholderTextColor={C.sub}
              secureTextEntry
              value={confirm}
              onChangeText={setConfirm}
            />
          </>
        )}

        <TouchableOpacity
          style={[styles.primaryBtn, busy && {opacity: 0.6}]}
          disabled={busy}
          onPress={submit}>
          {busy ? (
            <View style={styles.btnStageRow}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.btnStageText}>
                {stage || (mode === 'register' ? 'Регистрация…' : 'Вход…')}
              </Text>
            </View>
          ) : (
            <Text style={styles.primaryBtnText}>
              {mode === 'register' ? 'Зарегистрироваться' : 'Войти'}
            </Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setMode(mode === 'register' ? 'login' : 'register')}>
          <Text style={styles.switchText}>
            {mode === 'register'
              ? 'У меня уже есть аккаунт — Войти'
              : 'Нет аккаунта — Зарегистрироваться'}
          </Text>
        </TouchableOpacity>
        {mode === 'login' && (
          <TouchableOpacity onPress={() => setMode('restore')}>
            <Text style={[styles.switchText, {marginTop: 10}]}>
              Восстановить из копии аккаунта
            </Text>
          </TouchableOpacity>
        )}
        </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── Список чатов ────────────────────────────────────────────────────────────
function ChatsScreen({client, chats, msgs, unread, update, nameOf, avatarsMap, isMuted, onOpen, onAdd, onCreateGroup, onCreateChannel, onJoinLink, onSearchGroups, onJoinRoom, onSettings, onRefresh}) {
  const [menu, setMenu] = useState(false); // открыто ли меню ＋
  const [mode, setMode] = useState(null); // 'dm'|'group'|'channel'|'link'|'search'
  const [text, setText] = useState('');
  const [found, setFound] = useState(null); // результаты поиска групп (null = ещё не искали)
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef(null);

  const closeMenu = () => {
    setMenu(false);
    setMode(null);
    setText('');
    setFound(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
  };
  const submit = () => {
    const v = text;
    if (mode === 'dm') onAdd(v);
    else if (mode === 'group') onCreateGroup(v);
    else if (mode === 'channel') onCreateChannel(v);
    else if (mode === 'link') onJoinLink(v);
    else if (mode === 'search') return; // поиск живой, по вводу
    closeMenu();
  };
  // Живой поиск публичных групп (debounce 400мс).
  const onSearchText = v => {
    setText(v);
    if (mode !== 'search') return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = v.trim();
    if (q.length < 2) {
      setFound(null);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        setFound(await onSearchGroups(q));
      } catch {
        setFound([]);
      }
      setSearching(false);
    }, 400);
  };
  const MODE_PH = {
    dm: 'ID собеседника: имя:сервер',
    group: 'Название группы',
    channel: 'Название канала',
    link: 'Ссылка prizrak://join/…',
    search: 'Поиск групп: например, рыбалка',
  };

  return (
    <View style={{flex: 1}}>
      <View style={styles.header}>
        <View style={{flex: 1}}>
          <Text style={styles.headerTitle}>Чаты</Text>
          <Text style={styles.headerSub}>{client ? client.userId : ''}</Text>
        </View>
        <TouchableOpacity onPress={onRefresh} style={styles.iconBtn}>
          <Text style={[styles.iconBtnText, {fontSize: 20}]}>⟳</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => (menu ? closeMenu() : setMenu(true))}
          style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>＋</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onSettings} style={styles.iconBtn}>
          <Text style={[styles.iconBtnText, {fontSize: 22}]}>⚙︎</Text>
        </TouchableOpacity>
      </View>

      {menu && mode === null && (
        <View style={styles.newMenu}>
          <TouchableOpacity style={styles.newItem} onPress={() => setMode('dm')}>
            <Text style={styles.newIco}>💬</Text>
            <Text style={styles.newLbl}>Новый чат</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.newItem} onPress={() => setMode('group')}>
            <Text style={styles.newIco}>👥</Text>
            <Text style={styles.newLbl}>Создать группу</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.newItem} onPress={() => setMode('channel')}>
            <Text style={styles.newIco}>📢</Text>
            <Text style={styles.newLbl}>Создать канал</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.newItem} onPress={() => setMode('link')}>
            <Text style={styles.newIco}>🔗</Text>
            <Text style={styles.newLbl}>Вступить по ссылке</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.newItem} onPress={() => setMode('search')}>
            <Text style={styles.newIco}>🔍</Text>
            <Text style={styles.newLbl}>Поиск групп</Text>
          </TouchableOpacity>
        </View>
      )}

      {menu && mode !== null && (
        <View style={styles.addRow}>
          <TextInput
            style={[styles.input, {flex: 1, marginBottom: 0}]}
            placeholder={MODE_PH[mode]}
            placeholderTextColor={C.sub}
            autoCapitalize={mode === 'dm' || mode === 'link' || mode === 'search' ? 'none' : 'sentences'}
            autoCorrect={false}
            value={text}
            onChangeText={onSearchText}
            autoFocus
          />
          {mode !== 'search' && (
            <TouchableOpacity style={styles.addBtn} onPress={submit}>
              <Text style={styles.primaryBtnText}>OK</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {menu && mode === 'search' && found !== null && (
        <View style={{maxHeight: 300, backgroundColor: C.panel2}}>
          {searching && <ActivityIndicator color={C.accent} style={{margin: 10}} />}
          {!searching && found.length === 0 && (
            <Text style={[styles.empty, {padding: 14}]}>Ничего не найдено</Text>
          )}
          <FlatList
            data={found}
            keyExtractor={r => r.roomId}
            keyboardShouldPersistTaps="handled"
            renderItem={({item: r}) => (
              <TouchableOpacity
                style={styles.newItem}
                onPress={() => {
                  closeMenu();
                  onJoinRoom(r.roomId, r.type, r.name);
                }}>
                <Text style={styles.newIco}>{r.type === 'channel' ? '📢' : '👥'}</Text>
                <View style={{flex: 1}}>
                  <Text style={styles.newLbl} numberOfLines={1}>
                    {r.name || r.roomId}
                  </Text>
                  <Text style={{color: C.sub, fontSize: 12}} numberOfLines={1}>
                    {r.domain} · участников: {r.members || 0}
                    {r.description ? ' · ' + r.description : ''}
                  </Text>
                </View>
                <Text style={{color: C.accent, fontSize: 13, fontWeight: '600'}}>Вступить</Text>
              </TouchableOpacity>
            )}
          />
        </View>
      )}

      {chats.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>
            Нет чатов.{'\n'}Нажмите ⟳ чтобы загрузить с сервера,{'\n'}или ＋
            чтобы добавить собеседника.
          </Text>
        </View>
      ) : (
        <FlatList
          data={chats}
          keyExtractor={c => c.id}
          renderItem={({item}) => {
            const thread = msgs[item.id] || [];
            const last = thread[thread.length - 1];
            return (
              <TouchableOpacity
                style={styles.chatRow}
                onPress={() => onOpen(item)}>
                <View style={{marginRight: 12}}>
                  <Avatar
                    uri={avatarsMap[item.id]}
                    kind={item.kind}
                    label={item.kind === 'dm' ? nameOf(item.id) : item.name || item.id}
                  />
                </View>
                <View style={{flex: 1}}>
                  <Text style={styles.chatName} numberOfLines={1}>
                    {KIND_ICON[item.kind]}
                    {item.kind === 'dm' ? nameOf(item.id) : item.name || item.id}
                    {isMuted && isMuted(item.id) ? '  🔕' : ''}
                  </Text>
                  <Text style={styles.chatPreview} numberOfLines={1}>
                    {last
                      ? (last.dir === 'out' ? 'Вы: ' : '') + last.text
                      : item.kind === 'channel'
                        ? 'Канал'
                        : item.kind === 'group'
                          ? 'Группа'
                          : item.id}
                  </Text>
                </View>
                {unread && unread[item.id] > 0 && (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadText}>
                      {unread[item.id] > 99 ? '99+' : unread[item.id]}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}
      {update && (
        <TouchableOpacity
          style={styles.updateBar}
          onPress={() => { markSystemScreen(); Linking.openURL(update.url).catch(() => {}); }}>
          <Text style={styles.updateBarText}>
            ⬇︎ Обновить Prizrak до {update.version}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Настройки (паритет с десктопом: профиль, звук, устройства, сид-фраза,
//    копия аккаунта, обновления, выход) ─────────────────────────────────────
// Подпись значения политики в списке настроек: «Все» / «Мои контакты» / «Никто (+3)».
function modeLabel(mode, extra) {
  const base = mode === 'none' ? 'Никто' : mode === 'contacts' ? 'Мои контакты' : 'Все';
  return extra > 0 ? `${base} (+${extra})` : base;
}

// 🔒 Экран приватности: чёрный список ИЛИ политика (группы/звонки) с исключениями.
// Один компонент на три экрана — вёрстка одинаковая, как в Telegram.
function PrivacyScreen({kind, priv, onSave, onBack, nameOf, flash}) {
  const [add, setAdd] = useState('');
  const isBlocked = kind === 'blocked';
  const title = isBlocked ? 'Чёрный список' : kind === 'groups' ? 'Группы и каналы' : 'Звонки';
  const modeKey = kind === 'groups' ? 'groups' : 'calls';
  const allowKey = kind === 'groups' ? 'groupsAllow' : 'callsAllow';
  const mode = priv[modeKey] || 'all';
  const allow = priv[allowKey] || [];
  const blocked = priv.blocked || [];

  const addId = () => {
    const id = add.trim().replace(/^@/, '');
    if (!/^[^:\s]+:[^:\s]+$/.test(id)) return flash('Введите полный ID: ник:домен', 'err');
    const list = isBlocked ? blocked : allow;
    if (list.includes(id)) return flash('Уже в списке', 'err');
    setAdd('');
    onSave({...priv, [isBlocked ? 'blocked' : allowKey]: [...list, id]});
  };
  const removeId = id => {
    const key = isBlocked ? 'blocked' : allowKey;
    onSave({...priv, [key]: (priv[key] || []).filter(x => x !== id)});
  };

  const Radio = ({value, label}) => (
    <TouchableOpacity style={styles.privRadioRow} onPress={() => onSave({...priv, [modeKey]: value})}>
      <Text style={styles.privRadioLbl}>{label}</Text>
      {mode === value && <Text style={styles.privCheck}>✓</Text>}
    </TouchableOpacity>
  );

  return (
    <View style={{flex: 1}}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>‹</Text>
        </TouchableOpacity>
        <View style={{flex: 1}}>
          <Text style={styles.headerTitle}>{title}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{padding: 14, paddingBottom: 30}}>
        {!isBlocked && (
          <>
            <Text style={styles.privCap}>
              {kind === 'groups' ? 'КТО МОЖЕТ ДОБАВЛЯТЬ МЕНЯ В ГРУППЫ' : 'КТО МОЖЕТ МНЕ ЗВОНИТЬ'}
            </Text>
            <View style={styles.setCard}>
              <Radio value="all" label="Все" />
              <View style={styles.privSep} />
              <Radio value="contacts" label="Мои контакты" />
              <View style={styles.privSep} />
              <Radio value="none" label="Никто" />
            </View>
            <Text style={styles.privHint}>
              {kind === 'groups'
                ? 'Вы можете выбрать, кому разрешаете приглашать Вас в группы и каналы.'
                : 'Вы можете выбрать, кто может звонить Вам в Призраке.'}
            </Text>
            <Text style={styles.privCap}>ВСЕГДА РАЗРЕШАТЬ</Text>
          </>
        )}

        <View style={styles.setCard}>
          <View style={styles.privAddRow}>
            <TextInput
              style={styles.privInput}
              placeholder="ник:домен"
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              autoCorrect={false}
              value={add}
              onChangeText={setAdd}
              onSubmitEditing={addId}
            />
            <TouchableOpacity style={styles.privAddBtn} onPress={addId}>
              <Text style={styles.primaryBtnText}>Добавить</Text>
            </TouchableOpacity>
          </View>
          {(isBlocked ? blocked : allow).length === 0 ? (
            <Text style={[styles.privHint, {padding: 14, paddingTop: 4}]}>
              {isBlocked ? 'Список пуст. Добавьте тех, от кого не хотите получать сообщения и звонки.' : 'Список исключений пуст.'}
            </Text>
          ) : (
            (isBlocked ? blocked : allow).map(id => (
              <View key={id} style={[styles.privItem, {borderTopWidth: 1, borderTopColor: C.line}]}>
                <Avatar label={nameOf(id)} size={36} />
                <View style={{flex: 1, marginLeft: 10}}>
                  <Text style={styles.setValue} numberOfLines={1}>{nameOf(id)}</Text>
                  <Text style={styles.setHintSm} numberOfLines={1}>{id}</Text>
                </View>
                <TouchableOpacity onPress={() => removeId(id)} style={{padding: 6}}>
                  <Text style={{color: C.danger, fontSize: 15, fontWeight: '600'}}>{isBlocked ? 'Разблокировать' : 'Убрать'}</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        <Text style={styles.privHint}>
          {isBlocked
            ? 'Заблокированные не могут писать вам и звонить, а также добавлять вас в группы. Они не узнают, что заблокированы.'
            : 'Эти пользователи получают доступ независимо от настройки выше.'}
        </Text>
      </ScrollView>
    </View>
  );
}

// Имя+флаг страны по ISO-коду (краткий локальный справочник для UI).
const VPN_COUNTRY = {
  FR: ['Франция', '🇫🇷'], DE: ['Германия', '🇩🇪'], NL: ['Нидерланды', '🇳🇱'], SE: ['Швеция', '🇸🇪'],
  GB: ['Великобритания', '🇬🇧'], US: ['США', '🇺🇸'], CH: ['Швейцария', '🇨🇭'], ES: ['Испания', '🇪🇸'],
  PL: ['Польша', '🇵🇱'], FI: ['Финляндия', '🇫🇮'], NO: ['Норвегия', '🇳🇴'], CA: ['Канада', '🇨🇦'],
};
function countryLabel(code) { const c = VPN_COUNTRY[code]; return c ? c[1] + ' ' + c[0] : code; }

// Звёзды рейтинга «4.35 из 5» + пять символов.
function Stars({value}) {
  if (value == null) return <Text style={{color: C.sub, fontSize: 12}}>нет оценок</Text>;
  const full = Math.round(value);
  return (
    <View style={{flexDirection: 'row', alignItems: 'center'}}>
      <Text style={{color: '#f5c518', fontSize: 13, letterSpacing: 1}}>
        {'★'.repeat(full)}
        <Text style={{color: C.line}}>{'★'.repeat(5 - full)}</Text>
      </Text>
      <Text style={{color: C.sub, fontSize: 12, marginLeft: 6}}>{value.toFixed(2)} из 5</Text>
    </View>
  );
}

// Экран VPN «Призрак-Транспорт»: два переключателя + выбор страны с рейтингом.
function VpnScreen({client, onBack, onPickCountry, flash}) {
  const [status, setStatus] = useState({state: 'off', country: null, node: false, available: Vpn.vpnAvailable()});
  const [countries, setCountries] = useState(null);
  const [busy, setBusy] = useState(false);
  const [paidUntil, setPaidUntil] = useState(0);   // «оплачено до <unix>»

  useEffect(() => {
    Vpn.vpnStatus().then(setStatus).catch(() => {});
    const offS = Vpn.onVpnState(s => setStatus(st => ({...st, ...(typeof s === 'string' ? {state: s} : s)})));
    const offN = Vpn.onVpnNotice(n => flash(n && n.text ? n.text : 'VPN', 'ok'));
    return () => { offS(); offN(); };
  }, [flash]);

  // Страны (с рейтингом) и статус подписки — из Банка.
  useEffect(() => {
    if (!client) { setCountries([]); return; }
    if (client.vpnCountries) client.vpnCountries().then(l => setCountries(l || [])).catch(() => setCountries([]));
    if (client.vpnSub) client.vpnSub().then(setPaidUntil).catch(() => {});
  }, [client]);

  const now = Math.floor(Date.now() / 1000);
  const paid = paidUntil > now;
  const paidText = paid ? 'Оплачено до ' + new Date(paidUntil * 1000).toLocaleDateString('ru-RU') : 'Не оплачено';
  const masking = ['up', 'connecting', 'switching', 'searching'].includes(status.state);
  const stateLabel = {off: 'выключено', connecting: 'подключаюсь…', up: 'включено', switching: 'переключаю…', searching: 'ищу узел…'}[status.state] || '';

  // Получить ордер у Банка и поднять туннель в выбранной стране.
  const connect = async code => {
    const r = await client.vpnConnect(code);   // бросит, если не оплачено / нет узлов
    if (!r || !r.order) throw new Error(r && r.error ? r.error : 'нет ордера');
    const creds = await client.vpnCreds();     // доступ к Банку для нативного always-on
    await Vpn.maskOn(r.order, creds);
    setStatus(s => ({...s, state: 'up', country: r.order.country}));
    if (r.paidUntil) setPaidUntil(r.paidUntil);
  };
  const pay = async () => {
    setBusy(true);
    try {
      const r = await client.vpnSubscribe(1);
      setPaidUntil(r.paidUntil || 0);
      flash('VPN оплачен 🛡', 'ok');
    } catch (e) { flash('Оплата: ' + e.message, 'err'); }
    setBusy(false);
  };
  const toggleMask = async v => {
    if (!status.available) { flash('VPN недоступен на этой сборке', 'err'); return; }
    if (v && !paid) { flash('Сначала оплатите VPN', 'err'); return; }
    setBusy(true);
    try {
      if (v) await connect(status.country || (countries && countries[0] && countries[0].code) || 'FR');
      else await Vpn.maskOff();
    } catch (e) { flash('VPN: ' + e.message, 'err'); }
    setBusy(false);
  };
  const toggleNode = async v => {
    if (!status.available) { flash('VPN недоступен на этой сборке', 'err'); return; }
    setBusy(true);
    try { if (v) await Vpn.nodeOn(); else await Vpn.nodeOff(); setStatus(s => ({...s, node: v})); }
    catch (e) { flash('Узел: ' + e.message, 'err'); }
    setBusy(false);
  };
  const chooseCountry = async c => {
    if (!paid) { flash('Сначала оплатите VPN', 'err'); return; }
    setBusy(true);
    try { await connect(c.code); }
    catch (e) { flash('Страна: ' + e.message, 'err'); }
    setBusy(false);
  };

  return (
    <View style={{flex: 1}}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.iconBtn}><Text style={styles.iconBtnText}>‹</Text></TouchableOpacity>
        <View style={{flex: 1}}>
          <Text style={styles.headerTitle}>🛡 Призрак-VPN</Text>
          <Text style={styles.headerSub}>{stateLabel}{status.country ? ' · ' + countryLabel(status.country) : ''}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{padding: 14, paddingBottom: 30}}>
        {!status.available && (
          <View style={[styles.setCard, {borderColor: '#e0a355'}]}>
            <Text style={{color: C.text}}>Маскировка появится в сборке с нативным модулем VPN. Ниже — интерфейс и выбор страны.</Text>
          </View>
        )}

        <Text style={styles.setSection}>Подписка</Text>
        <View style={styles.setCard}>
          <View style={styles.setRow}>
            <Text style={[styles.privIco, {backgroundColor: paid ? '#42b96b' : '#e0555a'}]}>🛡</Text>
            <View style={{flex: 1}}>
              <Text style={styles.setValue}>{paidText}</Text>
              <Text style={styles.setHintSm}>{paid ? 'VPN активен — выберите страну и включите' : 'Оплатите призраками, чтобы пользоваться VPN'}</Text>
            </View>
          </View>
          <TouchableOpacity style={[styles.primaryBtn, {marginTop: 6}]} disabled={busy} onPress={pay}>
            <Text style={styles.primaryBtnText}>{paid ? 'Продлить на месяц' : 'Оплатить VPN'}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.setSection}>Трафик устройства</Text>
        <View style={styles.setCard}>
          <View style={styles.setRow}>
            <View style={{flex: 1}}>
              <Text style={styles.setValue}>Замаскироваться</Text>
              <Text style={styles.setHintSm}>Весь трафик устройства пойдёт через Призрак. Сообщения и звонки Призрака идут напрямую.</Text>
            </View>
            <Switch value={masking} onValueChange={toggleMask} disabled={busy} trackColor={{true: C.accent}} />
          </View>
          <View style={[styles.setRow, {borderTopWidth: 1, borderTopColor: C.line}]}>
            <View style={{flex: 1}}>
              <Text style={styles.setValue}>Поднять призрак-узел</Text>
              <Text style={styles.setHintSm}>Стать промежуточным узлом сети и зарабатывать 👻.</Text>
            </View>
            <Switch value={!!status.node} onValueChange={toggleNode} disabled={busy} trackColor={{true: C.accent}} />
          </View>
        </View>

        <Text style={styles.setSection}>Страна выхода</Text>
        <View style={styles.setCard}>
          {countries == null && <Text style={{color: C.sub, padding: 8}}>Загружаю страны…</Text>}
          {countries != null && countries.length === 0 && (
            <Text style={{color: C.sub, padding: 8}}>Пока нет доступных выходов. Появятся, как только заработают узлы.</Text>
          )}
          {countries != null && countries.map((c, i) => (
            <TouchableOpacity
              key={c.code}
              style={[styles.setRow, i > 0 && {borderTopWidth: 1, borderTopColor: C.line}]}
              onPress={() => chooseCountry(c)}
              disabled={busy}>
              <Text style={{fontSize: 22, marginRight: 10}}>{c.flag}</Text>
              <View style={{flex: 1}}>
                <Text style={styles.setValue}>{c.name}</Text>
                <Stars value={c.rating} />
              </View>
              <Text style={{color: C.sub, fontSize: 12, marginRight: 8}}>{c.nodes} узл.</Text>
              {status.country === c.code
                ? <Text style={{color: C.accent, fontSize: 16}}>✓</Text>
                : <Text style={styles.privChev}>›</Text>}
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.setHintSm}>
          Смена страны на лету: сначала поднимается новый выход, потом рвётся старый — уже открытые соединения (загрузки, звонки в сторонних приложениях) при смене IP оборвутся.
        </Text>

      </ScrollView>
    </View>
  );
}

function SettingsScreen({client, update, chats, nameOf, avatarsMap, onSendGiftTo, onBack, onLogout, onCheckUpdate, onPrivacy, onPreviews, flash}) {
  const [giftPick, setGiftPick] = useState(false);   // экран выбора получателя подарка
  const [giftPeer, setGiftPeer] = useState(null);    // выбранный получатель → магазин подарков
  const [sound, setSound] = useState(soundEnabled());
  const [lock, setLock] = useState({pinSet: false, biometric: false});
  const [bioAvail, setBioAvail] = useState(false);
  const [autolock, setAutolock] = useState(60); // пауза перед запросом PIN, сек
  const [pinModal, setPinModal] = useState(false);
  const [myGifts, setMyGifts] = useState(null); // 🎁 мои подарки (null = не загружали)
  const [giftPct, setGiftPct] = useState(50);
  const loadMyGifts = useCallback(() => {
    client && client.myGifts().then(d => { setMyGifts(d.gifts || []); setGiftPct(d.convertPct || 50); }).catch(e => flash('Подарки: ' + e.message, 'err'));
  }, [client, flash]);
  const [devices, setDevices] = useState(null);
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState(null);
  const [buyAmt, setBuyAmt] = useState('100');
  const [myNodes, setMyNodes] = useState(null);
  const [bindCode, setBindCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [birthday, setBirthday] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUri, setAvatarUri] = useState('');
  const [avatarObj, setAvatarObj] = useState(null); // {mime,data} для сохранения
  // Конфиденциальность: ЧС + политики «Группы и каналы» / «Звонки»
  const [linkPrev, setLinkPrev] = useState(true);    // превью ссылок (по умолчанию вкл)
  useEffect(() => { getStr('pz:linkPreviews').then(v => setLinkPrev(v !== '0')).catch(() => {}); }, []);
  const [priv, setPriv] = useState(null);            // null = ещё грузим
  const [privScreen, setPrivScreen] = useState(null); // 'blocked'|'groups'|'calls'
  const [vpnScreen, setVpnScreen] = useState(false);  // экран Призрак-VPN
  useEffect(() => {
    if (!client) return;
    client.getPrivacy()
      .then(pv => { setPriv(pv); onPrivacy && onPrivacy(pv); })
      .catch(() => setPriv({blocked: [], groups: 'all', groupsAllow: [], calls: 'all', callsAllow: []}));
  }, [client, onPrivacy]);
  const savePriv = useCallback(async next => {
    setPriv(next); onPrivacy && onPrivacy(next);      // оптимистично — UI не «моргает»
    try { const saved = await client.setPrivacy(next); setPriv(saved); onPrivacy && onPrivacy(saved); }
    catch (e) { flash('Настройки: ' + e.message, 'err'); }
  }, [client, flash, onPrivacy]);

  useEffect(() => {
    lockStatus().then(setLock).catch(() => {});
    getAutolockSec().then(setAutolock).catch(() => {});
    biometricAvailable().then(r => setBioAvail(!!(r && r.available))).catch(() => {});
  }, []);

  useEffect(() => {
    client &&
      client
        .myDevices()
        .then(setDevices)
        .catch(() => setDevices([]));
    client &&
      client
        .getProfile(client.userId)
        .then(p => {
          if (p) {
            setDisplayName(p.displayName && p.displayName !== client.userId.split(':')[0] ? p.displayName : '');
            setBirthday(p.birthday || '');
            setBio(p.bio || '');
            if (p.avatar) {
              setAvatarObj(p.avatar);
              setAvatarUri(avatarToUri(p.avatar));
            }
          }
        })
        .catch(() => {});
  }, [client]);

  const pickAvatar = async () => {
    try {
      markSystemScreen(); // галерея — не повод просить PIN при возврате
      const {launchImageLibrary} = require('react-native-image-picker');
      const res = await launchImageLibrary({
        mediaType: 'photo',
        includeBase64: true,
        maxWidth: 256,
        maxHeight: 256,
        quality: 0.8,
      });
      if (!res || res.didCancel || !res.assets || !res.assets[0]) return;
      const a = res.assets[0];
      if (!a.base64) return flash('Не удалось прочитать фото', 'err');
      if (a.base64.length > 700000) return flash('Аватар слишком большой (макс ~512КБ)', 'err');
      const obj = {mime: a.type || 'image/jpeg', data: a.base64};
      setAvatarObj(obj);
      setAvatarUri(`data:${obj.mime};base64,${obj.data}`);
    } catch {
      flash('Не удалось открыть галерею', 'err');
    }
  };

  const saveProfile = async () => {
    setBusy(true);
    try {
      const fields = {
        displayName: displayName.trim() || client.userId.split(':')[0],
        birthday: birthday.trim(),
        bio: bio.trim(),
      };
      if (avatarObj) fields.avatar = avatarObj;
      await client.setProfile(fields);
      flash('Профиль сохранён');
    } catch (e) {
      flash('Ошибка: ' + (e.message || e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const loadBalance = useCallback(() => {
    client &&
      client
        .bankBalance()
        .then(setBalance)
        .catch(() => setBalance(0));
  }, [client]);
  useEffect(() => {
    loadBalance();
  }, [loadBalance]);

  const buyGhosts = async () => {
    const amt = Math.floor(Number(buyAmt));
    if (!(amt > 0)) return flash('Введите количество', 'err');
    setBusy(true);
    try {
      const r = await client.buyGhosts(amt);
      if (r && r.payment_url) {
        markSystemScreen();
        Linking.openURL(r.payment_url).catch(() => {});
        flash('Открываю оплату в браузере…');
      } else {
        flash('Покупка создана');
        loadBalance();
      }
    } catch (e) {
      flash('Ошибка покупки: ' + (e.message || e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const loadMyNodes = useCallback(() => {
    client &&
      client
        .bankMyNodes()
        .then(r => setMyNodes(r.nodes || []))
        .catch(() => setMyNodes([]));
  }, [client]);
  useEffect(() => {
    loadMyNodes();
  }, [loadMyNodes]);

  const bindNode = async () => {
    const code = (bindCode || '').trim();
    if (!code) return flash('Вставьте код с /status узла', 'err');
    setBusy(true);
    try {
      await client.bindNode(code);
      setBindCode('');
      flash('Узел привязан! Награды будут начисляться на ваш баланс.');
      loadMyNodes();
    } catch (e) {
      flash('Ошибка привязки: ' + (e.message || e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const toggleSound = async v => {
    setSound(v);
    await setSoundEnabled(v);
    flash(v ? 'Звук уведомлений включён' : 'Звук уведомлений выключен');
  };

  const revoke = dev => {
    Alert.alert(
      'Отозвать устройство?',
      `${dev.deviceId}${dev.current ? ' (это устройство!)' : ''} потеряет доступ к новым сообщениям.`,
      [
        {text: 'Отмена', style: 'cancel'},
        {
          text: 'Отозвать',
          style: 'destructive',
          onPress: async () => {
            try {
              await client.revokeDevice(dev.deviceId);
              setDevices(await client.myDevices());
              flash('Устройство отозвано');
            } catch (e) {
              flash('Ошибка: ' + (e.message || e), 'err');
            }
          },
        },
      ],
    );
  };

  const showSeed = async () => {
    setBusy(true);
    try {
      const phrase = await client.enableSeedRecovery();
      Alert.alert(
        'Фраза восстановления',
        phrase +
          '\n\nЗапишите её и храните в безопасном месте: по этой фразе можно войти в аккаунт и сбросить пароль.',
        [{text: 'Записал'}],
      );
    } catch (e) {
      flash('Ошибка: ' + (e.message || e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const [backupPass, setBackupPass] = useState('');
  const exportBackup = async () => {
    if (!backupPass) return flash('Введите пароль для файла копии', 'err');
    setBusy(true);
    try {
      const blob = client.exportBackupBlob(backupPass);
      markSystemScreen();
      await Share.share({
        title: `prizrak-account-${client.userId}.prizrakkey`,
        message: JSON.stringify(blob),
      });
    } catch (e) {
      flash('Ошибка: ' + (e.message || e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const checkUpd = async () => {
    setBusy(true);
    const u = await onCheckUpdate();
    setBusy(false);
    if (!u) return flash('Не удалось проверить обновления', 'err');
    if (u.status === 'update') {
      Alert.alert(
        'Доступно обновление',
        `Установлено: ${u.currentVersion}\nДоступно: ${u.version}\n${u.notes || ''}`,
        [
          {text: 'Позже', style: 'cancel'},
          {text: 'Скачать', onPress: () => { markSystemScreen(); Linking.openURL(u.url).catch(() => {}); }},
        ],
      );
    } else if (u.status === 'latest') {
      Alert.alert(
        'Обновлений нет',
        `У вас последняя версия (${u.currentVersion}).\nНа сервере: ${u.manifestVersion}.`,
      );
    } else if (u.status === 'unsigned') {
      Alert.alert(
        'Манифест не проверен',
        `Подпись манифеста неверна (версия ${u.manifestVersion || '?'}). Манифест повреждён или подписан другим ключом — перегенерируйте publish-update.mjs тем же update-maintainer.key.`,
      );
    } else if (u.status === 'nofile') {
      Alert.alert(
        'Нет файла для Android',
        `В манифесте (версия ${u.manifestVersion}) отсутствует запись files.android — соберите манифест с --android.`,
      );
    } else {
      // unreachable
      Alert.alert(
        'Манифест недоступен',
        `Не удалось получить манифест обновлений.\n\nДетали: ${u.reason || 'нет'}\n\nПроверьте, что файл лежит по одному из адресов:\n• /download/manifest-android.json\n• /api/update/manifest-android.json\nи доступен без авторизации (не 403/404).`,
      );
    }
  };

  // Подэкраны «Конфиденциальность» — как в Telegram, поверх настроек.
  if (privScreen && priv) {
    return (
      <PrivacyScreen
        kind={privScreen}
        priv={priv}
        onSave={savePriv}
        onBack={() => setPrivScreen(null)}
        nameOf={u => (u || '').split(':')[0]}
        flash={flash}
      />
    );
  }

  // Экран Призрак-VPN поверх настроек.
  if (vpnScreen) {
    return <VpnScreen client={client} onBack={() => setVpnScreen(false)} flash={flash} />;
  }

  // Выбор получателя подарка поверх настроек.
  if (giftPick) {
    return (
      <GiftRecipientScreen
        chats={chats}
        nameOf={nameOf}
        avatarsMap={avatarsMap}
        onBack={() => setGiftPick(false)}
        onPick={c => { setGiftPeer(c); setGiftPick(false); }}
      />
    );
  }

  return (
    <View style={{flex: 1}}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>‹</Text>
        </TouchableOpacity>
        <View style={{flex: 1}}>
          <Text style={styles.headerTitle}>Настройки</Text>
          <Text style={styles.headerSub}>Prizrak {APP_VERSION}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{padding: 14, paddingBottom: 30}}>
        <Text style={styles.setSection}>Мой профиль</Text>
        <View style={styles.setCard}>
          <View style={{alignItems: 'center', marginBottom: 10}}>
            <TouchableOpacity onPress={pickAvatar}>
              <Avatar
                uri={avatarUri}
                label={displayName || client?.userId?.split(':')[0]}
                size={92}
              />
              <View style={styles.avatarEditBadge}>
                <Text style={{color: '#fff', fontSize: 14}}>✎</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={pickAvatar}>
              <Text style={[styles.setBtnText, {marginTop: 8}]}>Сменить аватар</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.setLabel}>Отображаемое имя (видят собеседники)</Text>
          <TextInput
            style={styles.input}
            placeholder={client?.userId?.split(':')[0]}
            placeholderTextColor={C.sub}
            value={displayName}
            onChangeText={setDisplayName}
          />
          <Text style={styles.setLabel}>День рождения</Text>
          <TextInput
            style={styles.input}
            placeholder="ДД.ММ.ГГГГ"
            placeholderTextColor={C.sub}
            value={birthday}
            onChangeText={setBirthday}
          />
          <Text style={styles.setLabel}>О себе</Text>
          <TextInput
            style={[styles.input, {minHeight: 60, textAlignVertical: 'top'}]}
            placeholder="пара слов о себе"
            placeholderTextColor={C.sub}
            value={bio}
            onChangeText={setBio}
            multiline
          />
          <TouchableOpacity style={styles.setBtn} disabled={busy} onPress={saveProfile}>
            <Text style={styles.setBtnText}>Сохранить профиль</Text>
          </TouchableOpacity>
          <Text style={styles.setLabel}>ID</Text>
          <Text style={styles.setValue}>{client?.userId}</Text>
          <Text style={styles.setLabel}>Отпечаток ключа</Text>
          <Text style={styles.setMono}>{client?.fingerprint}</Text>
        </View>

        <Text style={styles.setSection}>Кошелёк призраков 👻</Text>
        <View style={styles.setCard}>
          <View style={styles.setRow}>
            <Text style={[styles.setValue, {flex: 1}]}>Баланс</Text>
            <Text style={styles.balanceText}>
              👻 {balance == null ? '…' : balance}
            </Text>
            <TouchableOpacity onPress={loadBalance} style={{marginLeft: 10}}>
              <Text style={{color: C.accent, fontSize: 18}}>⟳</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.setLabel}>Купить призраков (оплата через PayMoney)</Text>
          <View style={[styles.setRow, {gap: 8}]}>
            {['100', '500', '1000'].map(a => (
              <TouchableOpacity
                key={a}
                style={[styles.ghostBtn, buyAmt === a && {backgroundColor: C.accent}]}
                onPress={() => setBuyAmt(a)}>
                <Text style={styles.ghostBtnText}>👻 {a}</Text>
              </TouchableOpacity>
            ))}
            <TextInput
              style={[styles.input, {flex: 1, marginBottom: 0}]}
              keyboardType="numeric"
              value={buyAmt}
              onChangeText={setBuyAmt}
              placeholderTextColor={C.sub}
            />
          </View>
          <TouchableOpacity style={styles.setBtn} disabled={busy} onPress={buyGhosts}>
            <Text style={styles.setBtnText}>Купить {buyAmt} 👻</Text>
          </TouchableOpacity>
          <Text style={styles.setHint}>
            Призраков можно дарить на сообщения: долгое нажатие на сообщение →
            «Подарить призраков».
          </Text>
        </View>

        <Text style={styles.setSection}>🎁 Подарки</Text>
        <View style={styles.setCard}>
          <TouchableOpacity style={styles.setRow} onPress={() => setGiftPick(true)}>
            <Text style={[styles.privIco, {backgroundColor: '#e0555a'}]}>🎁</Text>
            <View style={{flex: 1}}>
              <Text style={styles.setValue}>Отправить подарок</Text>
              <Text style={styles.setHintSm}>Выбрать получателя и подарок</Text>
            </View>
            <Text style={styles.privChev}>›</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.setSection}>Мои подарки</Text>
        <View style={styles.setCard}>
          {myGifts === null ? (
            <TouchableOpacity style={styles.setBtn} onPress={loadMyGifts}>
              <Text style={styles.setBtnText}>Показать подарки</Text>
            </TouchableOpacity>
          ) : myGifts.length === 0 ? (
            <Text style={styles.setHint}>Подарков пока нет</Text>
          ) : (
            myGifts.map(g => (
              <View key={g.id} style={[styles.setRow, {borderBottomWidth: 1, borderBottomColor: C.line}]}>
                <Text style={{fontSize: 24, marginRight: 8}}>{g.emoji}</Text>
                <View style={{flex: 1}}>
                  <Text style={styles.setValue}>{g.name} · {g.price} 👻</Text>
                  <Text style={styles.setHintSm}>{g.anon ? 'от анонима' : 'от ' + (g.from || '?')}{g.msg ? ' · «' + g.msg + '»' : ''}</Text>
                </View>
                <TouchableOpacity
                  style={styles.addBtn}
                  onPress={async () => {
                    try {
                      const r = await client.convertGift(g.id);
                      flash('Распылён: +' + r.ghosts + ' 👻', 'ok');
                      loadMyGifts();
                    } catch (e) {
                      flash('Ошибка: ' + e.message, 'err');
                    }
                  }}>
                  <Text style={styles.primaryBtnText}>💨 {Math.floor((g.price * giftPct) / 100)}</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        <Text style={styles.setSection}>Мои узлы-тайники 👻</Text>
        <View style={styles.setCard}>
          <Text style={styles.setHint}>
            Держите узел-тайник — получайте призраков за аптайм и доставки. Откройте
            статус узла (http://127.0.0.1:8820/status), введите там свой ник, получите
            код привязки и вставьте его сюда.
          </Text>
          <View style={[styles.setRow, {gap: 8, marginTop: 8}]}>
            <TextInput
              style={[styles.input, {flex: 1, marginBottom: 0}]}
              value={bindCode}
              onChangeText={setBindCode}
              placeholder="код привязки с /status узла"
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity style={styles.ghostBtn} disabled={busy} onPress={bindNode}>
              <Text style={styles.ghostBtnText}>Привязать</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.setRow, {marginTop: 12}]}>
            <Text style={[styles.setValue, {flex: 1}]}>Мои узлы</Text>
            <TouchableOpacity onPress={loadMyNodes}>
              <Text style={{color: C.accent, fontSize: 18}}>⟳</Text>
            </TouchableOpacity>
          </View>
          {myNodes == null ? (
            <Text style={styles.setLabel}>Загрузка…</Text>
          ) : myNodes.length === 0 ? (
            <Text style={styles.setLabel}>Пока нет привязанных узлов.</Text>
          ) : (
            myNodes.map(n => (
              <View key={n.relayId} style={styles.nodeRow}>
                <View style={{flex: 1}}>
                  <Text style={styles.setMono}>
                    {n.short}… {n.online ? '🟢' : '⚪'}
                  </Text>
                  <Text style={styles.setLabel}>
                    аптайм {n.uptimeHours} ч · доставок {n.deliveries}
                  </Text>
                </View>
                <View style={{alignItems: 'flex-end'}}>
                  <Text style={styles.balanceText}>👻 {n.accrued}</Text>
                  <Text style={styles.setLabel}>
                    выплачено {n.claimed}
                    {n.payable > 0 ? ` · к выплате ${n.payable}` : ''}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>

        <Text style={styles.setSection}>Уведомления</Text>
        <View style={[styles.setCard, styles.setRow]}>
          <Text style={[styles.setValue, {flex: 1}]}>Звук входящих (ICQ «О-оу!»)</Text>
          <Switch value={sound} onValueChange={toggleSound} trackColor={{true: C.accent}} />
        </View>

        <Text style={styles.setSection}>Сообщения</Text>
        <View style={[styles.setCard, styles.setRow]}>
          <View style={{flex: 1}}>
            <Text style={styles.setValue}>Превью ссылок</Text>
            <Text style={styles.setHintSm}>Карточку собирает ваш телефон и шлёт внутри шифра — получатель на сайт не ходит</Text>
          </View>
          <Switch
            value={linkPrev}
            onValueChange={async v => { setLinkPrev(v); try { await setStr('pz:linkPreviews', v ? '1' : '0'); } catch {} onPreviews && onPreviews(v); }}
            trackColor={{true: C.accent}}
          />
        </View>

        <Text style={styles.setSection}>Конфиденциальность</Text>
        <View style={styles.setCard}>
          <TouchableOpacity style={styles.setRow} onPress={() => setPrivScreen('blocked')}>
            <Text style={[styles.privIco, {backgroundColor: '#e0555a'}]}>🚫</Text>
            <Text style={[styles.setValue, {flex: 1}]}>Чёрный список</Text>
            <Text style={styles.privVal}>{priv ? (priv.blocked || []).length || '' : '…'}</Text>
            <Text style={styles.privChev}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.setRow, {borderTopWidth: 1, borderTopColor: C.line}]} onPress={() => setPrivScreen('groups')}>
            <Text style={[styles.privIco, {backgroundColor: '#3390ec'}]}>👥</Text>
            <Text style={[styles.setValue, {flex: 1}]}>Группы и каналы</Text>
            <Text style={styles.privVal}>{priv ? modeLabel(priv.groups, (priv.groupsAllow || []).length) : '…'}</Text>
            <Text style={styles.privChev}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.setRow, {borderTopWidth: 1, borderTopColor: C.line}]} onPress={() => setPrivScreen('calls')}>
            <Text style={[styles.privIco, {backgroundColor: '#42b96b'}]}>📞</Text>
            <Text style={[styles.setValue, {flex: 1}]}>Звонки</Text>
            <Text style={styles.privVal}>{priv ? modeLabel(priv.calls, (priv.callsAllow || []).length) : '…'}</Text>
            <Text style={styles.privChev}>›</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.setSection}>Призрак-VPN</Text>
        <View style={styles.setCard}>
          <TouchableOpacity style={styles.setRow} onPress={() => setVpnScreen(true)}>
            <Text style={[styles.privIco, {backgroundColor: '#6b57e0'}]}>🛡</Text>
            <View style={{flex: 1}}>
              <Text style={styles.setValue}>Маскировка и узлы</Text>
              <Text style={styles.setHintSm}>Весь трафик через Призрак, выбор страны, свой узел</Text>
            </View>
            <Text style={styles.privChev}>›</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.setSection}>Защита</Text>
        <View style={styles.setCard}>
          <View style={styles.setRow}>
            <View style={{flex: 1}}>
              <Text style={styles.setValue}>PIN-код</Text>
              <Text style={styles.setHintSm}>Запрос при открытии приложения</Text>
            </View>
            <Switch
              value={lock.pinSet}
              onValueChange={async v => {
                if (v) {
                  setPinModal(true);
                } else {
                  await clearLock();
                  setLock({pinSet: false, biometric: false});
                }
              }}
              trackColor={{true: C.accent}}
            />
          </View>
          {lock.pinSet && (
            <TouchableOpacity style={[styles.setRow, {borderTopWidth: 1, borderTopColor: C.line}]} onPress={() => setPinModal(true)}>
              <Text style={[styles.setValue, {flex: 1, color: C.accent}]}>Изменить PIN-код</Text>
              <Text style={{color: C.sub, fontSize: 18}}>›</Text>
            </TouchableOpacity>
          )}
          {lock.pinSet && (
            <View style={[{borderTopWidth: 1, borderTopColor: C.line, padding: 12}]}>
              <Text style={styles.setValue}>Запрашивать PIN</Text>
              <Text style={styles.setHintSm}>
                Короткие отлучки (галерея, камера) замок не включают — только если вас не было дольше выбранного времени
              </Text>
              <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10}}>
                {AUTOLOCK_CHOICES.map(sec => (
                  <TouchableOpacity
                    key={sec}
                    style={[styles.giChip, autolock === sec && styles.giChipOn]}
                    onPress={async () => { setAutolock(sec); try { await setAutolockSec(sec); } catch {} }}>
                    <Text style={[styles.giChipText, autolock === sec && styles.giChipTextOn]}>
                      {sec === 0 ? 'Сразу' : sec < 60 ? `${sec} сек` : sec === 60 ? '1 мин' : `${sec / 60} мин`}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
          <View style={[styles.setRow, {borderTopWidth: 1, borderTopColor: C.line}]}>
            <View style={{flex: 1}}>
              <Text style={[styles.setValue, (!lock.pinSet || !bioAvail) && {color: C.sub}]}>Биометрия (отпечаток / лицо)</Text>
              <Text style={styles.setHintSm}>
                {!bioAvail ? 'Недоступна на этом устройстве' : !lock.pinSet ? 'Сначала включите PIN-код' : 'Разблокировка без ввода PIN'}
              </Text>
            </View>
            <Switch
              value={lock.biometric}
              disabled={!lock.pinSet || !bioAvail}
              onValueChange={async v => {
                await setBiometric(v);
                setLock(l => ({...l, biometric: v}));
              }}
              trackColor={{true: C.accent}}
            />
          </View>
        </View>

        <Modal transparent animationType="fade" visible={pinModal} onRequestClose={() => setPinModal(false)}>
          <SetPinScreen
            canSkip
            flash={flash}
            onDone={async () => {
              setPinModal(false);
              const ls = await lockStatus();
              setLock(ls);
              flash('PIN-код сохранён', 'ok');
            }}
            onSkip={() => setPinModal(false)}
          />
        </Modal>

        <GiftShopModal
          visible={!!giftPeer}
          peerName={giftPeer ? nameOf(giftPeer.id) : ''}
          onCatalog={() => client.giftCatalog()}
          onSend={async (gift, msg, anon) => { await onSendGiftTo(giftPeer.id, gift, msg, anon); }}
          onClose={() => setGiftPeer(null)}
          flash={flash}
        />

        <Text style={styles.setSection}>Устройства</Text>
        <View style={styles.setCard}>
          {devices == null ? (
            <ActivityIndicator color={C.accent} />
          ) : devices.length === 0 ? (
            <Text style={styles.setValue}>Реестр устройств пуст</Text>
          ) : (
            devices.map(d => (
              <View key={d.deviceId} style={styles.setRow}>
                <View style={{flex: 1}}>
                  <Text style={styles.setValue}>
                    {d.deviceId}
                    {d.current ? '  ← это устройство' : ''}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => revoke(d)}>
                  <Text style={{color: C.danger, fontSize: 13}}>Отозвать</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        <Text style={styles.setSection}>Безопасность и восстановление</Text>
        <View style={styles.setCard}>
          <TouchableOpacity style={styles.setBtn} disabled={busy} onPress={showSeed}>
            <Text style={styles.setBtnText}>Показать фразу восстановления</Text>
          </TouchableOpacity>
          <TextInput
            style={[styles.input, {marginTop: 8}]}
            placeholder="пароль для файла копии"
            placeholderTextColor={C.sub}
            secureTextEntry
            value={backupPass}
            onChangeText={setBackupPass}
          />
          <TouchableOpacity style={styles.setBtn} disabled={busy} onPress={exportBackup}>
            <Text style={styles.setBtnText}>Сделать копию аккаунта (поделиться файлом)</Text>
          </TouchableOpacity>
          <Text style={styles.setHint}>
            Копия — это текстовый файл с запечатанными ключами. Пароль файла
            понадобится при восстановлении («Восстановить из копии» на экране входа).
          </Text>
        </View>

        <Text style={styles.setSection}>Обновления</Text>
        <View style={styles.setCard}>
          {update && (
            <Text style={[styles.setValue, {color: '#4cd964', marginBottom: 8}]}>
              Доступна версия {update.version}
            </Text>
          )}
          <TouchableOpacity style={styles.setBtn} disabled={busy} onPress={checkUpd}>
            <Text style={styles.setBtnText}>Проверить обновления</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.setBtn, {backgroundColor: C.danger, marginTop: 18}]}
          onPress={onLogout}>
          <Text style={[styles.setBtnText, {color: '#fff'}]}>Выйти из аккаунта</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ── Окно чата ───────────────────────────────────────────────────────────────
// 👻 — это НЕ бесплатная реакция, а донат призраков (см. секцию «Подарить призраков» ниже).
const REACT_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

// Формат времени записи/проигрывания: m:ss (для длинных — с десятыми не нужно).
function fmtRec(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Статус «в сети / был(а) в сети …» (как в десктопе) ───────────────────────
function pluralRu(n, one, few, many) {
  const a = n % 10,
    b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
  return many;
}
function fmtAgo(sec) {
  const units = [
    [365 * 86400, 'год', 'года', 'лет'],
    [30 * 86400, 'месяц', 'месяца', 'месяцев'],
    [7 * 86400, 'неделю', 'недели', 'недель'],
    [86400, 'день', 'дня', 'дней'],
    [3600, 'час', 'часа', 'часов'],
    [60, 'минуту', 'минуты', 'минут'],
  ];
  const parts = [];
  let rem = sec;
  for (const [s, one, few, many] of units) {
    const n = Math.floor(rem / s);
    if (n > 0) {
      parts.push(`${n} ${pluralRu(n, one, few, many)}`);
      rem -= n * s;
    }
    if (parts.length >= 2) break;
  }
  if (!parts.length) return 'меньше минуты';
  if (parts.length === 1) return parts[0];
  return parts[0] + ' и ' + parts[1];
}
// Возвращает {text, online}. Пустой text — статус неизвестен (показываем ID).
function formatPresence(p) {
  if (!p || p.unknown) return {text: '', online: false};
  if (p.online) return {text: 'в сети', online: true};
  const ts = p.lastSeen || 0;
  if (!ts) return {text: 'был(а) недавно', online: false};
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 15 * 60) return {text: 'был(а) недавно', online: false};
  return {text: `был(а) в сети ${fmtAgo(diff)} назад`, online: false};
}

// Галочки доставки/прочтения (как в десктопе):
// sent(1)=✓ серая (на своём сервере) · server(2)=✓✓ серые (на сервере получателя)
// received(3)=левая синеет (доставлено в приложение) · read(4)=обе синие (прочитано)
const RECEIPT_RANK = {sent: 1, server: 2, received: 3, read: 4};
function sendStatus(r) {
  return r && r.queued ? 'queued' : r && r.delivered ? 'server' : 'sent';
}
function Ticks({status}) {
  if (!status) return null;
  if (status === 'queued') return <Text style={styles.tick}>🕐</Text>;
  const r = RECEIPT_RANK[status] || 0;
  if (r === 0) return null;
  if (r === 1)
    return <Text style={[styles.tick, {color: C.tickGrey}]}>✓</Text>;
  const left = r >= 3 ? C.tickBlue : C.tickGrey;
  const right = r >= 4 ? C.tickBlue : C.tickGrey;
  return (
    <View style={styles.ticksTwo}>
      <Text style={[styles.tick, {color: left}]}>✓</Text>
      <Text style={[styles.tick, {color: right, marginLeft: -5}]}>✓</Text>
    </View>
  );
}

// Псевдо-волна, если у сообщения нет сохранённой (легаси/сбой): стабильна по id.
function waveFor(item) {
  const att = item.att || {};
  if (Array.isArray(att.wave) && att.wave.length) return att.wave;
  const seed = String(item.id || att.mediaId || 'x');
  const out = [];
  for (let i = 0; i < 48; i++)
    out.push(4 + ((seed.charCodeAt(i % seed.length) * (i + 7)) % 26));
  return out;
}

// Голосовое сообщение: волна (48 баров) + play/pause + таймер + прогресс.
function VoiceBubble({item, voiceState, onToggleVoice, out}) {
  const att = item.att || {};
  const wave = waveFor(item);
  const active = voiceState && voiceState.id === item.id;
  const playing = active && voiceState.playing;
  const dur = att.dur || (active ? voiceState.dur : 0) || 0;
  const pos = active ? voiceState.pos || 0 : 0;
  const prog = dur > 0 ? Math.min(1, pos / dur) : 0;
  const shownDur = active && pos > 0 ? pos : dur;
  const filled = Math.round(prog * wave.length);
  const barOn = out ? 'rgba(255,255,255,0.95)' : C.accent;
  const barOff = out ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.22)';
  return (
    <View style={styles.voiceRow}>
      <TouchableOpacity
        style={[styles.voicePlay, {backgroundColor: out ? 'rgba(255,255,255,0.2)' : C.accent}]}
        onPress={() => onToggleVoice(item)}>
        <Text style={styles.voicePlayIcon}>{playing ? '⏸' : '▶'}</Text>
      </TouchableOpacity>
      <View style={styles.voiceBody}>
        <View style={styles.voiceWave}>
          {wave.map((h, i) => (
            <View
              key={i}
              style={{
                flex: 1,
                marginHorizontal: 0.5,
                borderRadius: 1,
                height: Math.max(3, Math.round((h / 31) * 22)),
                backgroundColor: i < filled ? barOn : barOff,
              }}
            />
          ))}
        </View>
        <Text style={styles.voiceDur}>🎤 {fmtRec(shownDur)}</Text>
      </View>
    </View>
  );
}

// Аудио-файл (.mp3 и пр.) — инлайн-плеер, играет через тот же нативный проигрыватель.
function isAudioAtt(att) {
  if (!att || att.voice || att.videoNote) return false;
  const m = (att.mime || '').toLowerCase();
  if (m.startsWith('audio/')) return true;
  return /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|mid)$/i.test(att.filename || '');
}
function AudioBubble({item, voiceState, onToggleVoice, out}) {
  const att = item.att || {};
  const active = voiceState && voiceState.id === item.id;
  const playing = active && voiceState.playing;
  const dur = (active ? voiceState.dur : 0) || 0;
  const pos = active ? voiceState.pos || 0 : 0;
  const prog = dur > 0 ? Math.min(1, pos / dur) : 0;
  return (
    <View style={styles.audRow}>
      <TouchableOpacity
        style={[styles.audBtn, {backgroundColor: out ? 'rgba(255,255,255,0.22)' : C.accent}]}
        onPress={() => onToggleVoice(item)}>
        <Text style={styles.audBtnIcon}>{playing ? '⏸' : '▶'}</Text>
      </TouchableOpacity>
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={styles.audName} numberOfLines={1}>🎵 {att.filename || 'Аудио'}</Text>
        <View style={styles.audBar}>
          <View style={[styles.audFill, {width: prog * 100 + '%', backgroundColor: out ? '#fff' : C.accent}]} />
        </View>
        <Text style={styles.audTime}>{active && pos > 0 ? fmtRec(pos) : att.size ? Math.round(att.size / 1024) + ' КБ' : ''}</Text>
      </View>
    </View>
  );
}

function NoteBubble({item, onToggleNote}) {
  const att = item.att || {};
  return (
    <TouchableOpacity
      style={styles.noteBubbleWrap}
      activeOpacity={0.85}
      onPress={() => onToggleNote(item)}>
      <View style={styles.noteBubbleCircle}>
        <Text style={styles.noteBubblePlay}>▶</Text>
      </View>
      <Text style={styles.noteBubbleDur}>📹 {fmtRec(att.dur || 0)}</Text>
    </TouchableOpacity>
  );
}

// 🔗 Карточка превью ссылки (как в Telegram): полоска слева, сайт, заголовок,
// описание и мини-картинка. Всё пришло внутри сообщения — в сеть не ходим.
function LinkPreviewCard({p}) {
  if (!p) return null;
  const open = () => { try { markSystemScreen(); Linking.openURL(p.url); } catch {} };
  const img = p.image && p.image.data ? `data:${p.image.mime || 'image/jpeg'};base64,${p.image.data}` : null;
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={open} style={styles.lpCard}>
      <View style={{flex: 1, minWidth: 0}}>
        {!!p.site && <Text style={styles.lpSite} numberOfLines={1}>{p.site}</Text>}
        {!!p.title && <Text style={styles.lpTitle} numberOfLines={2}>{p.title}</Text>}
        {!!p.desc && <Text style={styles.lpDesc} numberOfLines={3}>{p.desc}</Text>}
      </View>
      {img ? <Image source={{uri: img}} style={styles.lpImg} resizeMode="cover" /> : null}
    </TouchableOpacity>
  );
}

function Bubble({item, chat, onLongPress, nameOf, voiceState, onToggleVoice, onToggleNote, onGiftOpen, hl}) {
  const mine = item.mine || [];
  const theirs = item.theirs || [];
  const reactions = [...new Set([...mine, ...theirs])];
  const paid = item.paid || 0;
  const isVoice = item.kind === 'att' && item.att && item.att.voice;
  const isNote = item.kind === 'att' && item.att && item.att.videoNote;
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onLongPress={() => onLongPress(item)}
      style={[styles.bubble, item.dir === 'out' ? styles.bubbleOut : styles.bubbleIn, hl && styles.bubbleHl]}>
      {chat.kind !== 'dm' && item.dir === 'in' && item.from ? (
        <Text style={styles.bubbleFrom}>{nameOf ? nameOf(item.from) : item.from}</Text>
      ) : null}
      {item.kind === 'gift' ? (
        <TouchableOpacity activeOpacity={0.8} onPress={() => onGiftOpen && onGiftOpen(item)} style={styles.giftBubble}>
          <Text style={styles.giftBubbleEm}>{(item.gift && item.gift.emoji) || '🎁'}</Text>
          <Text style={styles.giftBubbleT}>
            {item.dir === 'out'
              ? `Вы подарили: ${(item.gift && item.gift.name) || ''}`
              : item.gift && item.gift.anon
                ? `Анонимный подарок: ${item.gift.name || ''}`
                : `Подарок: ${(item.gift && item.gift.name) || ''}`}
          </Text>
          {!!(item.gift && item.gift.msg) && <Text style={styles.giftBubbleM}>«{item.gift.msg}»</Text>}
          <Text style={styles.giftBubbleM}>🎁 {(item.gift && item.gift.price) || 0} 👻</Text>
          <Text style={styles.giftBubbleHint}>Нажмите, чтобы открыть</Text>
        </TouchableOpacity>
      ) : item.kind === 'att' ? (
        isVoice ? (
          <VoiceBubble
            item={item}
            voiceState={voiceState}
            onToggleVoice={onToggleVoice}
            out={item.dir === 'out'}
          />
        ) : isNote ? (
          <NoteBubble item={item} onToggleNote={onToggleNote} />
        ) : isAudioAtt(item.att) ? (
          <AudioBubble item={item} voiceState={voiceState} onToggleVoice={onToggleVoice} out={item.dir === 'out'} />
        ) : item.uri ? (
          <Image source={{uri: item.uri}} style={styles.bubbleImage} resizeMode="cover" />
        ) : (
          <Text style={styles.bubbleText}>
            📎 {item.att ? item.att.filename || 'Файл' : 'Файл'}
            {item.att && item.att.size ? `  (${Math.round(item.att.size / 1024)} КБ)` : ''}
          </Text>
        )
      ) : (
        <>
          <Text style={styles.bubbleText}>{renderTextWithLinks(item.text)}</Text>
          {!!item.preview && <LinkPreviewCard p={item.preview} />}
        </>
      )}
      {(reactions.length > 0 || paid > 0) && (
        <View style={styles.reactRow}>
          {reactions.map(e => (
            <Text key={e} style={styles.reactChip}>
              {e}
            </Text>
          ))}
          {paid > 0 && <Text style={styles.reactChip}>👻{paid}</Text>}
        </View>
      )}
      {item.dir === 'out' && chat.kind === 'dm' && (
        <View style={styles.metaRow}>
          <Ticks status={item.status} />
        </View>
      )}
    </TouchableOpacity>
  );
}

// Панель действий с сообщением (тёмная, в стиле приложения) — вместо системного Alert.
function MessageSheet({msg, chat, onReact, onDonate, onDelete, onForward, onSaveFile, onClose}) {
  const [customAmt, setCustomAmt] = useState('');
  if (!msg) return null;
  const isFile = msg.kind === 'att' && msg.att && !msg.att.voice && !msg.att.videoNote;
  const customN = parseInt(customAmt, 10);
  const customOk = Number.isFinite(customN) && customN >= 1;
  return (
    <Modal transparent animationType="fade" visible={!!msg} onRequestClose={onClose}>
      <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet}>
          {chat.kind === 'dm' && (
            <>
              <Text style={styles.sheetLabel}>Реакция</Text>
              <View style={styles.sheetReactRow}>
                {REACT_EMOJIS.map(e => (
                  <TouchableOpacity
                    key={e}
                    style={styles.sheetReactBtn}
                    onPress={() => {
                      onReact(msg.id, e);
                      onClose();
                    }}>
                    <Text style={styles.sheetReactEmoji}>{e}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.sheetLabel}>Подарить призраков 👻</Text>
              <View style={styles.sheetReactRow}>
                {[10, 50, 100, 500].map(a => (
                  <TouchableOpacity
                    key={a}
                    style={styles.ghostBtn}
                    onPress={() => {
                      onDonate(msg.id, a);
                      onClose();
                    }}>
                    <Text style={styles.ghostBtnText}>👻 {a}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {/* Своя сумма — от 1 призрака и без верхнего предела. */}
              <View style={styles.ghostCustomRow}>
                <TextInput
                  style={styles.ghostCustomInput}
                  placeholder="Своё число"
                  placeholderTextColor={C.sub}
                  keyboardType="number-pad"
                  value={customAmt}
                  onChangeText={t => setCustomAmt(t.replace(/[^0-9]/g, ''))}
                  maxLength={12}
                />
                <TouchableOpacity
                  style={[styles.ghostBtn, {opacity: customOk ? 1 : 0.4}]}
                  disabled={!customOk}
                  onPress={() => {
                    onDonate(msg.id, customN);
                    onClose();
                  }}>
                  <Text style={styles.ghostBtnText}>👻 Подарить</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
          {isFile && (
            <TouchableOpacity
              style={styles.sheetAction}
              onPress={() => {
                onForward(msg);
                onClose();
              }}>
              <Text style={styles.sheetActionText}>➡️ Переслать</Text>
            </TouchableOpacity>
          )}
          {isFile && (
            <TouchableOpacity
              style={styles.sheetAction}
              onPress={() => {
                onSaveFile(msg);
                onClose();
              }}>
              <Text style={styles.sheetActionText}>💾 Сохранить в Загрузки</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.sheetAction}
            onPress={() => {
              onDelete(msg.id);
              onClose();
            }}>
            <Text style={[styles.sheetActionText, {color: C.danger}]}>Удалить сообщение</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.sheetAction} onPress={onClose}>
            <Text style={styles.sheetActionText}>Отмена</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const EMOJI_SET = [
  '😀','😁','😂','🤣','😊','😍','😘','😎','🤩','🥳','😉','😜','🤪','😏','🙃','😇',
  '🤔','🤨','😐','😶','🙄','😴','🥱','😪','😌','😔','😢','😭','😤','😠','😡','🤬',
  '😱','😨','😰','😥','😓','🤗','🤭','🤫','🤥','😬','🙁','😖','😞','😟','😕','🫤',
  '👍','👎','👌','✌️','🤞','🤟','🤘','👏','🙌','🙏','💪','👀','🔥','✨','⭐','🌟',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❣️','💕','💞','💯','✅','❌','❓',
  '🎉','🎊','🎁','🎂','🍕','🍺','☕','🚀','⚡','💰','👻','😈','💀','🤡','👑','🐾',
];

const MUTE_OPTIONS = [
  {label: '1 час', ms: 3600e3},
  {label: '3 часа', ms: 3 * 3600e3},
  {label: '12 часов', ms: 12 * 3600e3},
  {label: '1 день', ms: 24 * 3600e3},
  {label: '3 дня', ms: 3 * 24 * 3600e3},
  {label: '7 дней', ms: 7 * 24 * 3600e3},
  {label: '1 месяц', ms: 30 * 24 * 3600e3},
  {label: 'Навсегда', ms: Infinity},
];

// ── Информация и настройки группы/канала (как «Управление группой» в Telegram) ──
const GI_SLOW_OPTS = [[0, 'Выкл'], [5, '5с'], [10, '10с'], [30, '30с'], [60, '1м'], [300, '5м'], [900, '15м'], [3600, '1ч']];
const GI_RET_OPTS = [['forever', 'Выкл'], ['1d', '1 день'], ['1w', '1 нед'], ['1mo', '1 мес']];
const GI_PERMS = [
  ['sendMessages', 'Отправка сообщений'],
  ['sendMedia', 'Отправка медиафайлов'],
  ['addMembers', 'Добавление участников'],
  ['pinMessages', 'Закрепление сообщений'],
  ['changeInfo', 'Изменение профиля группы'],
  ['changeOwnTag', 'Изменение своего тега'],
];
// Настройки группы/канала — отдельный ЭКРАН (не модалка: та не прокручивалась).
function GroupInfoScreen({chat, meId, onBack, onGetRoom, onSaveGroup, onInvite, onGetLink, onSaveRoomProfile, flash}) {
  const [room, setRoom] = useState(null);
  const [link, setLink] = useState('');
  const [inv, setInv] = useState('');
  const [priv, setPriv] = useState('private');
  const [perms, setPerms] = useState({});
  const [slow, setSlow] = useState(0);
  const [ret, setRet] = useState('forever');
  const [hist, setHist] = useState(true);
  const [busy, setBusy] = useState(false);
  // Профиль комнаты: название, описание, аватар (правит владелец/админ)
  const [gName, setGName] = useState('');
  const [gDesc, setGDesc] = useState('');
  const [gAvaUri, setGAvaUri] = useState('');
  const [gAvaObj, setGAvaObj] = useState(null); // {mime,data} — если меняли

  // Системная кнопка «назад» закрывает этот экран, а не выходит из чата.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  useEffect(() => {
    setRoom(null);
    (async () => {
      try {
        const r = await onGetRoom(chat.id);
        setRoom(r);
        setPriv(r.privacy === 'public' ? 'public' : 'private');
        setPerms({sendMessages: true, sendMedia: true, addMembers: true, pinMessages: true, changeInfo: true, changeOwnTag: false, ...(r.perms || {})});
        setSlow(r.slowModeSec || 0);
        setRet(r.retention || 'forever');
        setHist(r.historyVisible !== false);
        setGName(r.name || chat.name || '');
        setGDesc(r.description || '');
        setGAvaObj(null);
        setGAvaUri(r.avatar && r.avatar.data ? `data:${r.avatar.mime || 'image/jpeg'};base64,${r.avatar.data}` : '');
      } catch (e) {
        flash('Не удалось загрузить: ' + e.message, 'err');
      }
      try {
        const l = await onGetLink(chat.id);
        setLink(l || '');
      } catch {}
    })();
  }, [chat.id, onGetRoom, onGetLink, flash]);

  const manage = room && (room.owner === meId || (room.admins || []).includes(meId));
  const members = room
    ? new Set([room.owner, ...(room.admins || []), ...(room.members || []), ...(room.subscribers || [])].filter(Boolean)).size
    : 0;
  const isGroup = (room ? room.type : chat.kind) === 'group';

  const pickGroupAvatar = async () => {
    try {
      markSystemScreen(); // галерея — не повод просить PIN при возврате
      const {launchImageLibrary} = require('react-native-image-picker');
      const res = await launchImageLibrary({mediaType: 'photo', includeBase64: true, maxWidth: 256, maxHeight: 256, quality: 0.8});
      if (!res || res.didCancel || !res.assets || !res.assets[0]) return;
      const a = res.assets[0];
      if (!a.base64) return flash('Не удалось прочитать фото', 'err');
      if (a.base64.length > 700000) return flash('Аватар слишком большой (макс ~512КБ)', 'err');
      const obj = {mime: a.type || 'image/jpeg', data: a.base64};
      setGAvaObj(obj);
      setGAvaUri(`data:${obj.mime};base64,${obj.data}`);
    } catch { flash('Не удалось открыть галерею', 'err'); }
  };

  const save = async () => {
    setBusy(true);
    try {
      // Сначала профиль (название/описание/аватар), потом настройки — одной кнопкой.
      if (onSaveRoomProfile) {
        const fields = {};
        if ((gName || '').trim() && gName.trim() !== (room.name || '')) fields.name = gName.trim();
        if ((gDesc || '') !== (room.description || '')) fields.description = gDesc;
        if (gAvaObj) fields.avatar = gAvaObj;
        if (Object.keys(fields).length) await onSaveRoomProfile(chat.id, fields);
      }
      await onSaveGroup(chat.id, {privacy: priv, perms, slowModeSec: slow, historyVisible: hist}, ret);
      flash('Настройки сохранены', 'ok');
      onBack();
    } catch (e) {
      flash('Ошибка: ' + e.message, 'err');
    }
    setBusy(false);
  };
  const doInvite = async () => {
    const u = inv.trim();
    if (!u || !u.includes(':')) {
      flash('ID вида имя:сервер', 'err');
      return;
    }
    setBusy(true);
    try {
      await onInvite(chat.id, u);
      setInv('');
      flash('Приглашение отправлено: ' + u, 'ok');
    } catch (e) {
      flash('Не пригласить: ' + e.message, 'err');
    }
    setBusy(false);
  };

  const Chip = ({on, label, onPress}) => (
    <TouchableOpacity onPress={onPress} style={[styles.giChip, on && styles.giChipOn]}>
      <Text style={[styles.giChipText, on && styles.giChipTextOn]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={{flex: 1}}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>‹</Text>
        </TouchableOpacity>
        <View style={{flex: 1}}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {(isGroup ? '👥 ' : '📢 ') + (chat.name || chat.id)}
          </Text>
          <Text style={styles.headerSub}>{isGroup ? 'Настройки группы' : 'Настройки канала'}</Text>
        </View>
      </View>
      <View style={{flex: 1}}>
          {!room ? (
            <ActivityIndicator color={C.accent} style={{marginVertical: 24}} />
          ) : (
            <ScrollView
              style={{flex: 1}}
              contentContainerStyle={{padding: 14, paddingBottom: 30}}
              keyboardShouldPersistTaps="handled">
              <Text style={styles.giSub}>
                {(isGroup ? 'Группа' : 'Канал') + ' · участников: ' + members + (room.privacy === 'public' ? ' · публичная' : ' · частная')}
              </Text>

              {manage && (
                <>
                  <Text style={styles.giSec}>Профиль {isGroup ? 'группы' : 'канала'}</Text>
                  <View style={{alignItems: 'center', marginBottom: 10}}>
                    <TouchableOpacity onPress={pickGroupAvatar}>
                      <Avatar uri={gAvaUri} label={gName || chat.name || chat.id} kind={isGroup ? 'group' : 'channel'} size={72} />
                      <Text style={[styles.setBtnText, {marginTop: 8, textAlign: 'center'}]}>
                        {gAvaUri ? 'Сменить аватар' : 'Добавить аватар'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    style={styles.input}
                    placeholder={isGroup ? 'Название группы' : 'Название канала'}
                    placeholderTextColor={C.sub}
                    value={gName}
                    onChangeText={setGName}
                  />
                  <TextInput
                    style={[styles.input, {minHeight: 56, textAlignVertical: 'top'}]}
                    placeholder="Описание (по желанию)"
                    placeholderTextColor={C.sub}
                    value={gDesc}
                    onChangeText={setGDesc}
                    multiline
                  />
                </>
              )}

              <Text style={styles.giSec}>Пригласить участника</Text>
              <View style={{flexDirection: 'row', gap: 8, alignItems: 'center'}}>
                <TextInput
                  style={[styles.input, {flex: 1, marginBottom: 0}]}
                  placeholder="имя:сервер"
                  placeholderTextColor={C.sub}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={inv}
                  onChangeText={setInv}
                />
                <TouchableOpacity style={styles.addBtn} disabled={busy} onPress={doInvite}>
                  <Text style={styles.primaryBtnText}>➕</Text>
                </TouchableOpacity>
              </View>
              {!!link && (
                <TouchableOpacity
                  onPress={() => {
                    try {
                      markSystemScreen();
                      Share.share({message: link});
                    } catch {}
                  }}>
                  <Text style={styles.giLink} numberOfLines={2}>
                    🔗 {link}
                  </Text>
                  <Text style={styles.giHint}>нажмите, чтобы поделиться ссылкой</Text>
                </TouchableOpacity>
              )}

              {manage && (
                <>
                  <Text style={styles.giSec}>{isGroup ? 'Тип группы' : 'Тип канала'}</Text>
                  <View style={{flexDirection: 'row', gap: 8}}>
                    <Chip on={priv === 'private'} label="Частная" onPress={() => setPriv('private')} />
                    <Chip on={priv === 'public'} label="Публичная" onPress={() => setPriv('public')} />
                  </View>
                  <Text style={styles.giHint}>
                    Публичные видны в поиске по названию, частные — только по ссылке-приглашению
                  </Text>
                </>
              )}

              {manage && isGroup && (
                <>
                  <Text style={styles.giSec}>Разрешения участников</Text>
                  {GI_PERMS.map(([k, lbl]) => (
                    <View key={k} style={styles.giRow}>
                      <Text style={styles.giRowLbl}>{lbl}</Text>
                      <Switch
                        value={!!perms[k]}
                        onValueChange={v => setPerms(p => ({...p, [k]: v}))}
                        trackColor={{false: C.panel2, true: C.accentDim}}
                        thumbColor={perms[k] ? C.accent : C.sub}
                      />
                    </View>
                  ))}

                  <Text style={styles.giSec}>Медленный режим</Text>
                  <View style={styles.giChips}>
                    {GI_SLOW_OPTS.map(([v, lbl]) => (
                      <Chip key={v} on={slow === v} label={lbl} onPress={() => setSlow(v)} />
                    ))}
                  </View>

                  <Text style={styles.giSec}>Автоудаление сообщений</Text>
                  <View style={styles.giChips}>
                    {GI_RET_OPTS.map(([v, lbl]) => (
                      <Chip key={v} on={ret === v} label={lbl} onPress={() => setRet(v)} />
                    ))}
                  </View>

                  <View style={[styles.giRow, {marginTop: 10}]}>
                    <Text style={styles.giRowLbl}>История видна новым</Text>
                    <Switch
                      value={hist}
                      onValueChange={setHist}
                      trackColor={{false: C.panel2, true: C.accentDim}}
                      thumbColor={hist ? C.accent : C.sub}
                    />
                  </View>

                </>
              )}
            </ScrollView>
          )}
          {/* Закреплённый низ: «Сохранить» видно всегда — и в группах, и в каналах. */}
          {!!room && manage && (
            <View style={styles.giFooter}>
              <TouchableOpacity style={[styles.primaryBtn, {flex: 1, marginTop: 0}]} disabled={busy} onPress={save}>
                <Text style={styles.primaryBtnText}>{busy ? '…' : 'Сохранить'}</Text>
              </TouchableOpacity>
            </View>
          )}
      </View>
    </View>
  );
}

// 👻 Один призрак, который бесконечно летает по эллипсу вокруг подарка.
function FlyingGhost({index, total}) {
  const t = useRef(new Animated.Value(0)).current;
  // Разброс размеров/скоростей, чтобы стая выглядела живой.
  const rx = 78 + (index % 3) * 12;
  const ry = 48 + (index % 3) * 8;
  const size = 13 + (index % 4) * 3; // поменьше, чтобы не бросались в глаза
  // У каждого призрака своя случайная скорость: от 20% до 100% от максимальной.
  // База (7.2–10.8 c на круг) — это 100%; скорость ниже → круг длиннее.
  const speed = useRef(0.2 + Math.random() * 0.8).current;
  const dur = Math.round((7200 + (index % 5) * 900) / speed);
  const phase = (index / Math.max(1, total)) * Math.PI * 2;
  // Заранее считаем траекторию по точкам — плавная петля через interpolate.
  const STEPS = 24;
  const inR = [];
  const outX = [];
  const outY = [];
  for (let i = 0; i <= STEPS; i++) {
    const p = i / STEPS;
    const a = phase + p * Math.PI * 2;
    inR.push(p);
    outX.push(Math.cos(a) * rx);
    outY.push(Math.sin(a) * ry);
  }
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(t, {toValue: 1, duration: dur, easing: Easing.linear, useNativeDriver: true}),
    );
    loop.start();
    return () => loop.stop();
  }, []);
  const tx = t.interpolate({inputRange: inR, outputRange: outX});
  const ty = t.interpolate({inputRange: inR, outputRange: outY});
  // Прозрачность плавно «дышит» от почти невидимых 10% до 40% видимости.
  const opacity = t.interpolate({inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [0.1, 0.4, 0.15, 0.4, 0.1]});
  return (
    <Animated.Text
      style={{position: 'absolute', fontSize: size, opacity, transform: [{translateX: tx}, {translateY: ty}]}}>
      👻
    </Animated.Text>
  );
}

// 👻 Стая призраков + подарок в центре (аналог анимации звёзд в Telegram).
function GhostGiftAnim({emoji}) {
  const pop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    pop.setValue(0);
    Animated.spring(pop, {toValue: 1, friction: 5, tension: 90, useNativeDriver: true}).start();
  }, [emoji]);
  const N = 7;
  const scale = pop.interpolate({inputRange: [0, 1], outputRange: [0.4, 1]});
  return (
    <View style={styles.ghostStage}>
      {Array.from({length: N}).map((_, i) => (
        <FlyingGhost key={i} index={i} total={N} />
      ))}
      <Animated.Text style={[styles.ghostGift, {transform: [{scale}]}]}>{emoji || '🎁'}</Animated.Text>
    </View>
  );
}

// 🎁 Просмотр подарка: кто отправил, сообщение, цена, дата + анимация призраков.
function GiftInfoModal({item, onClose, nameOf}) {
  if (!item) return null;
  const g = item.gift || {};
  const out = item.dir === 'out';
  const sender = out
    ? 'Вы'
    : g.anon
      ? 'Аноним'
      : nameOf
        ? nameOf(item.from)
        : item.from || 'Неизвестно';
  let dateStr = '';
  try {
    if (item.ts) {
      const d = new Date(item.ts);
      dateStr = d.toLocaleDateString('ru-RU') + ', ' + d.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
    }
  } catch (e) {}
  return (
    <Modal transparent animationType="fade" visible={!!item} onRequestClose={onClose}>
      <TouchableOpacity style={styles.giftInfoBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.giftInfoCard}>
          <GhostGiftAnim emoji={g.emoji} />
          <Text style={styles.giftInfoName}>{g.name || 'Подарок'}</Text>
          {!out && !g.anon && (
            <View style={styles.giftInfoRow}>
              <Text style={styles.giftInfoLbl}>От кого</Text>
              <Text style={styles.giftInfoVal}>{sender}</Text>
            </View>
          )}
          {!!g.msg && (
            <View style={styles.giftInfoMsgBox}>
              <Text style={styles.giftInfoMsg}>«{g.msg}»</Text>
            </View>
          )}
          <View style={styles.giftInfoRow}>
            <Text style={styles.giftInfoLbl}>Стоимость</Text>
            <Text style={styles.giftInfoVal}>{g.price || 0} 👻</Text>
          </View>
          {!!dateStr && (
            <View style={styles.giftInfoRow}>
              <Text style={styles.giftInfoLbl}>Дата</Text>
              <Text style={styles.giftInfoVal}>{dateStr}</Text>
            </View>
          )}
          <TouchableOpacity style={styles.giftInfoClose} onPress={onClose}>
            <Text style={styles.giftInfoCloseT}>Закрыть</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// 🎁 Магазин подарков (как в Telegram, оплата 👻).
// 🎁 Выбор получателя подарка (как «Отправить подарок» в Telegram).
function GiftRecipientScreen({chats, nameOf, avatarsMap, onBack, onPick}) {
  const [q, setQ] = useState('');
  const dms = (chats || []).filter(c => c.kind === 'dm');
  const ql = q.trim().toLowerCase();
  const list = ql
    ? dms.filter(c => (nameOf(c.id) || '').toLowerCase().includes(ql) || c.id.toLowerCase().includes(ql))
    : dms;
  return (
    <View style={{flex: 1}}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.iconBtn}><Text style={styles.iconBtnText}>‹</Text></TouchableOpacity>
        <View style={{flex: 1}}>
          <Text style={styles.headerTitle}>Кому подарить</Text>
          <Text style={styles.headerSub}>Выберите получателя</Text>
        </View>
      </View>
      <TextInput
        style={[styles.input, {margin: 12, marginBottom: 0}]}
        placeholder="Поиск"
        placeholderTextColor={C.sub}
        value={q}
        onChangeText={setQ}
      />
      <ScrollView contentContainerStyle={{padding: 12}}>
        {list.length === 0 && (
          <Text style={{color: C.sub, padding: 12}}>
            {dms.length === 0 ? 'Нет собеседников. Напишите кому-нибудь, чтобы подарить.' : 'Никого не найдено.'}
          </Text>
        )}
        {list.map(c => (
          <TouchableOpacity key={c.id} style={styles.setRow} onPress={() => onPick(c)}>
            <Avatar uri={avatarsMap && avatarsMap[c.id]} label={nameOf(c.id)} size={40} />
            <View style={{flex: 1, marginLeft: 10}}>
              <Text style={styles.setValue}>{nameOf(c.id)}</Text>
              <Text style={styles.setHintSm}>{c.id.split(':')[0]}</Text>
            </View>
            <Text style={styles.privChev}>›</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

function GiftShopModal({visible, onClose, peerName, onCatalog, onSend, flash}) {
  const [cat, setCat] = useState(null);
  const [sel, setSel] = useState(null);
  const [msg, setMsg] = useState('');
  const [anon, setAnon] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setCat(null); setSel(null); setMsg(''); setAnon(false); setBusy(false);
    onCatalog().then(d => setCat(d.gifts || [])).catch(e => { flash('Магазин недоступен: ' + e.message, 'err'); setCat([]); });
  }, [visible, onCatalog, flash]);
  const send = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      await onSend(sel, msg.trim(), anon);
      onClose();
    } catch (e) {
      flash('Не отправить: ' + e.message, 'err');
    }
    setBusy(false);
  };
  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
      <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.giCard}>
          <Text style={styles.giTitle}>🎁 Отправить подарок</Text>
          <Text style={styles.giSub}>→ {peerName}</Text>
          {cat === null ? (
            <ActivityIndicator color={C.accent} style={{marginVertical: 20}} />
          ) : (
            <ScrollView style={{maxHeight: 430}} keyboardShouldPersistTaps="handled">
              <View style={styles.giftGridM}>
                {cat.map(g => {
                  const sold = g.left === 0;
                  const on = sel && sel.id === g.id;
                  return (
                    <TouchableOpacity
                      key={g.id}
                      disabled={sold}
                      style={[styles.giftCardM, on && styles.giftCardMOn, sold && {opacity: 0.4}]}
                      onPress={() => setSel(g)}>
                      <Text style={{fontSize: 30}}>{g.emoji}</Text>
                      <Text style={styles.giftNmM} numberOfLines={1}>{g.name}</Text>
                      <Text style={styles.giftPrM}>{g.price} 👻</Text>
                      {g.left != null && <Text style={styles.giftLeftM}>{sold ? 'распродан' : 'ост. ' + g.left}</Text>}
                    </TouchableOpacity>
                  );
                })}
              </View>
              {sel && (
                <>
                  <TextInput
                    style={[styles.input, {marginTop: 10}]}
                    placeholder="Добавить сообщение (по желанию)…"
                    placeholderTextColor={C.sub}
                    value={msg}
                    onChangeText={setMsg}
                    maxLength={200}
                  />
                  <View style={[styles.giRow, {borderBottomWidth: 0}]}>
                    <Text style={styles.giRowLbl}>Отправить анонимно</Text>
                    <Switch value={anon} onValueChange={setAnon} trackColor={{true: C.accentDim}} thumbColor={anon ? C.accent : C.sub} />
                  </View>
                  <TouchableOpacity style={[styles.primaryBtn, {marginTop: 8}]} disabled={busy} onPress={send}>
                    <Text style={styles.primaryBtnText}>{busy ? '…' : `Отправить · ${sel.price} 👻`}</Text>
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity style={[styles.setBtn, {marginTop: 10}]} onPress={onClose}>
                <Text style={styles.setBtnText}>Закрыть</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function ChatScreen({chat, msgs, onBack, onSend, onCall, onImage, onSendVoice, onSendVideoNote, getVoiceB64, onVoiceListened, onNoteWatched, getPresence, onReact, onDonate, onDelete, onForwardAttach, onSaveAttach, onGiftCatalog, onGiftSend, nameOf, avatarUri, alias, onSetAlias, muted, onMute, meId, onGetRoom, onSaveGroup, onInvite, onGetLink, onSaveRoomProfile, flash}) {
  const [text, setText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sheetMsg, setSheetMsg] = useState(null);
  const [fwdMsg, setFwdMsg] = useState(null); // пересылаемое вложение
  const [fwdTo, setFwdTo] = useState('');
  const [giftOpen, setGiftOpen] = useState(false); // 🎁 магазин подарков
  const [giftInfo, setGiftInfo] = useState(null); // 🎁 просмотр подарка (кто отправил)
  const openGift = useCallback(item => setGiftInfo(item), []);
  // Поиск по истории чата + кнопка «вниз»
  const [srchOpen, setSrchOpen] = useState(false);
  const [srchQ, setSrchQ] = useState('');
  const [srchHits, setSrchHits] = useState([]); // индексы сообщений с совпадением
  const [srchIdx, setSrchIdx] = useState(-1);
  const [hitId, setHitId] = useState(null); // id подсвеченного сообщения
  const [showDown, setShowDown] = useState(false);
  useEffect(() => {
    const q = srchQ.trim().toLowerCase();
    if (!srchOpen || !q) { setSrchHits([]); setSrchIdx(-1); setHitId(null); return; }
    const hits = [];
    msgs.forEach((m, i) => {
      const s = (m.text || (m.att && m.att.filename) || '').toLowerCase();
      if (s.includes(q)) hits.push(i);
    });
    setSrchHits(hits);
    if (hits.length) {
      const idx = hits.length - 1; // с самого свежего
      setSrchIdx(idx);
      const mi = hits[idx];
      setHitId(msgs[mi] && msgs[mi].id);
      setTimeout(() => { try { listRef.current && listRef.current.scrollToIndex({index: mi, viewPosition: 0.5}); } catch (e) {} }, 60);
    } else { setSrchIdx(-1); setHitId(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srchQ, srchOpen]);
  const srchJump = i => {
    if (!srchHits.length) return;
    const idx = ((i % srchHits.length) + srchHits.length) % srchHits.length;
    setSrchIdx(idx);
    const mi = srchHits[idx];
    setHitId(msgs[mi] && msgs[mi].id);
    try { listRef.current && listRef.current.scrollToIndex({index: mi, viewPosition: 0.5}); } catch (e) {}
  };
  const [aliasOpen, setAliasOpen] = useState(false);
  const [aliasText, setAliasText] = useState(alias || '');
  const [muteOpen, setMuteOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false); // информация/настройки группы
  // Проигрываемое голосовое: {id, pos, dur, playing}
  const [voiceState, setVoiceState] = useState(null);
  const [presence, setPresence] = useState(null);
  const listRef = useRef(null);

  // Статус собеседника: тянем при открытии и обновляем раз в 45с (как десктоп).
  useEffect(() => {
    if (chat.kind !== 'dm') {
      setPresence(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const p = await getPresence(chat.id);
        if (alive) setPresence(p);
      } catch {}
    };
    load();
    const iv = setInterval(load, 45000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [chat.id, chat.kind, getPresence]);
  const presInfo = chat.kind === 'dm' ? formatPresence(presence) : null;

  // Подписка на прогресс нативного плеера голосовых.
  useEffect(() => {
    const sub = onVoiceProgress(ev => {
      if (!ev || !ev.id) return;
      if (ev.ended) {
        setVoiceState(null);
      } else {
        setVoiceState({id: ev.id, pos: ev.pos || 0, dur: ev.dur || 0, playing: !!ev.playing});
      }
    });
    return () => {
      try {
        sub.remove();
      } catch {}
      stopVoicePlay();
    };
  }, []);

  const toggleVoice = useCallback(
    async item => {
      try {
        const cur = voiceState;
        if (cur && cur.id === item.id) {
          if (cur.playing) {
            setVoiceState({...cur, playing: false});
            await pauseVoice();
          } else {
            setVoiceState({...cur, playing: true});
            await resumeVoice();
          }
          return;
        }
        await stopVoicePlay();
        setVoiceState({id: item.id, pos: 0, dur: (item.att && item.att.dur) || 0, playing: true});
        // Прослушивание входящего → отправитель увидит вторую синюю галочку.
        if (item.dir === 'in' && onVoiceListened) onVoiceListened(item);
        const b64 = await getVoiceB64(item);
        await playVoice(item.id, b64);
      } catch (e) {
        setVoiceState(null);
      }
    },
    [voiceState, getVoiceB64, onVoiceListened],
  );

  // ── Запись голосового/видео (тап по кнопке — переключить 🎤/📷, зажать — запись) ─
  const notesOk = VIDEONOTE_SUPPORTED;
  const [recMode, setRecMode] = useState('voice'); // 'voice' | 'video'
  const [recording, setRecording] = useState(false);
  const [recCancel, setRecCancel] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [videoRecOpen, setVideoRecOpen] = useState(false);
  const recModeRef = useRef('voice');
  recModeRef.current = recMode;
  const recActiveRef = useRef(false); // палец удерживает кнопку
  const recStartedRef = useRef(false); // нативная запись реально пошла
  const recCancelRef = useRef(false);
  const recTimerRef = useRef(null);
  const recT0Ref = useRef(0);
  const tapTimerRef = useRef(null); // отличаем короткий тап (переключение) от удержания

  // ── Плеер видео-заметки (кружочек в модалке) ────────────────────────────────
  const [noteState, setNoteState] = useState(null); // {id, pos, dur, playing}
  const noteItemRef = useRef(null);
  useEffect(() => {
    const sub = onNoteProgress(ev => {
      if (!ev || !ev.id) return;
      if (ev.ended) {
        setNoteState(null);
        noteItemRef.current = null;
      } else {
        setNoteState({id: ev.id, pos: ev.pos || 0, dur: ev.dur || 0, playing: !!ev.playing});
      }
    });
    return () => {
      try {
        sub.remove();
      } catch {}
      stopNotePlay();
    };
  }, []);
  const openNote = useCallback(
    async item => {
      try {
        noteItemRef.current = item;
        setNoteState({id: item.id, pos: 0, dur: (item.att && item.att.dur) || 0, playing: true});
        if (item.dir === 'in' && onNoteWatched) onNoteWatched(item);
        const b64 = await getVoiceB64(item);
        await playNote(item.id, b64);
      } catch (e) {
        setNoteState(null);
        noteItemRef.current = null;
      }
    },
    [getVoiceB64, onNoteWatched],
  );
  const closeNote = useCallback(() => {
    stopNotePlay();
    setNoteState(null);
    noteItemRef.current = null;
  }, []);

  const requestRecPerm = useCallback(async video => {
    if (Platform.OS !== 'android') return true; // iOS: доступ запрашивает сам нативный модуль
    try {
      const perms = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
      if (video) perms.push(PermissionsAndroid.PERMISSIONS.CAMERA);
      const res = await PermissionsAndroid.requestMultiple(perms);
      return Object.values(res).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
    } catch {
      return false;
    }
  }, []);

  const startRec = useCallback(async () => {
    if (chat.kind !== 'dm') {
      Alert.alert('Сообщения', 'Пока доступны только в личных чатах');
      return;
    }
    const mode = recModeRef.current;
    const ok = await requestRecPerm(mode === 'video');
    if (!ok) {
      Alert.alert('Нет доступа', mode === 'video' ? 'Разрешите камеру и микрофон' : 'Разрешите микрофон');
      return;
    }
    if (recActiveRef.current) return;
    recActiveRef.current = true;
    recCancelRef.current = false;
    setRecCancel(false);
    setRecElapsed(0);
    setRecording(true);
    if (mode === 'video') setVideoRecOpen(true);
    recT0Ref.current = Date.now();
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    recTimerRef.current = setInterval(() => {
      const s = (Date.now() - recT0Ref.current) / 1000;
      setRecElapsed(s);
      if (s >= 60) finishRecRef.current(false); // максимум 60 сек
    }, 200);
    try {
      if (mode === 'video') await startNote('front');
      else await startVoice();
      recStartedRef.current = true;
      if (!recActiveRef.current) {
        // отпустили раньше старта — отменяем
        if (mode === 'video') await cancelNote();
        else await cancelVoice();
        recStartedRef.current = false;
        setVideoRecOpen(false);
      }
    } catch (e) {
      recActiveRef.current = false;
      recStartedRef.current = false;
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      setRecording(false);
      setVideoRecOpen(false);
      Alert.alert('Ошибка', 'Не удалось начать запись');
    }
  }, [chat.kind, requestRecPerm]);

  const finishRec = useCallback(
    async cancel => {
      if (!recActiveRef.current) return;
      recActiveRef.current = false;
      if (recTimerRef.current) {
        clearInterval(recTimerRef.current);
        recTimerRef.current = null;
      }
      const mode = recModeRef.current;
      const wasStarted = recStartedRef.current;
      recStartedRef.current = false;
      setRecording(false);
      setRecCancel(false);
      recCancelRef.current = false;
      setVideoRecOpen(false);
      if (cancel || !wasStarted) {
        if (mode === 'video') await cancelNote();
        else await cancelVoice();
        return;
      }
      try {
        if (mode === 'video') {
          const rec = await stopNote();
          onSendVideoNote(rec);
        } else {
          const rec = await stopVoice();
          onSendVoice(rec);
        }
      } catch (e) {
        // слишком коротко — молча отменяем
      }
    },
    [onSendVoice, onSendVideoNote],
  );
  const finishRecRef = useRef(finishRec);
  useEffect(() => {
    finishRecRef.current = finishRec;
  }, [finishRec]);

  const recPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        // Запись стартует после короткой задержки; быстрый тап = переключение режима.
        if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
        tapTimerRef.current = setTimeout(() => {
          tapTimerRef.current = null;
          startRecRef.current();
        }, 220);
      },
      onPanResponderMove: (e, g) => {
        if (!recActiveRef.current) return;
        const willCancel = g.dx < -70;
        if (willCancel !== recCancelRef.current) {
          recCancelRef.current = willCancel;
          setRecCancel(willCancel);
        }
      },
      onPanResponderRelease: (e, g) => {
        if (tapTimerRef.current) {
          // отпустили раньше 220мс → это тап: переключаем 🎤 ↔ 📷
          clearTimeout(tapTimerRef.current);
          tapTimerRef.current = null;
          if (noteModeRef.current) setRecMode(m => (m === 'voice' ? 'video' : 'voice'));
        } else {
          finishRecRef.current(g.dx < -70);
        }
      },
      onPanResponderTerminate: () => {
        if (tapTimerRef.current) {
          clearTimeout(tapTimerRef.current);
          tapTimerRef.current = null;
        } else {
          finishRecRef.current(true);
        }
      },
    }),
  ).current;
  const startRecRef = useRef(startRec);
  useEffect(() => {
    startRecRef.current = startRec;
  }, [startRec]);
  const noteModeRef = useRef(notesOk);
  noteModeRef.current = notesOk;

  useEffect(() => {
    if (listRef.current && msgs.length)
      setTimeout(() => listRef.current.scrollToEnd({animated: true}), 60);
  }, [msgs.length]);

  const sub =
    chat.kind === 'channel'
      ? 'канал'
      : chat.kind === 'group'
        ? 'группа · E2E 🔒'
        : 'зашифровано E2E 🔒';

  // Настройки группы/канала — ПОЛНОЭКРАННЫЙ экран (была модалка: она не прокручивалась).
  if (infoOpen && chat.kind !== 'dm') {
    return (
      <GroupInfoScreen
        chat={chat}
        meId={meId}
        onBack={() => setInfoOpen(false)}
        onGetRoom={onGetRoom}
        onSaveGroup={onSaveGroup}
        onInvite={onInvite}
        onGetLink={onGetLink}
        onSaveRoomProfile={onSaveRoomProfile}
        flash={flash}
      />
    );
  }


  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{flex: 1}}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>‹</Text>
        </TouchableOpacity>
        <View style={{marginRight: 10}}>
          <Avatar
            uri={avatarUri}
            kind={chat.kind}
            size={38}
            label={chat.kind === 'dm' ? nameOf(chat.id) : chat.name || chat.id}
          />
        </View>
        <TouchableOpacity
          style={{flex: 1}}
          activeOpacity={0.6}
          onPress={() => {
            if (chat.kind === 'dm') {
              setAliasText(alias || '');
              setAliasOpen(true);
            } else {
              setInfoOpen(true); // группа/канал → информация и настройки
            }
          }}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {KIND_ICON[chat.kind]}
            {chat.kind === 'dm' ? nameOf(chat.id) : chat.name || chat.id}
          </Text>
          <Text
            style={[styles.headerSub, presInfo && presInfo.online && styles.headerSubOnline]}
            numberOfLines={1}>
            {chat.kind === 'dm'
              ? presInfo && presInfo.text
                ? presInfo.text
                : chat.id
              : sub}
          </Text>
        </TouchableOpacity>
        {chat.kind === 'dm' && CALLS_SUPPORTED && (
          <TouchableOpacity onPress={() => onCall(chat.id, false)} style={styles.iconBtn}>
            <Text style={[styles.iconBtnText, {fontSize: 20}]}>📞</Text>
          </TouchableOpacity>
        )}
        {chat.kind === 'dm' && VIDEO_SUPPORTED && (
          // Тап — обычный видеозвонок (VP8). Долгий тап — тестовый H.264 (для проверки перед iOS).
          <TouchableOpacity
            onPress={() => onCall(chat.id, true)}
            onLongPress={() => onCall(chat.id, true, 'h264')}
            style={styles.iconBtn}>
            <Text style={[styles.iconBtnText, {fontSize: 20}]}>📹</Text>
          </TouchableOpacity>
        )}
        {chat.kind === 'dm' && (
          <TouchableOpacity onPress={() => setGiftOpen(true)} style={styles.iconBtn}>
            <Text style={[styles.iconBtnText, {fontSize: 18}]}>🎁</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={() => setSrchOpen(o => !o)} style={styles.iconBtn}>
          <Text style={[styles.iconBtnText, {fontSize: 18}]}>🔍</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setMuteOpen(true)} style={styles.iconBtn}>
          <Text style={[styles.iconBtnText, {fontSize: 20}]}>{muted ? '🔕' : '🔔'}</Text>
        </TouchableOpacity>
      </View>

      {chat.kind === 'dm' && (
        <GiftShopModal
          visible={giftOpen}
          onClose={() => setGiftOpen(false)}
          peerName={nameOf ? nameOf(chat.id) : chat.id}
          onCatalog={onGiftCatalog}
          onSend={onGiftSend}
          flash={flash}
        />
      )}

      <GiftInfoModal item={giftInfo} onClose={() => setGiftInfo(null)} nameOf={nameOf} />


      <Modal transparent animationType="fade" visible={muteOpen} onRequestClose={() => setMuteOpen(false)}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setMuteOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.sheet}>
            <Text style={styles.sheetLabel}>
              {muted ? 'Уведомления выключены' : 'Выключить уведомления'}
            </Text>
            {muted ? (
              <TouchableOpacity
                style={styles.setBtn}
                onPress={() => {
                  onMute(null);
                  setMuteOpen(false);
                }}>
                <Text style={styles.setBtnText}>🔔 Включить уведомления</Text>
              </TouchableOpacity>
            ) : (
              MUTE_OPTIONS.map(o => (
                <TouchableOpacity
                  key={o.label}
                  style={styles.sheetAction}
                  onPress={() => {
                    onMute(o.ms);
                    setMuteOpen(false);
                  }}>
                  <Text style={styles.sheetActionText}>{o.label}</Text>
                </TouchableOpacity>
              ))
            )}
            <TouchableOpacity style={styles.sheetAction} onPress={() => setMuteOpen(false)}>
              <Text style={[styles.sheetActionText, {color: C.sub}]}>Отмена</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal transparent animationType="fade" visible={aliasOpen} onRequestClose={() => setAliasOpen(false)}>
        <TouchableOpacity
          style={styles.sheetBackdrop}
          activeOpacity={1}
          onPress={() => setAliasOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={[styles.sheet, {borderRadius: 16, margin: 16}]}>
            <Text style={styles.sheetLabel}>Псевдоним контакта (только для вас)</Text>
            <TextInput
              style={styles.input}
              placeholder="напр. Жена, Сын, Иван"
              placeholderTextColor={C.sub}
              value={aliasText}
              onChangeText={setAliasText}
              autoFocus
            />
            <Text style={styles.setHint}>
              Видно только вам и синхронизируется на все ваши устройства. Оставьте пустым,
              чтобы показывать имя из профиля.
            </Text>
            <TouchableOpacity
              style={styles.setBtn}
              onPress={() => {
                onSetAlias(aliasText.trim());
                setAliasOpen(false);
              }}>
              <Text style={styles.setBtnText}>Сохранить</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {msgs.length === 0 && chat.kind !== 'channel' && (
        <View style={styles.noticeWrap}>
          <Text style={styles.notice}>
            {chat.kind === 'dm'
              ? 'Старая переписка зашифрована для других ваших устройств (E2E) и здесь не показывается. Новые сообщения будут появляться на всех устройствах.'
              : 'История группы зашифрована E2E — здесь появятся новые сообщения.'}
          </Text>
        </View>
      )}

      {srchOpen && (
        <View style={styles.srchBar}>
          <TextInput
            style={[styles.input, {flex: 1, marginBottom: 0, paddingVertical: 8}]}
            placeholder="Поиск по чату…"
            placeholderTextColor={C.sub}
            autoCapitalize="none"
            autoCorrect={false}
            value={srchQ}
            onChangeText={setSrchQ}
            autoFocus
          />
          <Text style={styles.srchCount}>{srchHits.length ? `${srchIdx + 1}/${srchHits.length}` : srchQ ? '0' : ''}</Text>
          <TouchableOpacity style={styles.iconBtn} onPress={() => srchJump(srchIdx - 1)}>
            <Text style={styles.iconBtnText}>︿</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => srchJump(srchIdx + 1)}>
            <Text style={styles.iconBtnText}>﹀</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => { setSrchOpen(false); setSrchQ(''); setHitId(null); }}>
            <Text style={styles.iconBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{flex: 1}}>
        <FlatList
          ref={listRef}
          data={msgs}
          keyExtractor={(m, i) => m.id || String(i)}
          contentContainerStyle={{padding: 10, paddingBottom: 14}}
          extraData={[voiceState, hitId]}
          renderItem={({item}) => (
            <Bubble
              item={item}
              chat={chat}
              onLongPress={setSheetMsg}
              nameOf={nameOf}
              voiceState={voiceState}
              onToggleVoice={toggleVoice}
              onToggleNote={openNote}
              onGiftOpen={openGift}
              hl={hitId != null && item.id === hitId}
            />
          )}
          onContentSizeChange={() => {
            if (!srchOpen) listRef.current && listRef.current.scrollToEnd({animated: false});
          }}
          onScroll={e => {
            const ne = e.nativeEvent;
            const far = ne.contentSize.height - ne.contentOffset.y - ne.layoutMeasurement.height > 400;
            if (far !== showDown) setShowDown(far);
          }}
          scrollEventThrottle={120}
          onScrollToIndexFailed={info => {
            // Далёкое сообщение ещё не отрендерено — прыгаем примерно и повторяем.
            try {
              listRef.current && listRef.current.scrollToOffset({offset: Math.max(0, info.averageItemLength * info.index), animated: false});
              setTimeout(() => { try { listRef.current && listRef.current.scrollToIndex({index: info.index, viewPosition: 0.5}); } catch (e2) {} }, 120);
            } catch (e2) {}
          }}
        />
        {showDown && (
          <TouchableOpacity
            style={styles.scrollDownBtn}
            onPress={() => listRef.current && listRef.current.scrollToEnd({animated: true})}>
            <Text style={styles.scrollDownIc}>⌄</Text>
          </TouchableOpacity>
        )}
      </View>

      <MessageSheet
        msg={sheetMsg}
        chat={chat}
        onReact={onReact}
        onDonate={onDonate}
        onDelete={onDelete}
        onForward={m => {
          setFwdTo('');
          setFwdMsg(m);
        }}
        onSaveFile={m => onSaveAttach && onSaveAttach(m)}
        onClose={() => setSheetMsg(null)}
      />

      <Modal transparent animationType="fade" visible={!!fwdMsg} onRequestClose={() => setFwdMsg(null)}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setFwdMsg(null)}>
          <TouchableOpacity activeOpacity={1} style={styles.sheet}>
            <Text style={styles.sheetLabel}>Переслать файл кому (имя:сервер)</Text>
            <TextInput
              style={[styles.input, {marginBottom: 10}]}
              placeholder="bob:example.org"
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              autoCorrect={false}
              value={fwdTo}
              onChangeText={setFwdTo}
            />
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={async () => {
                const to = fwdTo.trim();
                const att = fwdMsg && fwdMsg.att;
                setFwdMsg(null);
                if (to && to.includes(':') && att && onForwardAttach) await onForwardAttach(att, to);
              }}>
              <Text style={styles.primaryBtnText}>Переслать</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {emojiOpen && (
        <View style={styles.emojiPanel}>
          <ScrollView contentContainerStyle={styles.emojiGrid}>
            {EMOJI_SET.map((e, i) => (
              <TouchableOpacity
                key={e + i}
                style={styles.emojiCell}
                onPress={() => setText(t => t + e)}>
                <Text style={styles.emojiChar}>{e}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
      <View style={styles.inputBar}>
        <TouchableOpacity style={styles.attachBtn} onPress={onImage}>
          <Text style={styles.attachIcon}>📎</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.attachBtn}
          onPress={() => setEmojiOpen(o => !o)}>
          <Text style={styles.attachIcon}>{emojiOpen ? '⌨️' : '😊'}</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.msgInput}
          placeholder="Сообщение"
          placeholderTextColor={C.sub}
          value={text}
          onChangeText={setText}
          onFocus={() => setEmojiOpen(false)}
          multiline
        />
        {text.trim().length > 0 || !VOICE_SUPPORTED || chat.kind !== 'dm' ? (
          <TouchableOpacity
            style={styles.sendBtn}
            onPress={() => {
              if (!text.trim()) return;
              onSend(text);
              setText('');
            }}>
            <Text style={styles.sendBtnText}>➤</Text>
          </TouchableOpacity>
        ) : (
          <View
            style={[styles.micBtn, recording && styles.micBtnRec]}
            {...recPan.panHandlers}>
            <Text style={styles.micIcon}>{recMode === 'video' ? '📷' : '🎤'}</Text>
          </View>
        )}
        {recording && recMode === 'voice' && (
          <View style={styles.recOverlay} pointerEvents="none">
            <View style={styles.recDot} />
            <Text style={styles.recTime}>{fmtRec(recElapsed)}</Text>
            <Text
              style={[styles.recHint, recCancel && styles.recHintCancel]}
              numberOfLines={1}>
              {recCancel ? 'Отпустите для отмены' : '‹ Влево — отмена'}
            </Text>
          </View>
        )}
      </View>

      {/* Оверлей записи видео-кружочка (не Modal — чтобы палец остался на кнопке) */}
      {videoRecOpen && (
        <View style={styles.noteRecOverlay} pointerEvents="none">
          <View style={styles.noteCircleWrap}>
            {NoteView ? (
              <NoteView role="record" style={styles.noteCircle} />
            ) : null}
          </View>
          <View style={styles.noteRecInfoRow}>
            <View style={styles.recDot} />
            <Text style={styles.noteRecTime}>{fmtRec(recElapsed)}</Text>
          </View>
          <Text style={[styles.noteRecHint, recCancel && styles.recHintCancel]}>
            {recCancel ? 'Отпустите для отмены' : '‹ Влево — отмена · держите для записи'}
          </Text>
        </View>
      )}

      {/* Плеер видео-кружочка (Modal — открывается по тапу, жест не нужен) */}
      <Modal
        transparent
        visible={!!noteState}
        animationType="fade"
        onRequestClose={closeNote}>
        <TouchableOpacity
          style={styles.notePlayBackdrop}
          activeOpacity={1}
          onPress={closeNote}>
          <View style={styles.noteCircleWrap}>
            {NoteView ? <NoteView role="play" style={styles.noteCircle} /> : null}
          </View>
          <Text style={styles.noteRecTime}>
            {fmtRec(noteState ? noteState.pos : 0)} /{' '}
            {fmtRec(noteState ? noteState.dur : 0)}
          </Text>
          <Text style={styles.noteCloseHint}>нажмите, чтобы закрыть</Text>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

class ErrorBoundary extends React.Component {
  constructor(p) {
    super(p);
    this.state = {err: null};
  }
  static getDerivedStateFromError(e) {
    return {err: (e && e.message) || String(e)};
  }
  render() {
    if (this.state.err) {
      return (
        <SafeAreaView style={styles.root}>
          <View style={styles.center}>
            <Text style={styles.logo}>👻</Text>
            <Text style={[styles.title, {fontSize: 20}]}>
              Что-то пошло не так
            </Text>
            <Text style={[styles.empty, {marginTop: 12}]}>{this.state.err}</Text>
            <TouchableOpacity
              style={[styles.primaryBtn, {marginTop: 20, paddingHorizontal: 24}]}
              onPress={() => this.setState({err: null})}>
              <Text style={styles.primaryBtnText}>Продолжить</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24},
  logo: {fontSize: 60, marginBottom: 16},
  logoBig: {fontSize: 64, textAlign: 'center', marginTop: 24},
  title: {
    color: C.text,
    fontSize: 30,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 4,
  },
  subtitle: {color: C.sub, textAlign: 'center', marginTop: 4, marginBottom: 18},
  authWrap: {padding: 22, paddingBottom: 40},
  label: {color: C.sub, fontSize: 13, marginTop: 14, marginBottom: 6},
  hint: {color: C.accent, fontSize: 12, marginTop: 4},
  input: {
    backgroundColor: C.panel,
    color: C.text,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: C.line,
  },
  serverRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  serverChip: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 18,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.line,
    marginRight: 8,
    marginBottom: 8,
  },
  serverChipOn: {backgroundColor: C.accent, borderColor: C.accent},
  serverChipText: {color: C.sub, fontSize: 13},
  primaryBtn: {
    backgroundColor: C.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 22,
  },
  primaryBtnText: {color: '#fff', fontSize: 16, fontWeight: '700'},
  switchText: {color: C.accent, textAlign: 'center', marginTop: 18, fontSize: 14},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.panel,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  headerTitle: {color: C.text, fontSize: 18, fontWeight: '700'},
  headerSub: {color: C.sub, fontSize: 12, marginTop: 1},
  headerSubOnline: {color: '#4cd964'},
  iconBtn: {paddingHorizontal: 10, paddingVertical: 4},
  iconBtnText: {color: C.accent, fontSize: 26, fontWeight: '600'},
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    backgroundColor: C.panel2,
    gap: 8,
  },
  addBtn: {
    backgroundColor: C.accent,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginLeft: 8,
  },
  newMenu: {backgroundColor: C.panel2, paddingVertical: 4},
  newItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  newIco: {fontSize: 20, width: 26, textAlign: 'center'},
  newLbl: {color: C.text, fontSize: 15.5},
  // Аудио-файл (инлайн-плеер)
  audRow: {flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 210},
  audBtn: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},
  audBtnIcon: {color: '#fff', fontSize: 16},
  audName: {color: C.text, fontSize: 13.5, fontWeight: '600', marginBottom: 5},
  audBar: {height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden'},
  audFill: {height: 4, borderRadius: 2},
  audTime: {color: C.sub, fontSize: 11, marginTop: 4},
  // 🎁 Подарки
  giftGridM: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8},
  giftCardM: {width: '30.5%', backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 14, alignItems: 'center', paddingVertical: 10},
  giftCardMOn: {borderColor: C.accent, borderWidth: 2},
  giftNmM: {color: C.text, fontSize: 11.5, marginTop: 3, maxWidth: '92%'},
  giftPrM: {color: C.accent, fontSize: 12, fontWeight: '700', marginTop: 2},
  giftLeftM: {color: C.sub, fontSize: 10, marginTop: 1},
  giftBubble: {alignItems: 'center', paddingVertical: 4, paddingHorizontal: 8, minWidth: 140},
  giftBubbleEm: {fontSize: 42},
  giftBubbleT: {color: C.text, fontSize: 13.5, fontWeight: '700', marginTop: 2, textAlign: 'center'},
  giftBubbleM: {color: C.sub, fontSize: 12.5, marginTop: 3, textAlign: 'center'},
  giftBubbleHint: {color: C.accent, fontSize: 11, marginTop: 5, textAlign: 'center', opacity: 0.9},
  // Живой статус на кнопке входа/регистрации
  btnStageRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  btnStageText: {color: '#fff', fontSize: 15, fontWeight: '700'},
  // Превью ссылок
  lpCard: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 6, paddingLeft: 9,
    borderLeftWidth: 3, borderLeftColor: C.accent, borderRadius: 4},
  lpSite: {color: C.accent, fontSize: 12.5, fontWeight: '700', marginBottom: 1},
  lpTitle: {color: C.text, fontSize: 13.5, fontWeight: '700', lineHeight: 18},
  lpDesc: {color: C.sub, fontSize: 12.5, lineHeight: 17, marginTop: 2},
  lpImg: {width: 54, height: 54, borderRadius: 8, backgroundColor: C.bg},
  // Конфиденциальность (в стиле Telegram)
  privIco: {fontSize: 14, width: 28, height: 28, borderRadius: 7, textAlign: 'center', lineHeight: 28, marginRight: 12, overflow: 'hidden'},
  privVal: {color: C.sub, fontSize: 14.5, marginRight: 6},
  privChev: {color: C.sub, fontSize: 18},
  privCap: {color: C.sub, fontSize: 12.5, letterSpacing: 0.6, marginTop: 18, marginBottom: 8, marginLeft: 4},
  privRadioRow: {flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14},
  privRadioLbl: {color: C.text, fontSize: 16, flex: 1},
  privCheck: {color: C.accent, fontSize: 17, fontWeight: '800'},
  privSep: {height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginLeft: 14},
  privHint: {color: C.sub, fontSize: 13, lineHeight: 18, marginTop: 8, marginLeft: 4, marginRight: 4},
  privAddRow: {flexDirection: 'row', alignItems: 'center', padding: 10, gap: 8},
  privInput: {flex: 1, backgroundColor: C.bg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, color: C.text, fontSize: 15},
  privAddBtn: {backgroundColor: C.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10},
  privItem: {flexDirection: 'row', alignItems: 'center', padding: 10},
  // Просмотр подарка + анимация призраков
  giftInfoBackdrop: {flex: 1, backgroundColor: '#0009', justifyContent: 'center', alignItems: 'center', padding: 22},
  giftInfoCard: {width: '100%', maxWidth: 360, backgroundColor: C.panel, borderRadius: 20, padding: 20, alignItems: 'stretch'},
  ghostStage: {height: 170, alignItems: 'center', justifyContent: 'center', marginBottom: 6, overflow: 'hidden'},
  ghostGift: {fontSize: 66},
  giftInfoName: {color: C.text, fontSize: 20, fontWeight: '800', textAlign: 'center', marginBottom: 12},
  giftInfoRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line},
  giftInfoLbl: {color: C.sub, fontSize: 14},
  giftInfoVal: {color: C.text, fontSize: 14, fontWeight: '700', flexShrink: 1, textAlign: 'right', marginLeft: 12},
  giftInfoMsgBox: {backgroundColor: C.bg, borderRadius: 12, padding: 12, marginTop: 10},
  giftInfoMsg: {color: C.text, fontSize: 14.5, fontStyle: 'italic', textAlign: 'center'},
  giftInfoClose: {marginTop: 16, backgroundColor: C.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center'},
  giftInfoCloseT: {color: '#fff', fontSize: 15, fontWeight: '700'},
  // Поиск по чату + кнопка «вниз»
  srchBar: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.line},
  srchCount: {color: C.sub, fontSize: 12.5, minWidth: 38, textAlign: 'center'},
  bubbleHl: {borderWidth: 2, borderColor: C.accent},
  scrollDownBtn: {position: 'absolute', right: 14, bottom: 14, width: 44, height: 44, borderRadius: 22, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', elevation: 4},
  scrollDownIc: {color: C.text, fontSize: 22, marginTop: -4},
  // Информация/настройки группы
  giCard: {
    backgroundColor: C.panel,
    borderRadius: 16,
    margin: 16,
    padding: 16,
    maxHeight: '88%',
  },
  giTitle: {color: C.text, fontSize: 17, fontWeight: '700', marginBottom: 4},
  giFooter: {flexDirection: 'row', gap: 10, padding: 14, paddingBottom: 18, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.panel},
  giSub: {color: C.sub, fontSize: 13, marginBottom: 6},
  giSec: {
    color: C.sub,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 16,
    marginBottom: 8,
  },
  giRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  giRowLbl: {color: C.text, fontSize: 14.5, flex: 1, marginRight: 8},
  giChips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  giChip: {
    backgroundColor: C.panel2,
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: C.line,
  },
  giChipOn: {backgroundColor: C.accentDim, borderColor: C.accent},
  giChipText: {color: C.sub, fontSize: 13.5},
  giChipTextOn: {color: '#fff', fontWeight: '600'},
  giLink: {color: C.accent, fontSize: 13, marginTop: 10},
  giHint: {color: C.sub, fontSize: 11.5, marginTop: 2},
  // App Lock
  lockWrap: {flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', paddingBottom: 30},
  lockGhost: {fontSize: 56, marginBottom: 10},
  lockTitle: {color: C.text, fontSize: 20, fontWeight: '700', marginBottom: 6},
  lockHint: {color: C.sub, fontSize: 14, marginBottom: 22, minHeight: 18},
  pinDots: {flexDirection: 'row', gap: 18, marginBottom: 36},
  pinDot: {width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: C.sub},
  pinDotOn: {backgroundColor: C.accent, borderColor: C.accent},
  keypad: {width: 300, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between'},
  key: {width: 88, height: 74, alignItems: 'center', justifyContent: 'center'},
  keyTxt: {color: C.text, fontSize: 30, fontWeight: '500'},
  keyBio: {fontSize: 28},
  empty: {color: C.sub, textAlign: 'center', fontSize: 15, lineHeight: 22},
  noticeWrap: {padding: 10},
  notice: {
    color: C.sub,
    fontSize: 12.5,
    lineHeight: 17,
    backgroundColor: C.panel,
    borderRadius: 10,
    padding: 10,
    textAlign: 'center',
  },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: C.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: {color: '#fff', fontSize: 20, fontWeight: '700'},
  chatName: {color: C.text, fontSize: 16, fontWeight: '600'},
  chatPreview: {color: C.sub, fontSize: 13, marginTop: 2},
  bubble: {
    maxWidth: '82%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginVertical: 3,
  },
  bubbleIn: {backgroundColor: C.bubbleIn, alignSelf: 'flex-start'},
  bubbleOut: {backgroundColor: C.bubbleOut, alignSelf: 'flex-end'},
  bubbleFrom: {color: C.accent, fontSize: 12, marginBottom: 2, fontWeight: '600'},
  bubbleText: {color: C.text, fontSize: 15, lineHeight: 20},
  bubbleImage: {width: 220, height: 220, borderRadius: 10, backgroundColor: C.panel2},
  reactRow: {flexDirection: 'row', marginTop: 4, gap: 4},
  reactChip: {fontSize: 15, marginRight: 3},
  attachBtn: {
    width: 40,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 2,
  },
  attachIcon: {fontSize: 22},
  emojiPanel: {
    height: 220,
    backgroundColor: C.panel,
    borderTopWidth: 1,
    borderTopColor: C.line,
  },
  emojiGrid: {flexDirection: 'row', flexWrap: 'wrap', padding: 6},
  emojiCell: {
    width: '12.5%',
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiChar: {fontSize: 26},
  sheetBackdrop: {
    flex: 1,
    backgroundColor: '#0006',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: C.panel,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    paddingBottom: 26,
  },
  sheetLabel: {color: C.sub, fontSize: 13, marginTop: 8, marginBottom: 8},
  sheetReactRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6},
  sheetReactBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: C.panel2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
    marginBottom: 6,
  },
  sheetReactEmoji: {fontSize: 24},
  ghostBtn: {
    backgroundColor: C.panel2,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginRight: 6,
    marginBottom: 6,
  },
  ghostBtnText: {color: C.text, fontSize: 14, fontWeight: '600'},
  ghostCustomRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2, marginBottom: 6},
  ghostCustomInput: {
    flex: 1,
    backgroundColor: C.panel2,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
    color: C.text,
    fontSize: 14,
  },
  sheetAction: {paddingVertical: 14, alignItems: 'center'},
  sheetActionText: {color: C.accent, fontSize: 16, fontWeight: '600'},
  balanceText: {color: '#f5c542', fontSize: 18, fontWeight: '700'},
  avatarEditBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: C.panel,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
    backgroundColor: C.panel,
    borderTopWidth: 1,
    borderTopColor: C.line,
  },
  msgInput: {
    flex: 1,
    color: C.text,
    backgroundColor: C.panel2,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxHeight: 120,
    fontSize: 16,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  sendBtnText: {color: '#fff', fontSize: 18},
  micBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  micBtnRec: {backgroundColor: C.danger, transform: [{scale: 1.15}]},
  micIcon: {fontSize: 22},
  recOverlay: {
    position: 'absolute',
    left: 8,
    right: 60,
    top: 8,
    bottom: 8,
    backgroundColor: C.panel2,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  recDot: {width: 11, height: 11, borderRadius: 6, backgroundColor: C.danger, marginRight: 10},
  recTime: {color: C.text, fontSize: 16, fontVariant: ['tabular-nums'], marginRight: 14},
  recHint: {color: C.sub, fontSize: 14, flex: 1},
  recHintCancel: {color: C.danger, fontWeight: '700'},
  voiceRow: {flexDirection: 'row', alignItems: 'center', width: 232, maxWidth: '100%'},
  voicePlay: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  voicePlayIcon: {color: '#fff', fontSize: 17},
  voiceBody: {flex: 1, justifyContent: 'center', minWidth: 0},
  voiceWave: {flexDirection: 'row', alignItems: 'center', height: 26, overflow: 'hidden'},
  voiceDur: {color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 3},
  metaRow: {flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 2},
  tick: {fontSize: 12, fontWeight: '700'},
  ticksTwo: {flexDirection: 'row', alignItems: 'center'},
  // Видео-заметки: кружочек в ленте
  noteBubbleWrap: {alignItems: 'center', paddingVertical: 2},
  noteBubbleCircle: {
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: '#0b1a2a',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteBubblePlay: {color: '#fff', fontSize: 34, marginLeft: 4},
  noteBubbleDur: {color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 6},
  // Оверлей записи видео (превью-кружок)
  noteRecOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteCircleWrap: {
    width: 260,
    height: 260,
    borderRadius: 130,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 3,
    borderColor: C.accent,
  },
  noteCircle: {width: 260, height: 260},
  noteRecInfoRow: {flexDirection: 'row', alignItems: 'center', marginTop: 24},
  noteRecTime: {color: '#fff', fontSize: 18, fontVariant: ['tabular-nums']},
  noteRecHint: {color: C.sub, fontSize: 14, marginTop: 14},
  notePlayBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteCloseHint: {color: C.sub, fontSize: 13, marginTop: 18},
  banner: {
    backgroundColor: C.accentDim,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  bannerText: {color: '#fff', fontSize: 13, textAlign: 'center'},
  unreadBadge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    marginLeft: 8,
  },
  unreadText: {color: '#fff', fontSize: 12, fontWeight: '700'},
  updateBar: {
    backgroundColor: '#2e9e5b',
    paddingVertical: 14,
    alignItems: 'center',
  },
  updateBarText: {color: '#fff', fontSize: 15, fontWeight: '700'},
  setSection: {
    color: C.sub,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  setCard: {
    backgroundColor: C.panel,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: C.line,
  },
  setRow: {flexDirection: 'row', alignItems: 'center', paddingVertical: 6},
  nodeRow: {flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)'},
  setLabel: {color: C.sub, fontSize: 12, marginTop: 8},
  setValue: {color: C.text, fontSize: 15},
  setHintSm: {color: C.sub, fontSize: 11.5, marginTop: 2},
  setMono: {color: C.text, fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'},
  setHint: {color: C.sub, fontSize: 12, marginTop: 8, lineHeight: 16},
  setBtn: {
    backgroundColor: C.panel2,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginTop: 8,
    alignItems: 'center',
  },
  setBtnText: {color: C.accent, fontSize: 15, fontWeight: '600'},
  callOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0b1219f2',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
  },
  callAvatar: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: C.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  callAvatarText: {color: '#fff', fontSize: 46, fontWeight: '700'},
  callPeer: {color: C.text, fontSize: 22, fontWeight: '700', textAlign: 'center'},
  callStatus: {color: C.sub, fontSize: 16, marginTop: 8},
  callPath: {color: C.sub, fontSize: 12, marginTop: 4, opacity: 0.8},
  callVideoNote: {
    color: C.sub,
    fontSize: 12.5,
    textAlign: 'center',
    marginTop: 14,
    maxWidth: 260,
  },
  callBtns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    marginTop: 60,
    paddingHorizontal: 16,
  },
  callBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBtnIcon: {color: '#fff', fontSize: 24},
  // Видеозвонок: кнопки — одним рядом внизу под видео (не перекрывают картинку).
  callBtnsBottom: {
    position: 'absolute',
    bottom: 28,
    left: 12,
    right: 12,
    flexDirection: 'row',
    flexWrap: 'nowrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    borderRadius: 36,
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  callTopBar: {
    position: 'absolute',
    top: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  callPathBadge: {
    position: 'absolute',
    top: 44,
    left: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  callPathBadgeText: {color: '#fff', fontSize: 12, fontWeight: '600'},
  localPreview: {
    position: 'absolute',
    top: 60,
    right: 16,
    width: 110,
    height: 150,
    borderRadius: 12,
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: '#ffffff33',
  },
});
