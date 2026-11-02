#!/bin/sh
# One Postgres database per Paperclip worktree, cloned from a seeded template.
#
#   worktree-db.sh provision --port 5433 --role particups --password particups --prefix particups
#   worktree-db.sh teardown  --port 5433 --role particups --password particups --prefix particups
#   worktree-db.sh template  --port 5433 --role particups --password particups --prefix particups \
#     --prepare 'pnpm db:migrate && pnpm db:seed'
#   worktree-db.sh provision --port 5434 --role app --password app --prefix tablebear \
#     --jdbc --url-key DB_URL --reserve 12 --set LOCAL_SERVICES=native
#
# provision (the project's provisionCommand, in the worktree): creates <prefix>_wt_<name> from
# <prefix>_template, and an empty <prefix>_wt_<name>_test, then points DATABASE_URL and
# TEST_DATABASE_URL in the worktree's .env at them. Existing databases are kept, so it is
# safe on every reuse. Without a template, the database starts empty: `pnpm dev` migrates it.
# teardown (the project's teardownCommand): drops both databases, and any <test database>_<suite>
# the app's tests made next to the test database.
#
# --jdbc writes jdbc:postgresql://127.0.0.1:<port>/<db> URLs without credentials, for apps that
# take those separately (TableBear). --url-key names the app database's key (default
# DATABASE_URL); the test database's is always TEST_DATABASE_URL. --reserve N shortens names by N
# more bytes, for apps whose tests add `_<suite>` to the test database's name. --set KEY=VALUE,
# repeatable, writes another .env entry. Same options for every action, or names change.
# template (by hand, from a checkout of main): rebuilds the template with --prepare, run with
# DATABASE_URL (or --url-key's name) pointing at it. The old template stays in use until the new one is ready.
#
# Paperclip runs provision and teardown outside the agents' sandbox. Keep this file outside
# the repositories, where agents can't edit it: it runs no repository code, only reads
# .env.example and writes .env. The role must not be a superuser; it needs CREATEDB.
set -eu
# Byte-wise character ranges: in en_US.UTF-8, [A-Z] in a pattern also matches lowercase letters.
export LC_ALL=C

usage() {
  sed -n '2,8p' "$0" >&2
  exit 2
}

[ $# -ge 1 ] || usage
action=$1
shift
port="" role="" password="" prefix="" prepare="" jdbc="" url_key=DATABASE_URL reserve=0 sets=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port=$2 ;;
    --role) role=$2 ;;
    --password) password=$2 ;;
    --prefix) prefix=$2 ;;
    --prepare) prepare=$2 ;;
    --url-key) url_key=$2 ;;
    --reserve) reserve=$2 ;;
    --set)
      case "${2%%=*}" in *[!A-Z0-9_]* | "") echo "--set $2: KEY=VALUE, KEY in uppercase letters, digits and _" >&2; exit 2 ;; esac
      case "$2" in *=*) ;; *) echo "--set $2: KEY=VALUE" >&2; exit 2 ;; esac
      sets="$sets
$2" ;;
    --jdbc) jdbc=1; shift; continue ;;
    *) usage ;;
  esac
  shift 2
done
[ -n "$port" ] && [ -n "$role" ] && [ -n "$password" ] && [ -n "$prefix" ] || usage
case "$prefix$role" in *[!a-z0-9_]*) echo "prefix and role: lowercase letters, digits and _ only" >&2; exit 2 ;; esac
case "$url_key" in *[!A-Z0-9_]* | "") echo "--url-key: uppercase letters, digits and _ only" >&2; exit 2 ;; esac
case "$reserve" in *[!0-9]* | "") echo "--reserve: a number" >&2; exit 2 ;; esac

psql_bin=$(command -v psql || true)
for candidate in /Applications/Postgres.app/Contents/Versions/latest/bin/psql /opt/homebrew/opt/libpq/bin/psql; do
  [ -n "$psql_bin" ] || { [ -x "$candidate" ] && psql_bin=$candidate; }
done
[ -n "$psql_bin" ] || { echo "psql not found" >&2; exit 1; }

