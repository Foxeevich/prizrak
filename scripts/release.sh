#!/usr/bin/env bash
# release.sh — собрать версионированный архив релиза в ./releases/.
# Версия берётся из файла VERSION. Архив НЕ включает node_modules, data и сам
# каталог releases. Запуск: bash scripts/release.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < VERSION)"
OUT_DIR="$ROOT/releases"
ZIP="$OUT_DIR/prizrak-${VERSION}.zip"

mkdir -p "$OUT_DIR"
# На смонтированных папках (напр. Cowork device-bridge) rm может быть запрещён —
# не падаем, просто пробуем убрать старый архив.
rm -f "$ZIP" 2>/dev/null || true

# Собираем архив с префиксом prizrak-<version>/ внутри.
STAGE="$(mktemp -d)"
DEST="$STAGE/prizrak-${VERSION}"
mkdir -p "$DEST"

# Копируем всё, кроме исключённого.
cp -R \
  package.json package-lock.json README.md CHANGELOG.md VERSION \
  Dockerfile docker-compose.yml .gitignore \
  packages demo docs scripts deploy web prizrak-bank \
  "$DEST/" 2>/dev/null || true

# Чистим мусор внутри staged-копии.
find "$DEST" -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -type d -name data -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$DEST/releases" 2>/dev/null || true

( cd "$STAGE" && zip -r -q "$ZIP" "prizrak-${VERSION}" )
rm -rf "$STAGE"

echo "✅ Собран релиз: releases/prizrak-${VERSION}.zip"
ls -la "$ZIP"
