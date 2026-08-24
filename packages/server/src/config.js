// config.js — конфигурация homeserver'а.
// Источники (по приоритету): переменные окружения → файл конфига → значения по
// умолчанию. Здесь же живёт ГЛАВНЫЙ ТУМБЛЕР РЕГИСТРАЦИИ.
import { readFileSync, existsSync } from 'node:fs';

const TRUE = new Set(['1', 'true', 'yes', 'on', 'да']);
const FALSE = new Set(['0', 'false', 'no', 'off', 'нет']);

function asBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const s = String(v).toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return dflt;
}
// "443,80,8801" → [443,80,8801]; пусто/невалид → null (значит взять дефолт).
function parsePorts(v) {
  if (!v) return null;
  const list = String(v).split(/[,\s]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return list.length ? list : null;
}

export function loadConfig() {
  let file = {};
  const cfgPath = process.env.PRIZRAK_CONFIG;
  if (cfgPath && existsSync(cfgPath)) {
    try { file = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch (e) {
      console.error('Не удалось прочитать конфиг', cfgPath, e.message);
    }
  }

  const cfg = {
    domain: process.env.PRIZRAK_DOMAIN || file.domain || 'localhost',
    port: Number(process.env.PRIZRAK_PORT || file.port || 8801),
    // C1: список стабильных портов, которые сервер пытается слушать одновременно.
    // Занятые/недоступные (нет прав на 80/443/25 без root) пропускаются при старте.
    // Клиент сам находит рабочий порт (авто-скан), поэтому в адресе порт не нужен.
    ports: parsePorts(process.env.PRIZRAK_PORTS) || file.ports || [8801, 443, 80, 993, 995, 587, 465, 143, 110, 25],
    // C4: маскировка = НАСТОЯЩИЙ TLS. Если заданы cert/key, эти порты сервер слушает
    // по TLS (HTTPS/WSS) — трафик на 443 неотличим от обычного HTTPS-сайта.
    // Рекомендуется реальный сертификат (Let's Encrypt), тогда клиент проверит его штатно.
    tlsCert: process.env.PRIZRAK_TLS_CERT || file.tlsCert || null,
    tlsKey: process.env.PRIZRAK_TLS_KEY || file.tlsKey || null,
    tlsPorts: parsePorts(process.env.PRIZRAK_TLS_PORTS) || file.tlsPorts || [443, 993, 995, 465],
    storePath: process.env.PRIZRAK_STORE || file.storePath || null,
    // ⭐ Разрешена ли самостоятельная регистрация пользователей.
    registrationEnabled: asBool(process.env.PRIZRAK_REGISTRATION, file.registrationEnabled ?? true),
    // Необязательный секрет-приглашение: если задан, регистрация требует его
    // (полуоткрытый режим — регистрация «по коду»).
    registrationInviteCode: process.env.PRIZRAK_INVITE_CODE || file.registrationInviteCode || null,
    // Администраторы сервера. Ник ЛЮБОЙ (не обязательно root). Можно несколько — через запятую
    // (PRIZRAK_ADMIN=alice,bob) или списком в конфиге (admin:["alice","bob"]). Допустимы и полные
    // id вида user:domain. Кто-то из них при регистрации получает isAdmin; права можно и выдавать
    // на лету существующему пользователю (см. /admin/grant-admin). `admin` — первый (для совместимости).
    admins: (() => {
      const raw = process.env.PRIZRAK_ADMIN || file.admins || file.admin || '';
      const arr = Array.isArray(raw) ? raw : String(raw).split(',');
      return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
    })(),
    get admin() { return this.admins && this.admins.length ? this.admins[0] : null; },
    // Адрес stealth-relay для звонков (клиенты подключаются к нему исходящими,
    // без STUN). Если не задан — звонки требуют внешнего relay.
    relayUrl: process.env.PRIZRAK_RELAY || file.relayUrl || null,
    // Базовый сайт для ссылок-приглашений (страница-заглушка, ведёт в приложение).
    // Автомиграция: старый дефолт prizrak.paymoney.online, записанный в конфиг при init,
    // прозрачно подменяется на новый prizrak.im (кто задал СВОЙ адрес — не трогаем).
    inviteBase: (() => {
      const v = process.env.PRIZRAK_INVITE_BASE || file.inviteBase || 'https://prizrak.im';
      return v.replace(/\/+$/, '') === 'https://prizrak.paymoney.online' ? 'https://prizrak.im' : v;
    })(),
    // Приветственный баланс 👻 для новых аккаунтов.
    // По умолчанию 0: призраки — это покупная валюта Банка (prizrak.paymoney.online),
    // homeserver НЕ должен их «начислять» сам (иначе любой админ намайнит).
    welcomeGhosts: Number(process.env.PRIZRAK_WELCOME_GHOSTS ?? file.welcomeGhosts ?? 0),
    // ── Хранение истории ──────────────────────────────────────────────────
    // Глобальный МАКСИМАЛЬНЫЙ срок хранения (админ). Пользователь не может задать
    // больше. Значения: forever,1y,6mo,3mo,1mo,2w,1w,3d,1d.
    historyRetention: process.env.PRIZRAK_RETENTION || file.historyRetention || 'forever',
    // Пути хранения медиа (можно несколько — напр. разные диски).
    storagePaths: (() => {
      if (process.env.PRIZRAK_STORAGE_PATHS) return process.env.PRIZRAK_STORAGE_PATHS.split(',').map((s) => s.trim()).filter(Boolean);
      if (Array.isArray(file.storagePaths) && file.storagePaths.length) return file.storagePaths;
      return null; // сервер подставит ./data/media
    })(),
    // Общий лимит размера всех файлов (байт), чтобы не забить ФС на 100%.
    storageMaxBytes: Number(process.env.PRIZRAK_STORAGE_MAX ?? file.storageMaxBytes ?? 5 * 1024 * 1024 * 1024),
    resolver: (() => {
      try { return JSON.parse(process.env.PRIZRAK_RESOLVER || JSON.stringify(file.resolver || {})); }
      catch { return {}; }
    })(),
    // Сколько хранить НЕ доставленные на чужой сервер сообщения (store-and-forward),
    // прежде чем бросить (если сервер получателя так и не появился). Те же значения,
    // что и historyRetention: forever,1y,6mo,3mo,1mo,2w,1w,3d,1d.
    federationRetention: process.env.PRIZRAK_FED_RETENTION || file.federationRetention || '3d',
    // ── Сеть тайников (store-and-forward overlay, Фаза 3). Если пусто — выключено. ──
    // Список сид-узлов тайников (строка через запятую или массив в файле).
    deaddropNodes: (() => { const v = process.env.DD_NODES || file.deaddropNodes || ''; return Array.isArray(v) ? v.join(',') : v; })(),
    deaddropRF: Number(process.env.DD_RF || file.deaddropRF || 4),           // сколько копий (реплик)
    deaddropPollMs: Number(process.env.DD_POLL_MS || file.deaddropPollMs || 15000), // период опроса ящиков
    // Предраздача публичных ключей серверов-партнёров { "домен": {"ed":"…","x":"…"} } —
    // на случай, когда discovery недостижим (прямой путь заблокирован).
    deaddropKeys: (() => { try { return JSON.parse(process.env.DD_KEYS || JSON.stringify(file.deaddropKeys || {})); } catch { return {}; } })(),
    // Фаза 6b — мультиканальный ПОДПИСАННЫЙ бутстрап сидов. Не список узлов в конфиге, а
    // корень доверия (публичный ключ мейнтейнера) + КАНАЛЫ, откуда тянуть подписанный бандл:
    //   { "maintainerPub":"<64hex>",
    //     "doh":[{"name":"boot.example","url":"https://cloudflare-dns.com/dns-query"}],
    //     "https":[{"url":"https://cdn.example/prizrak-boot.json","host":"front.cdn"}],
    //     "baked": <подписанный бандл (объект) — вшитый резерв> }
    // Достаточно ОДНОГО живого канала: бандл подписан, подделать нельзя, дальше — PEX.
    deaddropBootstrap: (() => { try { return JSON.parse(process.env.DD_BOOTSTRAP || JSON.stringify(file.deaddropBootstrap || null)); } catch { return null; } })(),
    // Фаза 6c — приватные bridge-узлы. Массив «билетов-мостов» (подписанных записей узла,
    // как печатает приватный узел при старте) ЛИБО {relayId, endpoint}. Раздаются вне сети
    // доверенным серверам; в общий реестр не попадают, цензор их не выкачает. Чтобы placement
    // совпал, оба сотрудничающих сервера должны иметь ОДИН И ТОТ ЖЕ мост.
    deaddropBridges: (() => { try { const v = JSON.parse(process.env.DD_BRIDGES || JSON.stringify(file.deaddropBridges || [])); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    // Фаза 6 — admission-PoW при PUT на узлы (0 = выкл). Должно совпадать с политикой узлов сети.
    deaddropPowBits: Number(process.env.DD_POW_BITS || file.deaddropPowBits || 0),
    // Фаза 7 — отчёт о здоровье узлов в Банк Призраков для начисления наград операторам.
    // URL эндпоинта банка и общий токен (совпадает с nodes_report_token банка). Пусто → выкл.
    deaddropRewardsUrl: process.env.DD_REWARDS_URL || file.deaddropRewardsUrl || '',
    deaddropRewardsToken: process.env.DD_REWARDS_TOKEN || file.deaddropRewardsToken || '',
    deaddropRewardsMs: Number(process.env.DD_REWARDS_MS || file.deaddropRewardsMs || 300000), // период отчёта (5 мин)
    // ── Реестр поиска публичных групп (G5). Пустая строка = не публиковать. ──
    registryUrl: (process.env.PRIZRAK_REGISTRY ?? file.registryUrl ?? 'https://tech.prizrak.im').replace(/\/$/, ''),
    // ── 🤖 Bot API (packages/botapi) — аналог Telegram Bot API + PrizrakFather. ──
    // Поднимается ВНУТРИ homeserver'а (как relay). Включён по умолчанию при запуске
    // по конфигу; выключить: botapiEnabled:false или PRIZRAK_BOTAPI=off.
    botapiEnabled: asBool(process.env.PRIZRAK_BOTAPI, file.botapiEnabled ?? true),
    botapiPort: Number(process.env.PRIZRAK_BOTAPI_PORT || file.botapiPort || 8840),
    // Админ-токен (роль BotFather для HTTP-API). Пусто → сгенерируется и сохранится
    // в data/botapi-admin.token при первом старте.
    botapiAdminToken: process.env.PRIZRAK_BOTAPI_TOKEN || file.botapiAdminToken || null,
  };
  return cfg;
}