sql() {
  PGPASSWORD=$password PGOPTIONS='-c client_min_messages=warning' "$psql_bin" -h 127.0.0.1 -p "$port" -U "$role" -d postgres -XAtq -v ON_ERROR_STOP=1 -c "$1"
}
exists() { [ "$(sql "SELECT 1 FROM pg_database WHERE datname = '$1'")" = 1 ]; }
url() {
  if [ -n "$jdbc" ]; then
    printf 'jdbc:postgresql://127.0.0.1:%s/%s' "$port" "$1"
  else
    printf 'postgres://%s:%s@localhost:%s/%s' "$role" "$password" "$port" "$1"
  fi
}
template=${prefix}_template

# Database names: lowercase letters, digits and _, at most 63 bytes with "_test", unique per
# worktree even after truncation.
worktree_names() {
  name=${PAPERCLIP_WORKSPACE_BRANCH:-}
  [ -n "$name" ] || name=$(basename "${PAPERCLIP_WORKSPACE_CWD:-$PWD}")
  # shellcheck disable=SC2018,SC2019 # ASCII on purpose: these become database names.
  slug=$(printf '%s' "$name" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '_' | tr -s '_' | sed 's/^_//; s/_$//')
  hash=$(printf '%s' "$name" | shasum | cut -c1-6)
  max=$((63 - ${#prefix} - 4 - 1 - 6 - 5 - reserve))
  [ "$max" -ge 4 ] || { echo "--prefix and --reserve leave no room for the worktree's name" >&2; exit 2; }
  slug=$(printf '%s' "$slug" | cut -c1-"$max" | sed 's/_$//')
  db=${prefix}_wt_${slug}_${hash}
  test_db=${db}_test
}

set_env() {
  if grep -q "^$1=" .env; then
    awk -v key="$1" -v value="$2" 'index($0, key "=") == 1 { print key "=" value; next } { print }' .env >.env.tmp
    mv .env.tmp .env
  else
    printf '%s=%s\n' "$1" "$2" >>.env
  fi
}

case "$action" in
  provision)
    worktree_names
    [ -f .env ] || cp .env.example .env
    if ! exists "$db"; then
      if exists "$template"; then
        # A clone fails while another session uses the template; provisions can overlap.
        tries=0
        until sql "CREATE DATABASE \"$db\" TEMPLATE \"$template\" OWNER \"$role\"" 2>/dev/null; do
          tries=$((tries + 1))
          [ "$tries" -lt 5 ] || { sql "CREATE DATABASE \"$db\" TEMPLATE \"$template\" OWNER \"$role\""; break; }
          sleep 2
        done
      else
        echo "warning: no $template database yet, so $db starts empty (pnpm dev migrates it, without demo data)" >&2
        sql "CREATE DATABASE \"$db\" OWNER \"$role\""
      fi
    fi
    exists "$test_db" || sql "CREATE DATABASE \"$test_db\" OWNER \"$role\""
    set_env "$url_key" "$(url "$db")"
    set_env TEST_DATABASE_URL "$(url "$test_db")"
    printf '%s\n' "$sets" | while IFS= read -r pair; do
      [ -n "$pair" ] || continue
      set_env "${pair%%=*}" "${pair#*=}"
    done
    echo "worktree databases: $db, $test_db"
    ;;
  teardown)
    worktree_names
    suites=$(sql "SELECT datname FROM pg_database WHERE starts_with(datname, '${test_db}_')")
    for name in $suites "$test_db" "$db"; do
      sql "DROP DATABASE IF EXISTS \"$name\" WITH (FORCE)"
    done
    [ -z "$suites" ] || echo "dropped $(printf '%s' "$suites" | tr '\n' ' ')"
    echo "dropped $db and $test_db"
    ;;
  template)
    [ -n "$prepare" ] || usage
    next=${template}_next
    sql "DROP DATABASE IF EXISTS \"$next\" WITH (FORCE)"
    sql "CREATE DATABASE \"$next\" OWNER \"$role\""
    env "$url_key=$(url "$next")" sh -c "$prepare"
    sql "DROP DATABASE IF EXISTS \"$template\" WITH (FORCE)"
    sql "ALTER DATABASE \"$next\" RENAME TO \"$template\""
    # Nobody connects to the template, so cloning it never waits.
    sql "ALTER DATABASE \"$template\" ALLOW_CONNECTIONS false"
    echo "rebuilt $template"
    ;;
  *) usage ;;
esac
