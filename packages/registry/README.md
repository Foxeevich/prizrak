# Prizrak Group Registry — реестр публичных групп (tech.prizrak.im)

Поиск по публичным группам и каналам федерации: пользователь вводит «Рыбал» —
и видит все публичные группы, в названии или описании которых есть это слово.

- Homeserver'ы **сами** публикуют сюда подписанные (Ed25519) записи своих
  **публичных** комнат и переподтверждают их каждые 6 часов.
- **Приватные группы никогда не попадают в реестр** — публичность включает
  владелец группы в её настройках («Тип группы → Публичная»).
- Записи без переподтверждения умирают через 7 дней (TTL). Подпись проверяется,
  ключ домена фиксируется по TOFU + сверяется с `/.well-known/prizrak/server`.
- Анти-спам: лимит запросов по IP, максимум 200 групп на домен.

## Запуск (тот же сервер, что prizrak.im)

```bash
cd prizrak/packages/registry
npm install --omit=dev
REGISTRY_PORT=8830 REGISTRY_DB=/opt/prizrak/data/registry.sqlite node src/index.js
```

### systemd (автозапуск)

`/etc/systemd/system/prizrak-registry.service`:

```ini
[Unit]
Description=Prizrak Group Registry
After=network-online.target

[Service]
User=prizrak
WorkingDirectory=/opt/prizrak/packages/registry
Environment=REGISTRY_PORT=8830
Environment=REGISTRY_DB=/opt/prizrak/data/registry.sqlite
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now prizrak-registry
```

### Caddy (HTTPS на tech.prizrak.im)

Добавьте в Caddyfile:

```
tech.prizrak.im {
    reverse_proxy 127.0.0.1:8830
}
```

`systemctl reload caddy` — сертификат выпустится сам.

## Как это включается на homeserver'ах

В конфиге homeserver'а (`prizrak.config.json`) поле `registryUrl`
(по умолчанию `https://tech.prizrak.im`). Пустая строка — сервер ничего
не публикует и поиск отключён.

Клиенты ищут через СВОЙ homeserver (`/_prizrak/client/v1/groups/search`),
поэтому поиск работает и там, где сам реестр заблокирован (стелс-транспорт).

## API

- `GET /api/search?q=рыбал&limit=30` → `{results:[{roomId,domain,name,description,members,type,updatedAt}]}`
- `POST /api/publish` — `{record:{roomId,domain,name,description,members,type,updatedAt,ed,del:false},sig}`
- `POST /api/unpublish` — то же с `del:true`
- `GET /api/stats` → `{groups,domains}`
