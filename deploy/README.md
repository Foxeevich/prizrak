# Развёртывание Prizrak на своём домене

Любой администратор поднимает собственный homeserver и сам решает: **разрешить**
регистрацию пользователей или **запретить** её.

## Быстрый старт

```bash
# 1. Инициализация конфига (регистрация ОТКРЫТА)
./deploy/prizrak-deploy.sh init --domain chat.example.org --admin root --registration on

# 2. Создать администратора со своим паролем (и зарезервировать имя root)
./deploy/prizrak-deploy.sh create-admin --password 'ВашСильныйПароль'

# 3. Запуск сервера (окно остаётся открытым — процесс в переднем плане)
./deploy/prizrak-deploy.sh start

# 4. Проверить, что сервер отвечает (в другом окне)
./deploy/prizrak-deploy.sh ping        # → ✅ Сервер отвечает: {"ok":true,...}

# 5. (для звонков) запустить stealth-relay и указать его в конфиге
PRIZRAK_RELAY_PORT=8810 ./deploy/prizrak-deploy.sh relay      # в отдельном окне
#   затем в init добавьте:  --relay-url stealth://ВАШ_ДОМЕН:8810

# 6. TLS и домен — через reverse-proxy
caddy run --config deploy/Caddyfile.example
```

### Звонки (relay без STUN)

Звонки идут не через STUN, а через **stealth-relay**: оба собеседника
подключаются к нему исходящими соединениями (обход NAT без пробивания портов,
для DPI — обычный HTTPS). Медиа шифруется E2E ключом звонка — relay видит только
шифртекст. Запустите relay командой `./deploy/prizrak-deploy.sh relay` и пропишите
его адрес в конфиг: `--relay-url stealth://ВАШ_ДОМЕН:8810` (или поле `relayUrl`).
Клиент узнаёт адрес relay из `/config` и подключается сам.

Готово: пользователи заходят в десктоп-клиент, указывают `https://chat.example.org`
(для локального теста — `http://127.0.0.1:8801`) и регистрируются как
`имя:chat.example.org`. Админ входит под `root:chat.example.org` с заданным
паролем — ключи опубликуются при первом входе.

### Как понять, что сервер запущен

- Команда `start` печатает строку `[homeserver …] слушает :8801 (все интерфейсы)`
  и **остаётся работать** — это и есть признак, что сервер поднят. Не закрывайте окно.
- Быстрая проверка из другого окна: `./deploy/prizrak-deploy.sh ping` или
  `curl http://127.0.0.1:8801/health` → `{"ok":true,"domain":"…"}`.

### Провижининг админа без открытой регистрации

Можно закрыть саморегистрацию и всё равно иметь админа:

```bash
./deploy/prizrak-deploy.sh init --domain chat.example.org --admin root --registration off
./deploy/prizrak-deploy.sh create-admin --password 'ВашСильныйПароль'
./deploy/prizrak-deploy.sh start
```

## Управление регистрацией

```bash
./deploy/prizrak-deploy.sh disable-registration   # закрыть регистрацию
./deploy/prizrak-deploy.sh enable-registration    # открыть снова
./deploy/prizrak-deploy.sh status                 # показать текущий режим
```

Полузакрытый режим — регистрация только по коду:

```bash
./deploy/prizrak-deploy.sh init --domain chat.example.org --admin root \
    --registration on --invite-code SECRET2026
```

После смены режима перезапустите сервер (конфиг читается при старте).

## Через Docker

Можно поднять и в контейнере (см. корневые `Dockerfile` и `docker-compose.yml`).
Тумблер регистрации задаётся переменной окружения:

```bash
PRIZRAK_DOMAIN=chat.example.org PRIZRAK_REGISTRATION=off \
PRIZRAK_ADMIN=root docker compose up --build
```

## Переменные окружения (альтернатива конфигу)

| Переменная | Назначение | По умолчанию |
|-----------|-----------|--------------|
| `PRIZRAK_DOMAIN` | домен сервера | `localhost` |
| `PRIZRAK_PORT` | порт | `8801` |
| `PRIZRAK_REGISTRATION` | `on`/`off` — тумблер регистрации | `on` |
| `PRIZRAK_INVITE_CODE` | код для полузакрытой регистрации | — |
| `PRIZRAK_ADMIN` | localpart первого администратора | — |
| `PRIZRAK_STORE` | путь к файлу хранилища | — |
| `PRIZRAK_CONFIG` | путь к JSON-конфигу | — |

## Что видит и чего не видит сервер

Сервер маршрутизирует **зашифрованные конверты** и хранит метаданные (кто, кому,
когда, состав комнат). Содержимое переписки ему недоступно — ключей у него нет,
всё шифрование E2E происходит в клиентах. Подробности и модель угроз — в
`docs/ARCHITECTURE.md`.
