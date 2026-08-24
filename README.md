<p align="center">
  <img src="ghost-250.svg" alt="Prizrak" width="120"/>
</p>

<h1 align="center">Prizrak — Призрак</h1>

<p align="center">
  <b>Censorship-resistant, end-to-end encrypted messenger with an integrated VPN, server federation, a hidden-node relay network, voice/video calls and a Bot API.</b><br/>
  <i>Устойчивый к блокировкам E2E-мессенджер со встроенным VPN, федерацией серверов, сетью узлов-тайников, звонками и Bot API.</i>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL v3" src="https://img.shields.io/badge/License-AGPL_v3-blue.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/Node.js-18%2B-3c873a.svg">
  <img alt="Platforms" src="https://img.shields.io/badge/clients-Desktop%20%C2%B7%20Android%20%C2%B7%20iOS-8957e5.svg">
</p>

---

# 🇬🇧 English

## What is this

**Prizrak** ("ghost") is a decentralized, end-to-end encrypted messenger built to keep working under network pressure and censorship. There is no central server and no phone number: anyone can run their own **homeserver** on their own domain and instantly federate with everyone else, the way email does.

Every message is a sealed envelope — servers store and forward ciphertext and never see content. When a direct link between servers is cut, envelopes automatically detour through a network of **hidden nodes** (тайники). Clients ship with an integrated **VPN** that looks like ordinary HTTPS traffic.

> ⚠️ This is the **client & infrastructure** source (server, hidden node, mobile & desktop apps). The payment backend ("Ghost Bank") and the marketing website are **not** part of this repository.

## Features

- 🔐 **End-to-end encryption** for direct chats, group chats and channels (X25519 / Ed25519 / modern AEAD, via `@noble/*` and OpenPGP).
- 🌐 **Server federation** — your users talk to users of any other Prizrak server; discovery by standard ports, no mandatory central resolver.
- 🕳️ **Hidden-node network** (тайники) — encrypted intermediate vaults that route around blocks; the operator can't read what passes through.
- 🛡️ **Integrated VPN** — traffic wrapped in a stealth transport, indistinguishable from normal HTTPS.
- 📞 **Voice & video calls**, voice messages and video notes, relayed server-to-server.
- 👻 **Ghost economy** — reactions, tips/donations and rewards for running nodes.
- 🤖 **Bot API** — three familiar HTTP methods (Telegram-style), built into every homeserver.
- 📱 **Multi-device** — one account on several devices, with fan-out and read-sync.
- ♻️ **Resistance to blocking** — multi-port listening, TLS masquerade, signed bootstrap, on-disk caches.

## Repository layout

```
packages/
  server     — homeserver (federation, delivery, storage of sealed envelopes)
  deaddrop   — hidden node ("тайник") — encrypted relay/vault
  desktop    — Electron client (macOS / Windows / Linux), bundles the VPN engine
  mobile     — React Native client (Android / iOS)
  vpn        — VPN engine (stealth transport, local proxy) used by clients
  crypto     — cryptographic core (keys, sessions, sealing)
  client     — shared client logic (chats, calls, link previews)
  transport  — stealth/Reality-style transport layer
  relay      — call relay / rendezvous
  registry   — node/server directory & discovery
  botapi     — Bot API surface
deploy/      — server deploy script, Caddyfile & setup guide
docs/        — ARCHITECTURE.md, VPN-DESIGN.md, GHOST-BANK.md
scripts/     — build/sync/admin helpers
demo/        — end-to-end feature tests (node demo/*.js)
```

## Requirements

- **Node.js 18+** (server, node, desktop, mobile build tooling).
- Desktop builds: `electron` + `electron-builder` (installed as devDependencies).
- Mobile builds: React Native toolchain (Android SDK / Xcode).

## Install & run

### Homeserver

```bash
cd packages/server
npm install
# initialize (domain is any name both sides resolve the same way):
./deploy/prizrak-deploy.sh init --domain chat.example.org --admin root --registration on \
    --relay-url stealth://<YOUR-PUBLIC-IP>:8810
./deploy/prizrak-deploy.sh create-admin --password 'STRONG_PASSWORD'
./deploy/prizrak-deploy.sh start
```

Copy `prizrak.config.example.json` → `prizrak.config.json` and edit it for your domain. See **[deploy/SERVER-SETUP.md](deploy/SERVER-SETUP.md)** for federation, calls between servers and TLS. Default ports: homeserver `8801`, call relay `8810`.

