#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# prizrak-deploy.sh — развёртывание homeserver'а Prizrak на своём домене.
# Любой админ поднимает свой сервер и решает: РАЗРЕШИТЬ регистрацию или ЗАПРЕТИТЬ.
#
# Использование:
#   ./prizrak-deploy.sh init --domain chat.example.org --admin root [--port 8801]
#                            [--registration on|off] [--invite-code CODE]
#   ./prizrak-deploy.sh create-admin --password 'ВашПароль'   # создать админа
#   ./prizrak-deploy.sh start                 # запустить сервер
#   ./prizrak-deploy.sh relay                 # запустить stealth-relay (звонки)
#   ./prizrak-deploy.sh ping                  # проверить, что сервер отвечает
#   ./prizrak-deploy.sh enable-registration   # включить регистрацию
#   ./prizrak-deploy.sh disable-registration  # выключить регистрацию
#   ./prizrak-deploy.sh status                # показать конфиг (в т.ч. хранилище)
#   ── Медиа-хранилище (правит конфиг; размер В ГИГАБАЙТАХ) ──
#   ./prizrak-deploy.sh storage-add /opt/prizrak/storage   # добавить путь
#   ./prizrak-deploy.sh storage-remove /opt/prizrak/storage# убрать путь
#   ./prizrak-deploy.sh storage-max 350                    # лимит = 350 ГБ
#   ./prizrak-deploy.sh storage-list                       # показать хранилище
#   ── Федерация (если серверы на http без TLS) ──
#   ./prizrak-deploy.sh resolver-add <домен> http://IP:8801# куда ходить за доменом
#   ./prizrak-deploy.sh resolver-remove <домен>            # убрать запись
#
# Конфиг пишется в ./prizrak.config.json, данные — в ./data/store.json.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${PRIZRAK_CONFIG:-$ROOT/prizrak.config.json}"
SERVER="$ROOT/packages/server/src/server.js"

die() { echo "Ошибка: $*" >&2; exit 1; }
have_node() { command -v node >/dev/null 2>&1 || die "нужен Node.js 18+"; }

# Мини-редактор JSON через node (без внешних зависимостей).
json_set() { # json_set <file> <key> <value-as-json>
  node -e '
    const fs=require("fs");const [f,k,v]=process.argv.slice(1);
    const o=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};
    o[k]=JSON.parse(v);fs.writeFileSync(f,JSON.stringify(o,null,2));
  ' "$1" "$2" "$3"
}

cmd_init() {
  local domain="" port="8801" admin="" registration="on" invite="null" store="$ROOT/data/store.json" relay="null"
  local retention="forever" storagePaths="null" storageMax="null" inviteBase="https://prizrak.im"
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) domain="$2"; shift 2;;
      --port) port="$2"; shift 2;;
      --admin) admin="$2"; shift 2;;
      --registration) registration="$2"; shift 2;;
      --invite-code) invite="\"$2\""; shift 2;;
      --invite-base) inviteBase="$2"; shift 2;;
      --relay-url) relay="\"$2\""; shift 2;;
      --retention) retention="$2"; shift 2;;
      --storage-path) storagePaths="[\"$2\"]"; shift 2;;
      --storage-max-gb) storageMax="$(( $2 * 1024 * 1024 * 1024 ))"; shift 2;;
      --store) store="$2"; shift 2;;
      *) die "неизвестный флаг $1";;
    esac
  done
  [ -n "$domain" ] || die "укажите --domain"
  [ -n "$admin" ] || die "укажите --admin (localpart первого администратора)"
  local reg_bool="true"; [ "$registration" = "off" ] && reg_bool="false"

  mkdir -p "$(dirname "$store")"
  cat > "$CONFIG" <<EOF
{
  "domain": "$domain",
  "port": $port,
  "storePath": "$store",
  "registrationEnabled": $reg_bool,
  "registrationInviteCode": $invite,
  "admin": "$admin",
  "relayUrl": $relay,
  "historyRetention": "$retention",
  "storagePaths": $storagePaths,
  "storageMaxBytes": $storageMax,
  "inviteBase": "$inviteBase"
}
EOF
  echo "✅ Конфиг создан: $CONFIG"
  cmd_status
  echo
  echo "Запуск:   $0 start"
  echo "TLS/домен: поставьте reverse-proxy (см. deploy/Caddyfile.example)."
}

