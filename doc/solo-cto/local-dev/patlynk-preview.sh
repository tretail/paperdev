#!/bin/sh
# Patlynk's preview: one worktree's backend (Spring, `:api:bootRun`) and patient site (Next.js),
# together in one macOS sandbox (preview-sandbox.sh). It's the Paperclip runtime service's
# command, run in the worktree:
#
#   patlynk-preview.sh        (Paperclip sets PORT; open https://<tailnet name>:$PORT)
#
# The patient site listens on $PORT and calls the backend server-side, on a free loopback port
# picked here. The backend lets loopback calls into /api/web/** without a token, so anonymous
# pages work (home, trial search, trial pages). Login, bookmarks and applying need the staging
# Supabase project, and the backoffice needs a Microsoft Entra login: the preview has no internet,
# so neither works. No AWS emulator either: the queue listeners are off, and the city and
# condition autocomplete, whose Lucene indexes come from S3, is unavailable.
#
# Postgres comes from the worktree's .env (DATABASE_URL, DATABASE_USERNAME, DATABASE_PASSWORD,
# written by paperclip-worktree-db), read as data, never sourced. Liquibase brings the database,
# a clone of the seeded patlynk_template, up to the branch when the backend starts. The site
# starts once the backend answers, so Paperclip reports the preview ready only when both are (a
# first build can take minutes).
#
# Outside the sandbox, this script reads only the main checkout's pinned toolchain (its .mise.toml
# is yours, on main). A worktree's mise config is never evaluated: agents edit it.
#
# Inside the sandbox (preview-sandbox.sh --local-network): Gradle needs its daemon's and its
# file-lock socket's random loopback ports. Its home is the agents' Gradle home, whose caches their
# own builds fill through their sandbox's proxy: the preview has no internet, so a dependency no
# agent has downloaded yet fails the backend's start. The site's packages come from the worktree's
# node_modules, or an offline install from the agents' pnpm store.
#
# Keep this file outside the repositories, where agents can't edit it, next to preview-sandbox.sh
# (installed as paperclip-preview-sandbox).
set -eu

: "${PORT:?PORT is not set (Paperclip sets it for a runtime service)}"
company=$HOME/Workspaces/patlynk
gradle_home=$company/.paperclip-tools/gradle
pnpm_store=$company/.paperclip-tools/pnpm-store
[ -f backend/gradlew ] && [ -d frontend/apps/patient ] || { echo "patlynk-preview: run it in a Patlynk checkout" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd -P)
sandbox=$here/paperclip-preview-sandbox
[ -f "$sandbox" ] || sandbox=$here/preview-sandbox.sh

java_home=$(cd "$company" && mise where java)
node_home=$(cd "$company" && mise where node)
pnpm_bin=$(cd "$company" && mise which pnpm)
backend_port=$(/usr/bin/python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')

export JAVA_HOME="$java_home" PATH="$java_home/bin:$node_home/bin:$(dirname "$pnpm_bin"):$PATH"
export GRADLE_USER_HOME="$gradle_home" PNPM_STORE_DIR="$pnpm_store" BACKEND_PORT="$backend_port"
# Java's dual-stack sockets reach 127.0.0.1 as ::ffff:127.0.0.1, which the sandbox's loopback rule
# doesn't match. The app's heap is capped: Gradle's own -Xmx2g (gradle.properties) still wins.
export JAVA_TOOL_OPTIONS="-Djava.net.preferIPv4Stack=true -Xmx1536m"
export NEXT_TELEMETRY_DISABLED=1

echo "patlynk-preview: patient site on port $PORT, backend on port $backend_port"
# Not exec: this process must keep its own command line. After a restart, Paperclip adopts a
# surviving preview only if the process it started still shows the service's command
# (paperclip-preview-patlynk); otherwise it starts a second copy and leaves this one running.
# shellcheck disable=SC2016 # the inner script expands its variables itself, inside the sandbox
"$sandbox" --local-network --write "$gradle_home" --write "$pnpm_store" --tailnet /bin/sh -c '
  set -eu
  env_value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1; }
  db_url=$(env_value DATABASE_URL) db_user=$(env_value DATABASE_USERNAME) db_password=$(env_value DATABASE_PASSWORD)
  [ -n "$db_url" ] && [ -n "$db_user" ] || { echo "patlynk-preview: no database in .env: this worktree has none" >&2; exit 1; }
  # Off: the queue listeners (no SQS) and the Lucene download (no S3). Placeholder AWS keys keep
  # the SDK away from real credentials.
  ( cd backend && DATABASE_URL=$db_url DATABASE_USERNAME=$db_user DATABASE_PASSWORD=$db_password \
      SERVER_PORT=$BACKEND_PORT SERVER_ADDRESS=127.0.0.1 SPRING_PROFILES_ACTIVE=local \
      SPRING_CLOUD_AWS_SQS_QUEUE_CTGOV_READ=false SPRING_CLOUD_AWS_SQS_QUEUE_CTIS_READ=false \
      SPRING_CLOUD_AWS_SQS_QUEUE_OPENAI_READ=false SPRING_CLOUD_AWS_SQS_QUEUE_DATA_READ=false \
      SPRING_CLOUD_AWS_S3_BUCKET_DATA_NAME= \
      AWS_ACCESS_KEY_ID=preview AWS_SECRET_ACCESS_KEY=preview AWS_REGION=eu-west-3 \
      exec ./gradlew --no-daemon --console=plain :api:bootRun ) &
  backend=$!
  trap "kill $backend 2>/dev/null || true" EXIT
  trap "exit 143" TERM
  trap "exit 130" INT
  cd frontend
  if [ ! -d node_modules ]; then
    echo "patlynk-preview: installing the site'"'"'s dependencies offline"
    CI=true pnpm install --frozen-lockfile --offline --ignore-scripts --store-dir "$PNPM_STORE_DIR"
  fi
  # Directly, with no X-Forwarded-For: the backend refuses its health check through a proxy.
  until curl -fs -o /dev/null "http://127.0.0.1:$BACKEND_PORT/actuator/health"; do
    kill -0 "$backend" 2>/dev/null || { echo "patlynk-preview: the backend stopped" >&2; exit 1; }
    sleep 2
  done
  base=http://127.0.0.1:$PORT
  [ -z "${PREVIEW_TAILNET_HOST:-}" ] || base=https://$PREVIEW_TAILNET_HOST:$PORT
  echo "patlynk-preview: backend up, starting the patient site ($base)"
  # Placeholders for Supabase and Strapi, on a closed port so they fail fast: no login, and no
  # CMS pages. PATLYNK_API_URL stays on loopback, which is what lets the backend skip auth.
  # Next listens as "localhost", resolved to 127.0.0.1 first: its locale rewrites target
  # localhost, and with -H 127.0.0.1 it took them for another origin, so / redirected to itself.
  PATLYNK_API_URL=http://127.0.0.1:$BACKEND_PORT BASE_URL=$base APP_ENV=local \
    NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9 NEXT_PUBLIC_SUPABASE_ANON_KEY=preview \
    NEXT_PUBLIC_SUPABASE_PROJECT_ID=preview STRAPI_API_URL=http://127.0.0.1:9 STRAPI_API_TOKEN=preview \
    ALLOWED_DEV_ORIGINS=${PREVIEW_TAILNET_HOST:-} \
    NODE_OPTIONS=--dns-result-order=ipv4first pnpm --filter patient exec next dev -p "$PORT" -H localhost
' || exit $?
