#!/bin/sh
# Runs a preview, an app's dev server that Paperclip starts as a runtime service, inside a macOS
# sandbox. Paperclip starts runtime services outside the agents' sandbox, and a dev server runs
# code agents edit (vite.config.ts, the app itself), so this wrapper is that sandbox:
#
#   preview-sandbox.sh --ports 5433,1125,8125 pnpm dev     (a service command, in the worktree)
#
# The current directory is a worktree inside ~/Workspaces/<company>/, or the company's main
# checkout (which then can write the whole company folder). The command:
# - reads its own company folder, but no other company's, and none of the secrets below
# - writes only the current directory, temporary folders and caches
# - connects only to the loopback ports given with --ports and to $PORT: not to Paperclip or
#   its database, nor to the internet or Unix sockets (so not Postgres.app's trusted socket)
# - listens only on $PORT. The sandbox can't restrict which address that is, so the dev
#   command itself must bind 127.0.0.1.
#
# Keep this file outside the repositories, where agents can't edit it.
# Tailscale, later: run `tailscale serve` for $PORT here, before the sandbox starts.
set -eu

usage() { sed -n '2,6p' "$0" >&2; exit 2; }
ports=""
if [ "${1:-}" = "--ports" ]; then
  [ $# -ge 2 ] || usage
  ports=$2
  shift 2
fi
[ $# -ge 1 ] || usage
case "$ports,${PORT:-}" in *[!0-9,]*) echo "preview-sandbox: ports and PORT: digits and commas only" >&2; exit 2 ;; esac

root=$(cd "$HOME/Workspaces" && pwd -P)
cwd=$(pwd -P)
case "$cwd" in
  "$root"/?*) ;;
  *) echo "preview-sandbox: $cwd must be inside $root/<company>/" >&2; exit 1 ;;
esac
rest=${cwd#"$root"/}
company=$root/${rest%%/*}
home=$(cd "$HOME" && pwd -P)
for path in "$root" "$company" "$cwd" "$home"; do
  case "$path" in *[\"\\]*) echo "preview-sandbox: unsupported character in $path" >&2; exit 1 ;; esac
done

outbound="" bind=""
for port in $(printf '%s' "$ports,${PORT:-}" | tr ',' ' '); do
  outbound="$outbound (remote ip \"localhost:$port\")"
done
[ -z "${PORT:-}" ] || bind="(allow network-bind (local ip \"*:$PORT\"))"

# A function, not $(cat <<EOF): macOS's sh misparses quotes in a heredoc inside $(...).
write_profile() {
  cat <<EOF
(version 1)
(allow default)

; Other companies: nothing. The folder holding the companies stays readable (getcwd needs
; it), which shows only their names. An allow overrides a deny only for the same operation
; name (probed on macOS 15): file-read* here, as for every pair below.
(deny file-read* (subpath "$root"))
(allow file-read* (literal "$root") (subpath "$company"))

; Secrets, as in Paperclip's agent sandbox.
(deny file-read* file-write*
  (subpath "$home/.ssh") (subpath "$home/.aws") (subpath "$home/.gnupg")
  (subpath "$home/.paperclip") (literal "$home/.pgpass") (subpath "$home/Library/Keychains")
  (subpath "$home/.config/gh") (subpath "$home/.azure") (subpath "$home/.supabase")
  (subpath "$home/Library/Preferences/.wrangler") (subpath "$home/.docker")
  (literal "$home/.netrc") (literal "$home/.git-credentials"))

; Writes: the worktree, temporary folders and caches.
(deny file-write*)
(allow file-write*
  (subpath "$cwd")
  (subpath "/private/tmp") (subpath "/private/var/folders")
  (subpath "$home/Library/Caches") (subpath "$home/.cache")
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")
  (regex #"^/dev/tty") (regex #"^/dev/fd/"))

; Network: only the allowed loopback ports. Denying single ports after allowing
; localhost:* has no effect (probed), so this is an allow-list.
(deny network-outbound)
EOF
  [ -z "$outbound" ] || printf '(allow network-outbound%s)\n' "$outbound"
  printf '(deny network-bind)\n%s\n' "$bind"
}
profile=$(write_profile)

exec /usr/bin/sandbox-exec -p "$profile" "$@"
