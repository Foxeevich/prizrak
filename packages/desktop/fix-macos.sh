#!/usr/bin/env bash
# fix-macos.sh — если macOS ругается на «вредоносное ПО» на уже установленном
# приложении Prizrak. Снимает карантин и накладывает локальную ad-hoc-подпись.
#
# Использование:
#   bash fix-macos.sh                       # ищет /Applications/Prizrak.app
#   bash fix-macos.sh /путь/к/Prizrak.app   # явный путь
set -euo pipefail
APP="${1:-/Applications/Prizrak.app}"
[ -d "$APP" ] || { echo "Не найдено: $APP (сначала достаньте приложение из Корзины)"; exit 1; }
echo "▶ Снимаю карантин и подписываю ad-hoc: $APP"
xattr -cr "$APP" || true
codesign --force --deep --sign - "$APP"
echo "✅ Готово. Откройте приложение: open \"$APP\""
