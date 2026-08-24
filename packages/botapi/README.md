# Prizrak Bot API

Упрощённый аналог **Telegram Bot API** — свой экземпляр на каждом homeserver'е.
Бот — это настоящий аккаунт Призрака (E2E-участник): его ключи живут на вашем
сервере, рядом с botapi. Сторонний разработчик получает токен и работает по HTTP,
как с Telegram.

## Запуск (на сервере, рядом с homeserver'ом)

```bash
cd /opt/prizrak/packages/botapi
BOTAPI_ADMIN_TOKEN='супер-секрет' \
BOTAPI_DOMAIN='prizrak.webcluster.org' \
node src/index.js
# [botapi] Prizrak Bot API слушает :8840
```

Требуется Node ≥ 22.5 (node:sqlite). Наружу порт можно отдать через Caddy/nginx.

## Создать бота: 👻 PrizrakFather (как BotFather)

При первом старте сервис сам регистрирует служебного бота `prizrakfather:<домен>`.
Любой пользователь открывает с ним чат и пишет `/newbot` → имя → логин → получает токен.
Ещё команды: `/mybots`, `/revoke <login>` (новый токен), `/deletebot <login>`.

Публичная документация для разработчиков: `web/api.html` (https://prizrak.paymoney.online/api.html).

## Создать бота через админ-API (альтернатива)

```bash
curl -s -X POST http://127.0.0.1:8840/admin/createBot \
  -H 'X-Admin-Token: супер-секрет' \
  -d '{"login":"weatherbot","name":"Погодный бот"}'
# → {"ok":true,"result":{"id":1,"username":"weatherbot",
#     "user_id":"weatherbot:prizrak.webcluster.org","token":"1:ab12…"}}
```

Токен показывается один раз — сохраните. Ещё: `GET /admin/bots`, `POST /admin/deleteBot {"id":1}`.

## Работа с ботом (как в Telegram)

Конверт ответов тот же: `{"ok":true,"result":…}` или `{"ok":false,"error_code":…,"description":…}`.

```bash
BASE='http://127.0.0.1:8840/bot1:ab12…'

curl -s $BASE/getMe
# {"ok":true,"result":{"id":1,"is_bot":true,"username":"weatherbot",…}}

# Написать пользователю (chat_id = ник:домен) или в группу (chat_id = !roomid:домен)
curl -s -X POST $BASE/sendMessage -d '{"chat_id":"root:prizrak.webcluster.org","text":"Привет! ☀️"}'

# Получать входящие (long-poll до 30 с, подтверждение через offset — как у Telegram)
curl -s "$BASE/getUpdates?timeout=25&offset=0"
# {"ok":true,"result":[{"update_id":1,"message":{"message_id":"…",
#   "from":{"id":"root:prizrak.webcluster.org","username":"root","is_bot":false},
#   "chat":{"id":"root:prizrak.webcluster.org","type":"private"},
#   "date":1766400000,"text":"привет, бот"}}]}
```

Цикл бота: `getUpdates(offset=последний update_id+1, timeout=25)` → обработать → `sendMessage` → повторить.

## Что внутри / ограничения v0.1

* Методы: `getMe`, `sendMessage` (текст), `getUpdates` (long-poll). Вложения приходят
  как `message.document` (метаданные, без байтов). Webhook, файлы, клавиатуры — позже.
* Чтобы человек мог написать боту первым, он просто открывает чат с `логин_бота:домен`.
* Состояние E2E-сессий ботов сохраняется в SQLite после каждого сообщения (троттлинг 300 мс).
