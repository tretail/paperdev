#!/bin/sh
# TableBear's preview: one worktree's backend (Gradle bootRun) and staff app (Vite), together in
# one macOS sandbox (preview-sandbox.sh). It's the Paperclip runtime service's command, run in the
# worktree:
#
#   tablebear-preview.sh        (Paperclip sets PORT; open https://<tailnet name>:$PORT)
#
# Paperclip gives a service one port, so the app listens on $PORT and the backend on a free
# port picked here, which the app's VITE_API_URL and the backend's CORS rule point at. Stub auth
# (the backend's local-auth profile), as `just dev`. Postgres comes from the worktree's .env
# (DB_URL, written by paperclip-worktree-db). The app starts once the backend answers, so
# Paperclip reports the preview ready only when both are (a first build can take minutes).
#
# On the tailnet (preview-sandbox.sh --tailnet, for the Mac owner's login only): the app on
# https://<tailnet name>:$PORT, the backend on https://<tailnet name>:<backend port>, which the
# browser calls directly (CORS allows the app's tailnet origin), and the Mailpit UI on :8025.
# Without Tailscale, the same on http://127.0.0.1.
#
# Outside the sandbox, this script reads only the main checkout's pinned toolchain (its
# .mise.toml is yours, on main). A worktree's mise config is never evaluated: agents edit it, and
# mise would first have to record it as trusted, which the sandbox refuses anyway.
#
# Inside the sandbox (preview-sandbox.sh --local-network): Gradle needs its daemon's and its
# file-lock socket's random loopback ports. Its home is the agents' Gradle home, whose caches their
# own builds fill through their sandbox's proxy: the preview has no internet, so a dependency no
# agent has downloaded yet fails the backend's start. The same goes for the app's packages: they
# come from the worktree's node_modules, or an offline install from the pnpm store.
#
# Keep this file outside the repositories, where agents can't edit it, next to preview-sandbox.sh
# (installed as paperclip-preview-sandbox).
set -eu

: "${PORT:?PORT is not set (Paperclip sets it for a runtime service)}"
company=$HOME/Workspaces/tablebear
gradle_home=$company/.paperclip-tools/gradle
mailpit_ui_port=8025
[ -f backend/gradlew ] && [ -d frontend ] || { echo "tablebear-preview: run it in a TableBear checkout" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd -P)
sandbox=$here/paperclip-preview-sandbox
[ -f "$sandbox" ] || sandbox=$here/preview-sandbox.sh

java_home=$(cd "$company" && mise where java)
node_home=$(cd "$company" && mise where node)
pnpm_bin=$(cd "$company" && mise which pnpm)
backend_port=$(/usr/bin/python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')

pnpm_dir=$(dirname "$pnpm_bin")
export JAVA_HOME="$java_home" PATH="$java_home/bin:$node_home/bin:$pnpm_dir:$PATH"
export GRADLE_USER_HOME="$gradle_home" BACKEND_PORT="$backend_port"
# Java's dual-stack sockets reach 127.0.0.1 as ::ffff:127.0.0.1, which the sandbox's loopback rule
# doesn't match. The app's heap is capped: Gradle's own -Xmx2g (gradle.properties) still wins.
export JAVA_TOOL_OPTIONS="-Djava.net.preferIPv4Stack=true -Xmx1536m"
export TURBO_DAEMON=false TURBO_TELEMETRY_DISABLED=1 TURBO_NO_UPDATE_NOTIFIER=1

echo "tablebear-preview: app on port $PORT, backend on port $backend_port"
# shellcheck disable=SC2016 # the inner script expands its variables itself, inside the sandbox
exec "$sandbox" --local-network --write "$gradle_home" \
  --tailnet --tailnet-port "$backend_port" --tailnet-port "$mailpit_ui_port" /bin/sh -c '
  set -eu
  api=http://127.0.0.1:$BACKEND_PORT
  origins=http://127.0.0.1:$PORT,http://localhost:$PORT
  if [ -n "${PREVIEW_TAILNET_HOST:-}" ]; then
    api=https://$PREVIEW_TAILNET_HOST:$BACKEND_PORT
    origins=$origins,https://$PREVIEW_TAILNET_HOST:$PORT
  fi
  ( cd backend && SERVER_PORT=$BACKEND_PORT SERVER_ADDRESS=127.0.0.1 \
      SPRING_PROFILES_ACTIVE=local,local-auth SPRING_DEVTOOLS_LIVERELOAD_ENABLED=false \
      CORS_ALLOWED_ORIGIN_PATTERNS="$origins" \
      exec ./gradlew --no-daemon --console=plain :app:bootRun ) &
  backend=$!
  trap "kill $backend 2>/dev/null || true" EXIT
  trap "exit 143" TERM
  trap "exit 130" INT
  cd frontend
  [ -d node_modules ] || pnpm install --frozen-lockfile --offline
  until curl -fs -o /dev/null "http://127.0.0.1:$BACKEND_PORT/actuator/health"; do
    kill -0 "$backend" 2>/dev/null || { echo "tablebear-preview: the backend stopped" >&2; exit 1; }
    sleep 2
  done
  echo "tablebear-preview: backend up, starting the app (API $api)"
  # Loose env mode: turbo would otherwise drop Vite'"'"'s extra allowed host, which isn'"'"'t VITE_*.
  VITE_API_URL=$api VITE_AUTH_MODE=stub \
    pnpm exec turbo run dev --env-mode=loose --filter=@repo/app -- --port "$PORT" --strictPort --host 127.0.0.1
'