cmd_start() {
  have_node
  [ -f "$CONFIG" ] || die "нет конфига, сначала: $0 init ..."
  # Прописываем relayUrl в конфиг (порт 8810 по умолчанию). Сам relay поднимает
  # homeserver ВНУТРИ своего процесса — отдельный процесс не нужен.
  if [ "${PRIZRAK_NO_RELAY:-}" != "1" ]; then
    local domain relayPort
    domain="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).domain)' "$CONFIG")"
    relayPort="${PRIZRAK_RELAY_PORT:-8810}"
    json_set "$CONFIG" relayUrl "\"stealth://$domain:$relayPort\""
    echo "▶ relay для звонков будет поднят внутри сервера на :$relayPort (relayUrl=stealth://$domain:$relayPort)"
    echo "  ⚠ Порт $relayPort (TCP) должен быть доступен клиентам (откройте его в firewall/проксe)."
    local rzPort="${PRIZRAK_RENDEZVOUS_PORT:-8811}"
    echo "▶ Prizrak Rendezvous (наш STUN) для прямого P2P звонков — UDP :$rzPort (авто-старт)."
    echo "  ⚠ Откройте UDP $rzPort в firewall, иначе прямой путь между разными сетями не соберётся"
    echo "    (звонки всё равно работают через relay). Напр.: sudo ufw allow $rzPort/udp"
  fi
  echo "▶ Запуск homeserver'а по конфигу $CONFIG"
  PRIZRAK_CONFIG="$CONFIG" exec node "$SERVER"
}

cmd_relay() {
  have_node
  local port="${PRIZRAK_RELAY_PORT:-8810}"
  echo "▶ Запуск stealth-relay для звонков на порту $port (psk: PRIZRAK_RELAY_PSK)"
  echo "  Не забудьте прописать в конфиге relayUrl, напр.: stealth://ВАШ_ДОМЕН:$port"
  PRIZRAK_RELAY_PORT="$port" exec node "$ROOT/packages/relay/src/relay.js"
}

cmd_create_admin() {
  have_node
  [ -f "$CONFIG" ] || die "нет конфига, сначала: $0 init ..."
  local password="" name="" promote=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --password) password="$2"; shift 2;;
      --name) name="$2"; shift 2;;          # ЛЮБОЙ ник администратора (не обязательно root)
      --promote) promote="--promote"; shift;; # выдать права уже существующему аккаунту
      *) die "неизвестный флаг $1";;
    esac
  done
  local nameArg=""; [ -n "$name" ] && nameArg="--name $name"
  local pwArg="";   [ -n "$password" ] && pwArg="--password $password"
  [ -n "$password$promote" ] || die "укажите --password 'ВашПароль' (для нового) или --promote (для существующего)"
  PRIZRAK_CONFIG="$CONFIG" node "$ROOT/scripts/create-admin.mjs" $nameArg $pwArg $promote
}

cmd_ping() {
  have_node
  [ -f "$CONFIG" ] || die "нет конфига"
  local port; port="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port)' "$CONFIG")"
  local url="http://127.0.0.1:${port}/health"
  echo "▶ Проверяю $url"
  if command -v curl >/dev/null 2>&1; then
    local out; out="$(curl -fsS --max-time 3 "$url" 2>/dev/null || true)"
    if [ -n "$out" ]; then echo "✅ Сервер отвечает: $out"; else echo "❌ Сервер не отвечает — запущен ли он ($0 start)?"; exit 1; fi
  else
    node -e 'fetch(process.argv[1]).then(r=>r.json()).then(j=>{console.log("✅ Сервер отвечает:",JSON.stringify(j))}).catch(()=>{console.log("❌ Сервер не отвечает — запущен ли он?");process.exit(1)})' "$url"
  fi
}

