#!/bin/sh
# A native Mailpit for one app, started at login by launchd, instead of a container.
#
#   mailpit-server.sh --name particups --smtp 1125 --ui 8125
#
# Loopback only: it holds sign-in codes and links. Installs Mailpit with Homebrew if needed.
# To remove it: launchctl bootout gui/$(id -u)/dev.paperclip.mailpit.<name>, then delete the
# plist in ~/Library/LaunchAgents.
set -eu

name="" smtp="" ui=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name=$2 ;;
    --smtp) smtp=$2 ;;
    --ui) ui=$2 ;;
    *) sed -n '2,4p' "$0" >&2; exit 2 ;;
  esac
  shift 2
done
[ -n "$name" ] && [ -n "$smtp" ] && [ -n "$ui" ] || { sed -n '2,4p' "$0" >&2; exit 2; }
case "$name" in *[!a-z0-9_-]*) echo "name: lowercase letters, digits, _ and - only" >&2; exit 2 ;; esac
case "$smtp$ui" in *[!0-9]*) echo "ports: digits only" >&2; exit 2 ;; esac

label=dev.paperclip.mailpit.$name
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/mailpit-$name.log"
[ ! -e "$plist" ] || { echo "$plist already exists" >&2; exit 1; }
for port in "$smtp" "$ui"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is in use. Stop what listens there first (a container: docker stop <name>):" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2
    exit 1
  fi
done

mailpit=$(command -v mailpit || true)
if [ -z "$mailpit" ]; then
  brew install mailpit
  mailpit=$(brew --prefix)/bin/mailpit
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$mailpit</string>
    <string>--smtp</string><string>127.0.0.1:$smtp</string>
    <string>--listen</string><string>127.0.0.1:$ui</string>
    <string>--smtp-auth-accept-any</string>
    <string>--smtp-auth-allow-insecure</string>
    <string>--max</string><string>5000</string>
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
until curl -fs "http://127.0.0.1:$ui/readyz" >/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 30 ] || { echo "Mailpit didn't start; see $log" >&2; exit 1; }
  sleep 1
done
echo "Mailpit for $name: SMTP 127.0.0.1:$smtp, UI http://127.0.0.1:$ui, log in $log"
