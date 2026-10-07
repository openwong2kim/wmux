#!/usr/bin/env bash
# Stop the isolated instance that launch.sh started, by its saved PIDs only.
#
#   scripts/readme-clips/down.sh -readme3
#
# Order: dedicated Chrome (found by its own CDP port), the app (kill -9: a graceful
# quit could install a downloaded update into /Applications), then the daemon
# (daemon.shutdown RPC so it ends its panes, then kill -9 if it is still up), then
# any PIDs a scenario appended to <state>/extra.pids. Never pkill, killall or a pattern.
set -uo pipefail

SUFFIX="${1:-}"
[[ -n "$SUFFIX" && "$SUFFIX" != -* ]] && SUFFIX="-$SUFFIX"
if [[ ! "$SUFFIX" =~ ^-[A-Za-z0-9_-]+$ ]]; then echo "usage: down.sh -readme<n>" >&2; exit 2; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${READMECLIPS_STATE:-${TMPDIR:-/tmp}/readme-clips-state}/$SUFFIX"
DATA="$HOME/.wmux$SUFFIX"
PROFILE="$HOME/Library/Application Support/wmux$SUFFIX/chrome-agent-profile"

# kill_checked <pid> <substring the command line must contain> <label>
kill_checked() {
  local pid="$1" must="$2" label="$3" cmd
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ -z "$cmd" ]]; then echo "[down] $label $pid already gone"; return 0; fi
  if [[ "$cmd" != *"$must"* ]]; then echo "[down] $label $pid is not ours any more ($cmd); left alone"; return 0; fi
  kill -9 "$pid" && echo "[down] killed $label $pid"
}

# 1. Dedicated Chrome: its CDP port from the profile, then the one PID listening on it.
while IFS= read -r portfile; do
  port="$(head -1 "$portfile" 2>/dev/null)"
  [[ "$port" =~ ^[0-9]+$ ]] || continue
  for pid in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
    kill_checked "$pid" "$PROFILE" "chrome"
  done
done < <(find "$PROFILE" -maxdepth 2 -name DevToolsActivePort 2>/dev/null)
[[ -f "$STATE/chrome.pid" ]] && kill_checked "$(cat "$STATE/chrome.pid")" "$PROFILE" "chrome"

# 2. The app.
[[ -f "$STATE/app.pid" ]] && kill_checked "$(cat "$STATE/app.pid")" "wmux.app" "app"

# 3. The daemon.
DPID="$(cat "$STATE/daemon.pid" 2>/dev/null || cat "$DATA/daemon.pid" 2>/dev/null || true)"
if [[ -n "$DPID" ]] && kill -0 "$DPID" 2>/dev/null; then
  node "$HERE/rpc.mjs" "$SUFFIX" daemon.shutdown '{}' >/dev/null 2>&1 && echo "[down] daemon.shutdown sent"
  for _ in $(seq 1 20); do kill -0 "$DPID" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$DPID" 2>/dev/null && kill_checked "$DPID" "wmux" "daemon"
fi

# 4. Anything a scenario recorded.
if [[ -f "$STATE/extra.pids" ]]; then
  while read -r pid must; do
    [[ -n "$pid" ]] && kill_checked "$pid" "${must:-$pid}" "extra"
  done <"$STATE/extra.pids"
fi

rm -f "$STATE/app.pid" "$STATE/cdp-port" "$STATE/daemon.pid" "$STATE/chrome.pid" "$STATE/extra.pids"
echo "[down] $SUFFIX stopped (data kept in $DATA)"