cmd_toggle() { # cmd_toggle true|false
  [ -f "$CONFIG" ] || die "нет конфига, сначала: $0 init ..."
  json_set "$CONFIG" registrationEnabled "$1"
  echo "✅ registrationEnabled = $1  (перезапустите сервер, чтобы применить)"
}

cmd_status() {
  [ -f "$CONFIG" ] || die "нет конфига"
  echo "── Текущий конфиг ($CONFIG) ──"
  node -e '
    const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    console.log("  домен:        "+o.domain);
    console.log("  порт:         "+o.port);
    console.log("  регистрация:  "+(o.registrationEnabled?"ОТКРЫТА":"ЗАКРЫТА"));
    console.log("  инвайт-код:   "+(o.registrationInviteCode?"да":"нет"));
    console.log("  админ:        "+(o.admin||"—"));
    console.log("  БД (store):   "+o.storePath);
    const paths=o.storagePaths||["(по умолчанию) ./data/media"];
    const max=o.storageMaxBytes||5*1024*1024*1024;
    console.log("  медиа-лимит:  "+(max/1073741824).toFixed(2)+" ГБ");
    console.log("  медиа-пути:   "+paths.join(", "));
    const r=o.resolver||{}; const ks=Object.keys(r);
    console.log("  федерация:    "+(ks.length?ks.map(k=>k+" → "+r[k]).join("; "):"(нет; чужие домены по https://<домен>)"));
    console.log("  хранить недост.: "+(o.federationRetention||"3d")+" (потом недоставленное на чужой сервер бросается)");
  ' "$CONFIG"
}

# ── Управление медиа-хранилищем (правит конфиг; размер — в ГИГАБАЙТАХ) ────────
cmd_storage_add() {
  [ -f "$CONFIG" ] || die "нет конфига, сначала: $0 init ..."
  local path="${1:-}"; [ -n "$path" ] || die "укажите путь: $0 storage-add /opt/prizrak/storage"
  mkdir -p "$path" || die "не удалось создать $path"
  node -e '
    const fs=require("fs");const [f,p]=process.argv.slice(1);
    const o=JSON.parse(fs.readFileSync(f,"utf8"));
    const a=Array.isArray(o.storagePaths)?o.storagePaths.slice():[];
    if(a.includes(p)){console.log("⚠ путь уже есть:",p);} else {a.push(p);console.log("✅ путь добавлен:",p);}
    o.storagePaths=a; fs.writeFileSync(f,JSON.stringify(o,null,2));
    console.log("   storagePaths =",JSON.stringify(a));
  ' "$CONFIG" "$path"
  echo "   применить: systemctl restart prizrak"
}
cmd_storage_remove() {
  [ -f "$CONFIG" ] || die "нет конфига"
  local path="${1:-}"; [ -n "$path" ] || die "укажите путь: $0 storage-remove /путь"
  node -e '
    const fs=require("fs");const [f,p]=process.argv.slice(1);
    const o=JSON.parse(fs.readFileSync(f,"utf8"));
    let a=Array.isArray(o.storagePaths)?o.storagePaths.slice():[];
    const n=a.length; a=a.filter(x=>x!==p);
    o.storagePaths=a.length?a:null; fs.writeFileSync(f,JSON.stringify(o,null,2));
    console.log(n===a.length?"⚠ такого пути в конфиге не было":"✅ путь удалён:",p);
    console.log("   storagePaths =",JSON.stringify(o.storagePaths));
  ' "$CONFIG" "$path"
  echo "   ВНИМАНИЕ: файлы в этом каталоге на диске НЕ удаляются — сервер просто перестанет туда писать/читать."
  echo "   применить: systemctl restart prizrak"
}
cmd_storage_max() {
  [ -f "$CONFIG" ] || die "нет конфига"
  local gb="${1:-}"; case "$gb" in ''|*[!0-9]*) die "размер в ГБ целым числом: $0 storage-max 350";; esac
  node -e '
    const fs=require("fs");const [f,gb]=process.argv.slice(1);
    const o=JSON.parse(fs.readFileSync(f,"utf8"));
    o.storageMaxBytes=Number(gb)*1073741824;
    fs.writeFileSync(f,JSON.stringify(o,null,2));
    console.log("✅ лимит хранилища = "+gb+" ГБ ("+o.storageMaxBytes+" байт)");
  ' "$CONFIG" "$gb"
  echo "   применить: systemctl restart prizrak"
}

