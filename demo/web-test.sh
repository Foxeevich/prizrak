#!/usr/bin/env bash
# Поднимает PHP-бэкенд prizrak-bank во временной БД и прогоняет demo/web-test.mjs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$(mktemp -u).sqlite"
PORT="${PORT:-8788}"
cd "$ROOT/prizrak-bank"
PRIZRAK_DEV=1 PM_API_SECRET=test_api_secret PRIZRAK_DB="$DB" php -S 127.0.0.1:"$PORT" index.php >/tmp/prizrak-php.log 2>&1 &
PHP=$!
sleep 1
set +e
WEB_BASE="http://127.0.0.1:$PORT" PM_API_SECRET=test_api_secret node "$ROOT/demo/web-test.mjs"
CODE=$?
set -e
kill $PHP 2>/dev/null || true
rm -f "$DB" "$DB"-wal "$DB"-shm
exit $CODE
