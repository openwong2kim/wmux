#!/usr/bin/env bash
# Stop the isolated instance that launch.sh started, by its recorded PIDs only.
#
#   scripts/readme-clips/down.sh -readme3
#
# A recorded PID is killed only while its process start time still matches the one
# launch.sh recorded, so a PID that was reused (for example by the real wmux) is never
# touched. Order: dedicated Chrome (found by the instance's own profile), the app
# (kill -9: a graceful quit could install a downloaded update into /Applications), the
# daemon (daemon.shutdown so it ends its panes, then kill -9 if it is still up), then
# PIDs a scenario recorded in <state>/extra.pids. Never pkill, killall or a pattern.
# Exits non-zero, listing what is left, if a process of this suffix is still running
# that the kit did not record.
set -uo pipefail

SUFFIX="${1:-}"
[[ -n "$SUFFIX" && "$SUFFIX" != -* ]] && SUFFIX="-$SUFFIX"
if [[ ! "$SUFFIX" =~ ^-[A-Za-z0-9_-]+$ ]]; then echo "usage: down.sh -readme<n>" >&2; exit 2; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${READMECLIPS_STATE:-${TMPDIR:-/tmp}/readme-clips-state}/$SUFFIX"
DATA="$HOME/.wmux$SUFFIX"
PROFILE="$HOME/Library/Application Support/wmux$SUFFIX/chrome-agent-profile"
LEFT=0

# same_proc <pid> <recorded start time>: the PID is alive and is still the process we recorded.
same_proc() {
  [[ "$1" =~ ^[0-9]+$ && -n "$2" ]] || return 1
  [[ "$(ps -o lstart= -p "$1" 2>/dev/null)" == "$2" ]]
}

# kill_recorded <label> <pid file> <start file>
kill_recorded() {
  local pid start
  pid="$(cat "$2" 2>/dev/null)"; start="$(cat "$3" 2>/dev/null)"
  [[ -n "$pid" ]] || return 0
  if same_proc "$pid" "$start"; then kill -9 "$pid" && echo "[down] killed $1 $pid"
  elif kill -0 "$pid" 2>/dev/null; then echo "[down] $1 $pid is a different process now; left alone"
  else echo "[down] $1 $pid already gone"; fi
}

# 1. Dedicated Chrome: the PID listening on the port in this instance's own profile,
#    and only if its command line carries that profile path.
while IFS= read -r portfile; do
  port="$(head -1 "$portfile" 2>/dev/null)"
  [[ "$port" =~ ^[0-9]+$ ]] || continue
  for pid in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
    if [[ "$(ps -p "$pid" -o command= 2>/dev/null)" == *"$PROFILE"* ]]; then kill -9 "$pid" && echo "[down] killed chrome $pid"; fi
  done
done < <(find "$PROFILE" -maxdepth 2 -name DevToolsActivePort 2>/dev/null)

# 2. The app.
kill_recorded app "$STATE/app.pid" "$STATE/app.start"

# 3. The daemon the app started.
DPID="$(cat "$STATE/daemon.pid" 2>/dev/null)"
if same_proc "$DPID" "$(cat "$STATE/daemon.start" 2>/dev/null)"; then
  node "$HERE/rpc.mjs" "$SUFFIX" daemon.shutdown '{}' >/dev/null 2>&1 && echo "[down] daemon.shutdown sent"
  for _ in $(seq 1 20); do kill -0 "$DPID" 2>/dev/null || break; sleep 0.25; done
fi
kill_recorded daemon "$STATE/daemon.pid" "$STATE/daemon.start"

# 4. Processes a scenario recorded (lib.mjs recordPid): "<pid>\t<start time>" per line.
if [[ -f "$STATE/extra.pids" ]]; then
  while IFS=$'\t' read -r pid start; do
    if same_proc "$pid" "$start"; then kill -9 "$pid" && echo "[down] killed extra $pid"; fi
  done <"$STATE/extra.pids"
fi

# Anything of this suffix still alive was not started by the kit: report it, do not kill it.
sleep 0.5
for f in "$DATA/daemon.pid"; do
  pid="$(cat "$f" 2>/dev/null)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "[down] still running, not recorded by the kit: daemon $pid ($f). Stop it by hand." >&2
    LEFT=1
  fi
done

rm -f "$STATE/app.pid" "$STATE/app.start" "$STATE/cdp-port" "$STATE/daemon.pid" "$STATE/daemon.start" "$STATE/extra.pids"
if (( LEFT )); then exit 1; fi
echo "[down] $SUFFIX stopped (data kept in $DATA)"