### Hidden node (тайник)

```bash
cd packages/deaddrop
npm install
node src/node.js
# operator status: http://127.0.0.1:8820/status
# optional: join via a known seed node
DD_SEEDS=https://seed.example:8820 node src/node.js
```

### Desktop client (Electron)

```bash
cd packages/desktop
npm install
npm start                 # run in dev
npm run dist:mac          # build installer (or dist:win / dist:linux / dist:all)
```

### Mobile client (React Native)

```bash
cd packages/mobile
npm install
npm run sync              # sync shared crypto/client into src/lib
npm run android           # or: npm run ios
npm run build:apk         # release APK (needs your own signing keystore)
```

> 🔑 **Android signing** is not published. Create your own keystore and fill `PRIZRAK_STORE_PASSWORD` / `PRIZRAK_KEY_PASSWORD` in `packages/mobile/android/gradle.properties` (currently `CHANGE_ME`).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system architecture
- [docs/VPN-DESIGN.md](docs/VPN-DESIGN.md) — VPN design
- [docs/GHOST-BANK.md](docs/GHOST-BANK.md) — ghost economy (design; the bank backend is not in this repo)
- [CHANGELOG.md](CHANGELOG.md) — change history

## Security

- Servers see only **sealed envelopes**; content is unreadable to operators.
- **Not included in this repository** (by design): the auto-update **private signing key**, server config with secrets (`prizrak.config.json`), Android release **keystore** & passwords, TLS certificates, user data (`data/`), and the payment backend. Only the update **public** key ships in the clients so they can verify signed updates.
- Please report vulnerabilities privately to the maintainer rather than opening a public issue.

## Contributing & changelog

Pull requests welcome. Notable changes are tracked in [CHANGELOG.md](CHANGELOG.md) and, going forward, in GitHub Releases.

## License

**GNU Affero General Public License v3.0** — see [LICENSE](LICENSE). If you run a modified version as a network service, you must offer your users its source code.

---

# 🇷🇺 Русский

## Что это

**Prizrak** («Призрак») — децентрализованный E2E-мессенджер, спроектированный так, чтобы продолжать работать под давлением сети и блокировками. Ни центрального сервера, ни номера телефона: любой может поднять свой **homeserver** на своём домене и сразу федерироваться со всеми остальными — как электронная почта.

Каждое сообщение — запечатанный конверт: серверы хранят и пересылают только шифртекст и не видят содержимого. Когда прямую связь между серверами режут, конверты автоматически идут в обход через сеть **узлов-тайников**. В клиенты встроен **VPN**, который выглядит как обычный HTTPS-трафик.

> ⚠️ Здесь — исходники **клиентов и инфраструктуры** (сервер, узел-тайник, мобильное и десктоп-приложения). Платёжный бэкенд («Банк Призраков») и сайт-визитка в этот репозиторий **не входят**.

## Возможности

- 🔐 **Сквозное шифрование** личных чатов, групп и каналов (X25519 / Ed25519 / современный AEAD, `@noble/*` и OpenPGP).
- 🌐 **Федерация серверов** — ваши пользователи общаются с пользователями любого другого сервера Prizrak; обнаружение по стандартным портам, без обязательного центрального resolver'а.
- 🕳️ **Сеть узлов-тайников** — зашифрованные промежуточные хранилища для обхода блокировок; оператор не видит содержимого.
- 🛡️ **Встроенный VPN** — трафик завёрнут в стелс-транспорт, неотличим от обычного HTTPS.
- 📞 **Аудио- и видеозвонки**, голосовые сообщения и видео-кружочки, relay между серверами.
- 👻 **Экономика призраков** — реакции, донаты и награды за поднятые узлы.
- 🤖 **Bot API** — три знакомых HTTP-метода (как в Telegram), встроены в каждый homeserver.
- 📱 **Мультидевайс** — один аккаунт на нескольких устройствах, fan-out и синхронизация прочтения.
- ♻️ **Устойчивость к блокировкам** — мультипорт, TLS-маскировка, подписанный бутстрап, кэши на диске.

## Структура репозитория

