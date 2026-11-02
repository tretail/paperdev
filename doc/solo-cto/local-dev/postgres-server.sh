#!/bin/sh
# A native Postgres server for one app, started at login by launchd, instead of a container.
#
#   postgres-server.sh --name particups --version 17 --port 5433 --role particups \
#     --password particups [--restore <file from pg_dump -Fc>]
#   postgres-server.sh --name tablebear --version 18 --port 5434 --role app --password app \
#     --role-attrs "CREATEDB BYPASSRLS" --init-sql tools/db/native-roles.sql --max-connections 400
#
# Loopback only, and a password on every connection. With Postgres.app's default trust rules,
# any local process could log in as a superuser and run commands as you (COPY ... PROGRAM),
# outside the agents' sandbox. The superuser is `postgres`, with a random password added to
# ~/.pgpass, which agents can't read. The app role gets CREATEDB but isn't a superuser; it
# owns <name> and <name>_test, and worktree-db.sh clones databases with it.
#
# --role-attrs adds attributes to the app role; only CREATEDB, BYPASSRLS and CREATEROLE are
# accepted, never SUPERUSER. --init-sql runs a file as the superuser once, after the role exists:
# for what the app role can't do itself, such as creating the roles its migrations expect. Read
# the file first: it runs with full rights. --max-connections raises Postgres's default of 100,
# for test suites that open many pools; every worktree's tests share the server.
#
# It uses Postgres.app's binaries, but Postgres.app's window doesn't list the server.
# To remove it: launchctl bootout gui/$(id -u)/dev.paperclip.postgres.<name>, delete the plist
# in ~/Library/LaunchAgents, the data folder it prints, and its two lines in ~/.pgpass.
set -eu
# Byte-wise character ranges: in en_US.UTF-8, [A-Z] in a pattern also matches lowercase letters.
export LC_ALL=C

name="" version="" port="" role="" password="" restore="" role_attrs="CREATEDB" init_sql="" max_connections=100
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name=$2 ;;
    --version) version=$2 ;;
    --port) port=$2 ;;
    --role) role=$2 ;;
    --password) password=$2 ;;
    --restore) restore=$2 ;;
    --role-attrs) role_attrs=$2 ;;
    --init-sql) init_sql=$2 ;;
    --max-connections) max_connections=$2 ;;
    *) sed -n '2,8p' "$0" >&2; exit 2 ;;
  esac
  shift 2
done
[ -n "$name" ] && [ -n "$version" ] && [ -n "$port" ] && [ -n "$role" ] && [ -n "$password" ] || { sed -n '2,8p' "$0" >&2; exit 2; }
case "$name$role" in *[!a-z0-9_]*) echo "name and role: lowercase letters, digits and _ only" >&2; exit 2 ;; esac
case "$password" in *[!A-Za-z0-9_-]*) echo "password: letters, digits, _ and - only" >&2; exit 2 ;; esac
case "$port$version$max_connections" in *[!0-9]*) echo "port, version and max-connections: digits only" >&2; exit 2 ;; esac

bin=/Applications/Postgres.app/Contents/Versions/$version/bin
data="$HOME/Library/Application Support/Postgres/$name-$version"
label=dev.paperclip.postgres.$name
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/postgres-$name.log"

[ -x "$bin/postgres" ] || { echo "Postgres.app has no version $version ($bin)" >&2; exit 1; }
[ ! -e "$data" ] || { echo "$data already exists" >&2; exit 1; }
[ ! -e "$plist" ] || { echo "$plist already exists" >&2; exit 1; }
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $port is in use. Stop what listens there first (a container: docker stop <name>):" >&2
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2
  exit 1
fi
[ -z "$restore" ] || [ -f "$restore" ] || { echo "$restore not found" >&2; exit 1; }
[ -z "$init_sql" ] || [ -f "$init_sql" ] || { echo "$init_sql not found" >&2; exit 1; }
for attr in $role_attrs; do
  case "$attr" in
    CREATEDB | BYPASSRLS | CREATEROLE) ;;
    *) echo "--role-attrs: only CREATEDB, BYPASSRLS and CREATEROLE, not $attr" >&2; exit 2 ;;
  esac
done

umask 077
superuser_password=$(openssl rand -hex 24)
pwfile=$(mktemp)
trap 'rm -f "$pwfile"' EXIT
printf '%s' "$superuser_password" >"$pwfile"
mkdir -p "$(dirname "$data")"
"$bin/initdb" -D "$data" -U postgres --auth=scram-sha-256 --pwfile="$pwfile" -E UTF8 --locale=en_US.UTF-8 >/dev/null
touch "$HOME/.pgpass"
chmod 600 "$HOME/.pgpass"
printf '127.0.0.1:%s:*:postgres:%s\nlocalhost:%s:*:postgres:%s\n' \
  "$port" "$superuser_password" "$port" "$superuser_password" >>"$HOME/.pgpass"
cat >>"$data/postgresql.conf" <<EOF

# $name local development: loopback only (see paperdev doc/solo-cto/local-dev).
listen_addresses = '127.0.0.1'
port = $port
max_connections = $max_connections
EOF

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bin/postgres</string>
    <string>-D</string>
    <string>$data</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
chmod 644 "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"

tries=0
until "$bin/pg_isready" -q -h 127.0.0.1 -p "$port"; do
  tries=$((tries + 1))
  [ "$tries" -lt 30 ] || { echo "Postgres didn't start; see $log" >&2; exit 1; }
  sleep 1
done

"$bin/psql" -h 127.0.0.1 -p "$port" -U postgres -d postgres -w -XAtq -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE $role LOGIN PASSWORD '$password' $role_attrs" \
  -c "CREATE DATABASE $name OWNER $role" \
  -c "CREATE DATABASE ${name}_test OWNER $role"

if [ -n "$init_sql" ]; then
  "$bin/psql" -h 127.0.0.1 -p "$port" -U postgres -d postgres -w -Xq -v ON_ERROR_STOP=1 -f "$init_sql"
  echo "ran $init_sql as the superuser"
fi

if [ -n "$restore" ]; then
  PGPASSWORD=$password "$bin/pg_restore" -h 127.0.0.1 -p "$port" -U "$role" -d "$name" \
    --no-owner --no-privileges "$restore"
  echo "restored $restore into $name"
fi

echo "Postgres $version for $name: 127.0.0.1:$port, data in $data, log in $log"
echo "databases $name and ${name}_test, owned by $role ($role_attrs, not a superuser)"
