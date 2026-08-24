#!/usr/bin/env bash
# release-server.sh — собрать ТОЛЬКО серверную часть Prizrak для разворачивания
# на отдельной машине (homeserver + relay для звонков). Без десктоп-клиента,
# без prizrak-bank (PHP) и без web-сайта. Версия берётся из VERSION.
# Запуск: bash scripts/release-server.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < VERSION)"
OUT_DIR="$ROOT/releases"
ZIP="$OUT_DIR/prizrak-server-${VERSION}.zip"

mkdir -p "$OUT_DIR"
rm -f "$ZIP" 2>/dev/null || true

STAGE="$(mktemp -d)"
DEST="$STAGE/prizrak-server-${VERSION}"
mkdir -p "$DEST/packages"

# Корневые файлы, нужные для npm install и запуска.
cp -R package.json package-lock.json VERSION README.md CHANGELOG.md \
      Dockerfile docker-compose.yml .gitignore \
      deploy scripts docs "$DEST/" 2>/dev/null || true

# Только серверные пакеты: homeserver, relay, stealth-транспорт (+сертификаты).
cp -R packages/server    "$DEST/packages/"
cp -R packages/relay     "$DEST/packages/"
cp -R packages/transport "$DEST/packages/"
cp -R packages/crypto    "$DEST/packages/" 2>/dev/null || true
cp -R packages/registry  "$DEST/packages/" 2>/dev/null || true  # реестр поиска групп (tech.prizrak.im)
cp -R packages/botapi    "$DEST/packages/" 2>/dev/null || true  # Bot API + PrizrakFather (порт 8840)
cp -R packages/client    "$DEST/packages/" 2>/dev/null || true  # нужен botapi (боты — E2E-клиенты)
cp -R packages/deaddrop  "$DEST/packages/" 2>/dev/null || true  # узлы-тайники (нужны тестам federation)

# Чистим лишнее из staged-копии.
find "$DEST" -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -type d -name data -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$DEST/releases" 2>/dev/null || true
# Десктоп-ориентированные скрипты серверу не нужны.
rm -f "$DEST/scripts/sync-desktop-lib.mjs" "$DEST/scripts/release.sh" "$DEST/scripts/release-server.sh" 2>/dev/null || true

( cd "$STAGE" && zip -r -q "$ZIP" "prizrak-server-${VERSION}" )
rm -rf "$STAGE"

echo "✅ Собран серверный релиз: releases/prizrak-server-${VERSION}.zip"
ls -la "$ZIP"