```
packages/
  server     — homeserver (федерация, доставка, хранение запечатанных конвертов)
  deaddrop   — узел-тайник — зашифрованный relay/хранилище
  desktop    — Electron-клиент (macOS / Windows / Linux), встраивает VPN-движок
  mobile     — React Native клиент (Android / iOS)
  vpn        — VPN-движок (стелс-транспорт, локальный прокси) для клиентов
  crypto     — криптоядро (ключи, сессии, запечатывание)
  client     — общая клиентская логика (чаты, звонки, превью ссылок)
  transport  — стелс/Reality-транспорт
  relay      — relay/rendezvous для звонков
  registry   — каталог и обнаружение узлов/серверов
  botapi     — поверхность Bot API
deploy/      — скрипт разворачивания сервера, Caddyfile и гайд
docs/        — ARCHITECTURE.md, VPN-DESIGN.md, GHOST-BANK.md
scripts/     — вспомогательные скрипты сборки/синхронизации/админки
demo/        — сквозные тесты фич (node demo/*.js)
```

## Требования

- **Node.js 18+** (сервер, узел, тулинг сборки десктопа и мобилки).
- Десктоп: `electron` + `electron-builder` (в devDependencies).
- Мобилка: тулчейн React Native (Android SDK / Xcode).

## Установка и запуск

### Homeserver (сервер)

```bash
cd packages/server
npm install
# инициализация (домен — любое имя, лишь бы обе стороны резолвили одинаково):
./deploy/prizrak-deploy.sh init --domain chat.example.org --admin root --registration on \
    --relay-url stealth://<ВАШ-ПУБЛИЧНЫЙ-IP>:8810
./deploy/prizrak-deploy.sh create-admin --password 'СИЛЬНЫЙ_ПАРОЛЬ'
./deploy/prizrak-deploy.sh start
```

Скопируйте `prizrak.config.example.json` → `prizrak.config.json` и отредактируйте под свой домен. Про федерацию, звонки между серверами и TLS — в **[deploy/SERVER-SETUP.md](deploy/SERVER-SETUP.md)**. Порты по умолчанию: homeserver `8801`, relay звонков `8810`.

### Узел-тайник (deaddrop)

```bash
cd packages/deaddrop
npm install
node src/node.js
# статус оператора: http://127.0.0.1:8820/status
# по желанию — подключиться через известный сид-узел:
DD_SEEDS=https://seed.example:8820 node src/node.js
```

### Десктоп-клиент (Electron)

```bash
cd packages/desktop
npm install
npm start                 # запуск в dev-режиме
npm run dist:mac          # собрать инсталлятор (или dist:win / dist:linux / dist:all)
```

### Мобильный клиент (React Native)

```bash
cd packages/mobile
npm install
npm run sync              # синхронизировать общий crypto/client в src/lib
npm run android           # или: npm run ios
npm run build:apk         # релизный APK (нужен ваш собственный keystore подписи)
```

> 🔑 **Подпись Android** не публикуется. Создайте свой keystore и впишите `PRIZRAK_STORE_PASSWORD` / `PRIZRAK_KEY_PASSWORD` в `packages/mobile/android/gradle.properties` (сейчас там `CHANGE_ME`).

## Документация

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — архитектура системы
- [docs/VPN-DESIGN.md](docs/VPN-DESIGN.md) — дизайн VPN
- [docs/GHOST-BANK.md](docs/GHOST-BANK.md) — экономика призраков (дизайн; бэкенд банка в репозиторий не входит)
- [CHANGELOG.md](CHANGELOG.md) — история изменений

## Безопасность

- Серверы видят только **запечатанные конверты**; содержимое недоступно операторам.
- **Намеренно НЕ входит в репозиторий**: приватный **ключ подписи** обновлений, конфиг сервера с секретами (`prizrak.config.json`), релизный **keystore** Android и пароли, TLS-сертификаты, данные пользователей (`data/`) и платёжный бэкенд. В клиентах есть только **публичный** ключ обновлений — для проверки подписи.
- О уязвимостях сообщайте, пожалуйста, приватно мейнтейнеру, а не в публичных issue.

## Вклад и changelog

Pull request'ы приветствуются. Значимые изменения фиксируются в [CHANGELOG.md](CHANGELOG.md) и, далее, в GitHub Releases.

## Лицензия

**GNU Affero General Public License v3.0** — см. [LICENSE](LICENSE). Если вы запускаете изменённую версию как сетевой сервис, вы обязаны предоставить пользователям её исходный код.
