#!/bin/sh
# One Postgres database per Paperclip worktree, cloned from a seeded template.
#
#   worktree-db.sh provision --port 5433 --role particups --password particups --prefix particups
#   worktree-db.sh teardown  --port 5433 --role particups --password particups --prefix particups
#   worktree-db.sh template  --port 5433 --role particups --password particups --prefix particups \
#     --prepare 'pnpm db:migrate && pnpm db:seed'
#
# provision (the project's provisionCommand, in the worktree): creates <prefix>_wt_<name> from
# <prefix>_template, and an empty <prefix>_wt_<name>_test, then points DATABASE_URL and
# TEST_DATABASE_URL in the worktree's .env at them. Existing databases are kept, so it is
# safe on every reuse. Without a template, the database starts empty: `pnpm dev` migrates it.
# teardown (the project's teardownCommand): drops both databases.
# template (by hand, from a checkout of main): rebuilds the template with --prepare, run with
# DATABASE_URL pointing at it. The old template stays in use until the new one is ready.
#
# Paperclip runs provision and teardown outside the agents' sandbox. Keep this file outside
# the repositories, where agents can't edit it: it runs no repository code, only reads
# .env.example and writes .env. The role must not be a superuser; it needs CREATEDB.
set -eu

usage() {
  sed -n '2,6p' "$0" >&2
  exit 2
}

[ $# -ge 1 ] || usage
action=$1
shift
port="" role="" password="" prefix="" prepare=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port=$2 ;;
    --role) role=$2 ;;
    --password) password=$2 ;;
    --prefix) prefix=$2 ;;
    --prepare) prepare=$2 ;;
    *) usage ;;
  esac
  shift 2
done
[ -n "$port" ] && [ -n "$role" ] && [ -n "$password" ] && [ -n "$prefix" ] || usage
case "$prefix$role" in *[!a-z0-9_]*) echo "prefix and role: lowercase letters, digits and _ only" >&2; exit 2 ;; esac

psql_bin=$(command -v psql || true)
for candidate in /Applications/Postgres.app/Contents/Versions/latest/bin/psql /opt/homebrew/opt/libpq/bin/psql; do
  [ -n "$psql_bin" ] || { [ -x "$candidate" ] && psql_bin=$candidate; }
done
[ -n "$psql_bin" ] || { echo "psql not found" >&2; exit 1; }

sql() {
  PGPASSWORD=$password PGOPTIONS='-c client_min_messages=warning' "$psql_bin" -h 127.0.0.1 -p "$port" -U "$role" -d postgres -XAtq -v ON_ERROR_STOP=1 -c "$1"
}
exists() { [ "$(sql "SELECT 1 FROM pg_database WHERE datname = '$1'")" = 1 ]; }
url() { printf 'postgres://%s:%s@localhost:%s/%s' "$role" "$password" "$port" "$1"; }
template=${prefix}_template

# Database names: lowercase letters, digits and _, at most 63 bytes with "_test", unique per
# worktree even after truncation.
worktree_names() {
  name=${PAPERCLIP_WORKSPACE_BRANCH:-}
  [ -n "$name" ] || name=$(basename "${PAPERCLIP_WORKSPACE_CWD:-$PWD}")
  # shellcheck disable=SC2018,SC2019 # ASCII on purpose: these become database names.
  slug=$(printf '%s' "$name" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '_' | tr -s '_' | sed 's/^_//; s/_$//')
  hash=$(printf '%s' "$name" | shasum | cut -c1-6)
  max=$((63 - ${#prefix} - 4 - 1 - 6 - 5))
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
    set_env DATABASE_URL "$(url "$db")"
    set_env TEST_DATABASE_URL "$(url "$test_db")"
    echo "worktree databases: $db, $test_db"
    ;;
  teardown)
    worktree_names
    for name in "$test_db" "$db"; do
      sql "DROP DATABASE IF EXISTS \"$name\" WITH (FORCE)"
    done
    echo "dropped $db and $test_db"
    ;;
  template)
    [ -n "$prepare" ] || usage
    next=${template}_next
    sql "DROP DATABASE IF EXISTS \"$next\" WITH (FORCE)"
    sql "CREATE DATABASE \"$next\" OWNER \"$role\""
    DATABASE_URL=$(url "$next") sh -c "$prepare"
    sql "DROP DATABASE IF EXISTS \"$template\" WITH (FORCE)"
    sql "ALTER DATABASE \"$next\" RENAME TO \"$template\""
    # Nobody connects to the template, so cloning it never waits.
    sql "ALTER DATABASE \"$template\" ALLOW_CONNECTIONS false"
    echo "rebuilt $template"
    ;;
  *) usage ;;
esac
