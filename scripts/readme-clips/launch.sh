#!/usr/bin/env bash
# Start an isolated copy of the installed wmux for recording.
#
#   scripts/readme-clips/launch.sh -readme3          # fresh suffix (refuses one that was used before)
#   scripts/readme-clips/launch.sh -readme3 --reuse  # relaunch the same suffix (e.g. survive-quit)
#
# Saves the app PID and the renderer CDP port under $READMECLIPS_STATE/<suffix>
# (default $TMPDIR/readme-clips-state/<suffix>). down.sh kills only that PID.
set -euo pipefail

SUFFIX="${1:-}"
[[ -n "$SUFFIX" && "$SUFFIX" != -* ]] && SUFFIX="-$SUFFIX"
REUSE="${2:-}"
APP="${WMUX_APP:-/Applications/wmux.app/Contents/MacOS/wmux}"
if [[ ! "$SUFFIX" =~ ^-[A-Za-z0-9_-]+$ ]]; then
  echo "usage: launch.sh -readme<n> [--reuse]" >&2; exit 2
fi
[[ -x "$APP" ]] || { echo "no app at $APP" >&2; exit 1; }

STATE="${READMECLIPS_STATE:-${TMPDIR:-/tmp}/readme-clips-state}/$SUFFIX"
DATA="$HOME/.wmux$SUFFIX"
USERDATA="$HOME/Library/Application Support/wmux$SUFFIX"
mkdir -p "$STATE"

if [[ -f "$STATE/app.pid" ]] && kill -0 "$(cat "$STATE/app.pid")" 2>/dev/null; then
  echo "already running: pid $(cat "$STATE/app.pid") (run down.sh $SUFFIX first)" >&2; exit 1
fi
if [[ "$REUSE" != "--reuse" && ( -e "$DATA" || -e "$USERDATA" ) ]]; then
  echo "$SUFFIX was used before ($DATA). Pick a new suffix, or pass --reuse on purpose." >&2; exit 1
fi

# No caller identity may leak into the instance: the app hands its env to every
# shell and agent CLI it spawns. Keep HOME and PATH; SHELL must be zsh, or panes
# fall back to bash 3.2 and agent status breaks.
UNSET=(-u WMUX_PTY_ID -u WMUX_WORKSPACE_ID -u WMUX_SURFACE_ID -u WMUX_MEMBER_ID -u WMUX_SOCKET_PATH
       -u WMUX_WORKSPACE_NAME -u WMUX_DATA_SUFFIX)
while IFS='=' read -r k _; do
  case "$k" in CLAUDE*|ANTHROPIC*|AI_AGENT*) UNSET+=(-u "$k");; esac
done < <(env)

# Same window for every clip: 1280x800 (2560x1600 frames on a Retina screen).
WIN_W="${READMECLIPS_WIDTH:-1280}"; WIN_H="${READMECLIPS_HEIGHT:-800}"
mkdir -p "$DATA"
printf '{"bounds":{"x":80,"y":60,"width":%d,"height":%d},"maximized":false,"fullScreen":false}\n' "$WIN_W" "$WIN_H" >"$DATA/window-state.json"

# Panes get a neutral zsh: no user@host prompt, none of the owner's rc files, aliases
# or history. wmux's shell integration keeps working (it sources this ZDOTDIR).
ZD="$STATE/zdotdir"
mkdir -p "$ZD"
cat >"$ZD/.zshrc" <<ZRC
export PATH='$PATH'
PROMPT='%~ %# '
RPROMPT=''
HISTFILE='$ZD/.zsh_history'
ZRC

LOG="$STATE/app.log"
: >"$LOG"
nohup env "${UNSET[@]}" SHELL=/bin/zsh ZDOTDIR="$ZD" WMUX_DATA_SUFFIX="$SUFFIX" "$APP" </dev/null >>"$LOG" 2>&1 &
PID=$!
echo "$PID" >"$STATE/app.pid"
echo "[launch] $SUFFIX pid $PID, log $LOG"

PORT=""
for _ in $(seq 1 180); do
  PORT="$(sed -n 's/.*CDP listening on port \([0-9][0-9]*\).*/\1/p' "$LOG" | tail -1)"
  [[ -n "$PORT" ]] && break
  kill -0 "$PID" 2>/dev/null || { echo "[launch] app exited; see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; }
  sleep 0.5
done
[[ -n "$PORT" ]] || { echo "[launch] no 'CDP listening' line after 90 s; see $LOG" >&2; exit 1; }
echo "$PORT" >"$STATE/cdp-port"

# The daemon outlives the app (that is the survive-quit feature); remember it for down.sh.
for _ in $(seq 1 40); do [[ -s "$DATA/daemon.pid" ]] && break; sleep 0.5; done
if [[ -s "$DATA/daemon.pid" ]]; then
  cp "$DATA/daemon.pid" "$STATE/daemon.pid"
fi

cat <<EOF
[launch] ready
  suffix    $SUFFIX
  app pid   $PID
  daemon    $(cat "$STATE/daemon.pid" 2>/dev/null || echo '?')
  cdp port  $PORT
  data dir  $DATA
  userData  $USERDATA
  state     $STATE
EOF
