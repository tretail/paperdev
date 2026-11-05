#!/bin/sh
# Particups' preview: one worktree's app (React Router dev server) in a macOS sandbox
# (preview-sandbox.sh). It's the Paperclip runtime service's command, run in the worktree:
#
#   particups-preview.sh        (Paperclip sets PORT; open https://<tailnet name>:$PORT)
#
# `pnpm dev` migrates the worktree's own database (DATABASE_URL in its .env, written by
# paperclip-worktree-db) and serves the app on 127.0.0.1:$PORT. Postgres is on 5433 and Mailpit on
# 1125 (SMTP) and 8125 (its UI, also on the tailnet).
#
# Most worktrees have no node_modules: provisioning doesn't install, and agents only install when
# they need to. So the preview installs first, offline, from the agents' pnpm store, inside the
# sandbox (no internet, no install scripts run outside it). A package no agent has downloaded yet
# fails the install; the launcher page shows the log.
#
# Outside the sandbox, this script reads only the main checkout's pinned toolchain (its .mise.toml
# is yours, on main). A worktree's mise config is never evaluated: agents edit it.
#
# Keep this file outside the repositories, where agents can't edit it, next to preview-sandbox.sh
# (installed as paperclip-preview-sandbox).
set -eu

: "${PORT:?PORT is not set (Paperclip sets it for a runtime service)}"
company=$HOME/Workspaces/particups
pnpm_store=$company/.paperclip-tools/pnpm-store
[ -f package.json ] && [ -f react-router.config.ts ] || { echo "particups-preview: run it in a Particups checkout" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd -P)
sandbox=$here/paperclip-preview-sandbox
[ -f "$sandbox" ] || sandbox=$here/preview-sandbox.sh

node_home=$(cd "$company" && mise where node)
pnpm_bin=$(cd "$company" && mise which pnpm)
export PATH="$node_home/bin:$(dirname "$pnpm_bin"):$PATH" PNPM_STORE_DIR="$pnpm_store"

echo "particups-preview: app on port $PORT"
# Not exec: this process must keep its own command line. After a restart, Paperclip adopts a
# surviving preview only if the process it started still shows the service's command
# (paperclip-preview-particups); otherwise it starts a second copy and leaves this one running.
# shellcheck disable=SC2016 # the inner script expands its variables itself, inside the sandbox
"$sandbox" --tailnet --tailnet-port 8125 --ports 5433,1125,8125 --write "$pnpm_store" /bin/sh -c '
  set -eu
  if [ ! -d node_modules ]; then
    echo "particups-preview: installing dependencies offline"
    CI=true pnpm install --frozen-lockfile --offline --store-dir "$PNPM_STORE_DIR"
  fi
  pnpm dev
' || exit $?