# ── Федерация: куда ходить за чужими доменами (нужно, если серверы на http без TLS) ─
cmd_resolver_add() {
  [ -f "$CONFIG" ] || die "нет конфига"
  local dom="${1:-}" url="${2:-}"
  [ -n "$dom" ] && [ -n "$url" ] || die "использование: $0 resolver-add <домен> <baseUrl>   напр. resolver-add prizrak.webcluster.org http://1.2.3.4:8801"
  node -e '
    const fs=require("fs");const [f,d,u]=process.argv.slice(1);
    const o=JSON.parse(fs.readFileSync(f,"utf8"));
    o.resolver=Object.assign({},o.resolver||{}); o.resolver[d]=u;
    fs.writeFileSync(f,JSON.stringify(o,null,2));
    console.log("✅ resolver["+d+"] = "+u); console.log("   resolver =",JSON.stringify(o.resolver));
  ' "$CONFIG" "$dom" "$url"
  echo "   применить: systemctl restart prizrak"
}
cmd_resolver_remove() {
  [ -f "$CONFIG" ] || die "нет конфига"
  local dom="${1:-}"; [ -n "$dom" ] || die "использование: $0 resolver-remove <домен>"
  node -e '
    const fs=require("fs");const [f,d]=process.argv.slice(1);
    const o=JSON.parse(fs.readFileSync(f,"utf8"));
    o.resolver=Object.assign({},o.resolver||{}); delete o.resolver[d];
    fs.writeFileSync(f,JSON.stringify(o,null,2));
    console.log("✅ убрано из resolver:",d); console.log("   resolver =",JSON.stringify(o.resolver));
  ' "$CONFIG" "$dom"
  echo "   применить: systemctl restart prizrak"
}
# Сколько хранить НЕ доставленные на чужой сервер сообщения, прежде чем бросить.
cmd_fed_retention() {
  [ -f "$CONFIG" ] || die "нет конфига"
  local v="${1:-}"; case "$v" in forever|1y|6mo|3mo|1mo|2w|1w|3d|1d) ;; *) die "значения: forever,1y,6mo,3mo,1mo,2w,1w,3d,1d   напр. $0 fed-retention 7d... (используйте 1w)";; esac
  node -e '
    const fs=require("fs");const [f,v]=process.argv.slice(1);
    const o=JSON.parse(fs.readFileSync(f,"utf8")); o.federationRetention=v;
    fs.writeFileSync(f,JSON.stringify(o,null,2)); console.log("✅ federationRetention =",v);
  ' "$CONFIG" "$v"
  echo "   применить: systemctl restart prizrak"
}

case "${1:-}" in
  init) shift; cmd_init "$@";;
  create-admin) shift; cmd_create_admin "$@";;
  start) shift; cmd_start "$@";;
  relay) cmd_relay;;
  ping) cmd_ping;;
  enable-registration) cmd_toggle true;;
  disable-registration) cmd_toggle false;;
  status) cmd_status;;
  storage-add) shift; cmd_storage_add "$@";;
  storage-remove) shift; cmd_storage_remove "$@";;
  storage-max) shift; cmd_storage_max "$@";;
  storage-list|storage) cmd_status;;
  resolver-add) shift; cmd_resolver_add "$@";;
  resolver-remove) shift; cmd_resolver_remove "$@";;
  fed-retention) shift; cmd_fed_retention "$@";;
  *) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -n 31;;
esac
