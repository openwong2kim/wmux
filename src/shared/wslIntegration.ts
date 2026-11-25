import fs from 'node:fs';
import path from 'node:path';
import { mergeWslEnv, wslTargetArgs, type WslTarget } from './wsl';
import { CLAUDE_FILE_SEND_ENV } from './claudeFileSend';
import {
  ACCOUNT_ENV_VENDOR, ACCOUNT_SHARE_MANIFEST, WSL_ACCOUNT_DISTRO_ENV, WSL_ACCOUNT_KEYS_ENV, accountFolderShares, parseWslAccountKeys,
  wslAccountHomeKey, type AccountVendor,
} from './wslAccountHome';

// Per-launch settings only. Never edit ~/.claude/settings.json in either OS.
// Use the existing bridge in its Windows runtime: this preserves the named-pipe
// authentication and pane routing instead of adding a network listener.
//
// #1727 — the hook also says WHICH Linux process the agent is. Windows cannot
// see Linux processes, so the daemon's process-tree walk never finds a WSL
// pane's agent; but this script runs inside Linux as the agent's descendant.
// It reports the boot id and up to WSL_AGENT_PROC_HOPS ancestors (pid,
// starttime, first arguments), RS-separated; the daemon picks the one whose
// command line names the hook's agent (a `sh -c` may sit in between), and the
// rest of the chain tells a nested `claude -p` from the pane's own agent.
// Reading /proc here is builtins plus a few tiny filters per hop: no scan, no
// extra Windows spawn. Any failure leaves the report empty; the hook runs on.
export const WSL_AGENT_PROC_HOPS = 8;
/** The /proc ancestor report both WSL hooks run (Claude's WSL_HOOK, Codex's
 *  WSL_CODEX_HOOK); it sets WMUX_WSL_AGENT_PROC for the Windows bridge. */
const WSL_AGENT_PROC_FN = `wmux_agent_proc() {
  # A function, so set -- below cannot touch the hook's own arguments. No
  # set -f: it would outlive the function and break the Codex hook's later
  # rollout globs, and stat's fields after the last ')' hold no glob characters.
  # Cleared first, so a value inherited from the environment never passes on.
  WMUX_WSL_AGENT_PROC=
  { read -r wmux_boot < /proc/sys/kernel/random/boot_id; } 2>/dev/null || return 0
  wmux_out="1:$wmux_boot"
  wmux_p=$PPID
  wmux_n=0
  while [ "$wmux_n" -lt ${WSL_AGENT_PROC_HOPS} ] && [ "$wmux_p" -gt 1 ] 2>/dev/null; do
    wmux_stat=$(cat "/proc/$wmux_p/stat" 2>/dev/null) || break
    # comm (field 2) may hold spaces and parens: split after the LAST ')'.
    set -- \${wmux_stat##*) }
    [ $# -ge 20 ] || break
    # The first 4 WHOLE arguments (a byte cut could split a multibyte
    # character), US-separated; RS, US and newlines inside them become spaces.
    wmux_cmd=$(tr '\\000\\036\\037\\n' '\\n   ' < "/proc/$wmux_p/cmdline" 2>/dev/null | head -n 4 | tr '\\n' '\\037')
    wmux_out="$wmux_out$(printf '\\036')$wmux_p:\${20}:$wmux_cmd"
    wmux_p=$2
    wmux_n=$((wmux_n + 1))
  done
  WMUX_WSL_AGENT_PROC=$wmux_out
}`;
export const WSL_HOOK = `#!/bin/sh
# #1730 — the permission gate fires on EVERY tool call. It is dormant unless
# someone can answer it (wmux web --allow-input), and the daemon keeps a flag
# file for exactly that state. Without the flag: no opinion (exit 0, empty
# stdout), for the cost of one stat, instead of a Windows process per call.
wmux_gate=
for wmux_arg; do [ "$wmux_arg" = --permission-gate ] && wmux_gate=1; done
if [ -n "$wmux_gate" ]; then
  [ -n "\${WMUX_WSL_GATE_FLAG:-}" ] && [ -e "$WMUX_WSL_GATE_FLAG" ] || exit 0
  # The per-session opt-out the bridge would honour anyway, without the spawn.
  [ "\${WMUX_GATE:-}" != 0 ] || exit 0
fi
export ELECTRON_RUN_AS_NODE=1
${WSL_AGENT_PROC_FN}
# Per tool call while the gate is armed: skip the /proc walk; other hooks attribute.
[ -n "$wmux_gate" ] || wmux_agent_proc
export WMUX_WSL_AGENT_PROC
# The bridge tells an interactive session from a headless one (claude -p) by
# CLAUDE_CODE_ENTRYPOINT, and honours WMUX_GATE=0; both are Linux env (#1730).
export WSLENV="\${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE/w:WMUX_WSL_AGENT_PROC/w:CLAUDE_CODE_ENTRYPOINT/w:WMUX_GATE/w"
exec "$WMUX_WSL_NODE" "$WMUX_WSL_BRIDGE" "$@"
`;

export const WSL_CLAUDE_SHIM = `#!/bin/sh
# Remove this shim directory from a PATH, including repeated/nested injections.
strip_shim() {
  old_ifs=$IFS
  IFS=:
  clean=
  for entry in $1; do
    [ "$entry" = "$WMUX_WSL_BIN" ] && continue
    clean="\${clean:+$clean:}$entry"
  done
  IFS=$old_ifs
}
strip_shim "$PATH"
real=$(PATH="$clean" command -v claude)
if [ -z "$real" ]; then
  # #1305 — an EXEC pane runs bash with --noprofile --norc, deliberately: its
  # stream carries the agent's output and nothing else, so no startup file may
  # print into it. The side effect is that a claude whose PATH comes from
  # ~/.bashrc — what every nvm install does — is simply not there, and this
  # shim answered 127 for a claude that is installed and works in every
  # interactive pane.
  #
  # So ask an interactive shell what its PATH is, once, and only after the
  # ordinary lookup has already failed: the same file the interactive pane
  # sources, read here without its output reaching anyone. Startup chatter
  # cannot be mistaken for the answer — the marker line is the only thing read,
  # its leading newline starts it even after an unterminated banner, and the
  # LAST match wins so a .bashrc that echoes the marker itself cannot win over
  # the real one. stdin is closed so a prompt in a startup file cannot hang the
  # pane.
  #
  # BOUNDED. Closing stdin stops a startup file that READS from the terminal,
  # but not one that waits on something else — a network call, a lock, a sleep —
  # and an unbounded substitution here would hang the exec pane instead of
  # reaching the honest 127 below (review: CodeRabbit). A timeout leaves
  # login_path empty, which is exactly the not-found path.
  #
  # -k, because the plain TERM is not a bound here: an INTERACTIVE bash ignores
  # SIGTERM. Measured — it aborts whatever the startup file is waiting on and
  # carries on to the end, which happens to answer, but a startup file that
  # blocks again would keep the pane hanging on a timeout that already fired.
  # The follow-up KILL cannot be ignored, so the lookup ends either way.
  # \`timeout\` is coreutils and present on every distro wmux supports; where it
  # somehow is not, the lookup still runs, because an unbounded best effort
  # beats telling the user their installed claude does not exist.
  wmux_bash=/bin/bash
  command -v timeout >/dev/null 2>&1 && wmux_bash="timeout -k 1 10 /bin/bash"
  # #1721 — and in its OWN session. timeout runs bash in a background process
  # group; with a controlling terminal, which every real pane has, the
  # interactive bash finds itself outside the terminal's foreground group, is
  # stopped (SIGTTIN/SIGTTOU), and sits there until the KILL above. Measured in
  # a WSL pane: 11 s, then the 127 below for a claude that is installed. With
  # no controlling terminal there is nothing to take, and /dev/tty is gone.
  # setsid outside timeout: if setsid has to fork, timeout still bounds bash.
  # util-linux and busybox both ship setsid; without it, behave as before.
  command -v setsid >/dev/null 2>&1 && wmux_bash="setsid $wmux_bash"
  # Unquoted on purpose: wmux_bash is a command plus its arguments.
  # shellcheck disable=SC2086
  login_path=$($wmux_bash -ic 'printf "\\nWMUX_RESOLVED_PATH=%s\\n" "$PATH"' </dev/null 2>/dev/null \
    | sed -n 's/^WMUX_RESOLVED_PATH=//p' | tail -n 1)
  if [ -n "$login_path" ]; then
    strip_shim "$login_path"
    real=$(PATH="$clean" command -v claude)
  fi
fi
if [ -z "$real" ]; then
  printf '%s\\n' 'wmux: claude is not installed in this WSL distribution' >&2
  exit 127
fi
# Retain the pane PATH for subprocesses; only command lookup excludes the shim.
# A launch that names its own servers (--strict-mcp-config: a bot's worker,
# main/agents/botWorkerMergeGuard.ts) keeps them alone. Only its options
# count: the scan stops at --, where the prompt starts.
mcp_config=\${WMUX_WSL_MCP_CONFIG:-}
for arg in "$@"; do
  case $arg in --) break ;; --strict-mcp-config) mcp_config= ;; esac
done
# --mcp-config is variadic: the = form keeps it from swallowing a prompt argument.
exec "$real" --settings "$WMUX_WSL_SETTINGS" \${mcp_config:+--mcp-config="$mcp_config"} "$@"
`;

/**
 * #2231 — a fan-out task worktree on a Windows drive, worked on by Linux git.
 * Git for Windows wrote its `.git` file as `gitdir: D:/…`, which Linux git
 * reads as a relative path, so every git command in the worker failed. Main
 * hands the pane the gitdir and the worktree as Linux paths
 * (`WMUX_WSL_GIT_DIR`, `WMUX_WSL_GIT_WORK_TREE`; main/agents/wslWorkerGit.ts)
 * and they become GIT_DIR / GIT_WORK_TREE here, inside Linux only: nothing is
 * written to the repository, and no Windows process started from the pane
 * inherits them. `WMUX_WSL_GIT_AUTOCRLF` carries Git for Windows' effective
 * core.autocrlf (its system config sets `true`, so the worktree is checked out
 * with CRLF and Linux git without it reads every text file as modified); it is
 * appended to the GIT_CONFIG_COUNT list the user's startup files left, never
 * written over it. With it go `core.filemode=false` (drvfs reads every file as
 * 0777, so Linux git saw a mode change on every file and committed new ones
 * as executable) and Git for Windows' own `user.name` / `user.email` when set
 * (`WMUX_WSL_GIT_FILEMODE`, `WMUX_WSL_GIT_USER_NAME`, `WMUX_WSL_GIT_USER_EMAIL`).
 * After the user's rc files, so they cannot undo it.
 */
export const WSL_TASK_GIT_ENV = `# A task worktree on a Windows drive: its gitdir by Linux paths (#2231).
if [ -n "\${WMUX_WSL_GIT_DIR:-}" ] && [ -n "\${WMUX_WSL_GIT_WORK_TREE:-}" ]; then
  export GIT_DIR="$WMUX_WSL_GIT_DIR" GIT_WORK_TREE="$WMUX_WSL_GIT_WORK_TREE"
  # One git setting, appended to the GIT_CONFIG_COUNT list; an empty value adds nothing.
  __wmux_git_config() {
    [ -n "$2" ] || return 0
    __wmux_n=\${GIT_CONFIG_COUNT:-0}
    case "$__wmux_n" in ''|*[!0-9]*) __wmux_n=0 ;; esac
    export "GIT_CONFIG_KEY_$__wmux_n=$1" "GIT_CONFIG_VALUE_$__wmux_n=$2" "GIT_CONFIG_COUNT=$((__wmux_n + 1))"
    unset __wmux_n
  }
  __wmux_git_config core.autocrlf "\${WMUX_WSL_GIT_AUTOCRLF:-}"
  __wmux_git_config core.filemode "\${WMUX_WSL_GIT_FILEMODE:-}"
  __wmux_git_config user.name "\${WMUX_WSL_GIT_USER_NAME:-}"
  __wmux_git_config user.email "\${WMUX_WSL_GIT_USER_EMAIL:-}"
  unset -f __wmux_git_config
fi`;

/**
 * Every variable buildWslInjection sets for a bound account. It drops them all
 * before redoing them, and a caller merging the result into a replayed env
 * must drop the ones the result leaves out (DaemonSessionManager).
 */
export const WSL_ACCOUNT_INJECTED_VARS: readonly string[] = [
  'WMUX_WSL_ACCOUNT_CLAUDE', 'WMUX_WSL_ACCOUNT_CLAUDE_SHARE', 'WMUX_WSL_ACCOUNT_CODEX', 'WMUX_WSL_ACCOUNT_CODEX_SHARE',
  'WMUX_WSL_ACCOUNT_SH', WSL_ACCOUNT_DISTRO_ENV,
];

const shareList = (vendor: AccountVendor, kind: 'linkDirs' | 'copyFiles') => ACCOUNT_SHARE_MANIFEST[vendor][kind].join(' ');

/**
 * Sourced by bash before the command (exec), and twice in an interactive pane:
 * `quiet` before the user's startup files, so one that execs zsh or tmux still
 * hands the variables on, then `interactive` after them, so they win over an
 * export there. Each account the pane runs gets its own home in this distro
 * (shared/wslAccountHome.ts), exported as CLAUDE_CONFIG_DIR / CODEX_HOME. A new
 * home with sharing on mirrors the distro's own default folder, never the
 * Windows one. With no sign-in there yet, the `interactive` pass says so once
 * per start, an exec run logs it instead of writing into the command's output,
 * and `quiet` says nothing. A home that cannot be made returns 1: the exec
 * bootstrap exits, an interactive shell says so and stays on the default account.
 */
export const WSL_ACCOUNT_SH = `# wmux: a bound workspace's agent accounts, each with its own home in this distro.
__wmux_account_home() {
  __wmux_vendor=$1 __wmux_key=$2 __wmux_share=$3 __wmux_var=$4 __wmux_mode=$5
  case "$__wmux_key" in ''|*[!0-9a-f]*) return 0 ;; esac
  case "\${WMUX_DATA_SUFFIX:-}" in *[!A-Za-z0-9._-]*|*..*)
    printf 'wmux: the data suffix "%s" cannot name a folder, so this pane does not use its %s account.\\n' "$WMUX_DATA_SUFFIX" "$__wmux_vendor" >&2
    return 1 ;;
  esac
  __wmux_root="$HOME/.wmux\${WMUX_DATA_SUFFIX:-}/accounts"
  __wmux_home="$__wmux_root/$__wmux_vendor-$__wmux_key"
  # A home exists only complete: it is seeded in a private folder beside it and
  # renamed into place, so a pane starting at the same moment never runs on a
  # half-mirrored one. A pane that loses the race drops its seed and uses the
  # winner's home; an existing home is never written again.
  if [ ! -d "$__wmux_home" ]; then
    __wmux_seed=$( (umask 077 && mkdir -p "$__wmux_root" && mktemp -d "$__wmux_root/.seed-$__wmux_vendor-XXXXXX") 2>/dev/null )
    if [ -z "$__wmux_seed" ]; then
      printf 'wmux: cannot create %s, so this pane does not use its %s account.\\n' "$__wmux_home" "$__wmux_vendor" >&2
      return 1
    fi
    if [ "$__wmux_share" = 1 ]; then
      if [ "$__wmux_vendor" = codex ]; then
        __wmux_src="$HOME/.codex" __wmux_links="${shareList('codex', 'linkDirs')}" __wmux_copies="${shareList('codex', 'copyFiles')}"
      else
        __wmux_src="$HOME/.claude" __wmux_links="${shareList('claude', 'linkDirs')}" __wmux_copies="${shareList('claude', 'copyFiles')}"
      fi
      for __wmux_name in $__wmux_links; do
        [ ! -e "$__wmux_src/$__wmux_name" ] || ln -sn "$__wmux_src/$__wmux_name" "$__wmux_seed/$__wmux_name" 2>/dev/null
      done
      for __wmux_name in $__wmux_copies; do
        [ ! -f "$__wmux_src/$__wmux_name" ] || cp "$__wmux_src/$__wmux_name" "$__wmux_seed/$__wmux_name" 2>/dev/null
      done
    fi
    # mv renames onto a missing name; onto a home that appeared meanwhile it
    # moves the seed inside instead, which the check below takes back out.
    __wmux_name=\${__wmux_seed##*/}
    mv "$__wmux_seed" "$__wmux_home" 2>/dev/null
    rm -rf -- "$__wmux_seed" "$__wmux_home/$__wmux_name" 2>/dev/null
    if [ ! -d "$__wmux_home" ]; then
      printf 'wmux: cannot create %s, so this pane does not use its %s account.\\n' "$__wmux_home" "$__wmux_vendor" >&2
      return 1
    fi
  fi
  if [ "$__wmux_vendor" = codex ]; then __wmux_login=auth.json __wmux_how="codex login"; else __wmux_login=.credentials.json __wmux_how="/login in claude"; fi
  if [ ! -e "$__wmux_home/$__wmux_login" ]; then
    __wmux_note="wmux: this pane's $__wmux_vendor account has no sign-in in this WSL distro yet; signing in here ($__wmux_how) signs in this account only, other panes keep theirs."
    if [ "$__wmux_mode" = interactive ]; then
      printf '%s\\n' "$__wmux_note" >&2
    elif [ "$__wmux_mode" = exec ]; then
      printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$__wmux_note" >> "$__wmux_root/notices.log" 2>/dev/null
    fi
  fi
  export "$__wmux_var=$__wmux_home"
}
__wmux_account_rc=0
[ -z "\${WMUX_WSL_ACCOUNT_CLAUDE:-}" ] || __wmux_account_home claude "$WMUX_WSL_ACCOUNT_CLAUDE" "\${WMUX_WSL_ACCOUNT_CLAUDE_SHARE:-}" CLAUDE_CONFIG_DIR "\${1:-interactive}" || __wmux_account_rc=1
[ -z "\${WMUX_WSL_ACCOUNT_CODEX:-}" ] || __wmux_account_home codex "$WMUX_WSL_ACCOUNT_CODEX" "\${WMUX_WSL_ACCOUNT_CODEX_SHARE:-}" CODEX_HOME "\${1:-interactive}" || __wmux_account_rc=1
unset -f __wmux_account_home
unset __wmux_vendor __wmux_key __wmux_share __wmux_var __wmux_mode __wmux_root __wmux_home __wmux_seed __wmux_src __wmux_links __wmux_copies __wmux_name __wmux_login __wmux_how __wmux_note
eval "unset __wmux_account_rc; return $__wmux_account_rc"
`;

/** Where buildWslInjection keeps WSL_ACCOUNT_SH, written (0700) when missing or stale. */
export function ensureWslAccountScript(integrationDir: string): string {
  const dir = path.join(integrationDir, 'wsl');
  const file = path.join(dir, 'account.sh');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== WSL_ACCOUNT_SH) fs.writeFileSync(file, WSL_ACCOUNT_SH, { mode: 0o700 });
  return file;
}

/** WSL_ACCOUNT_COPY_SH's exit codes; any other exit is a failure. */
export const WSL_ACCOUNT_COPY_EXIT = { copied: 10, same: 11, diverged: 12 } as const;

/**
 * "Continue on another account" in a WSL pane: copy the pane's transcript into
 * the target account's home in this distro, as the pane's own user. Run as
 * `bash --noprofile --norc -c WSL_ACCOUNT_COPY_SH wmux-copy <key> <share 0|1>
 * <data suffix> <source> <project> <session id>`, with WMUX_WSL_ACCOUNT_SH (the
 * account script, a /p WSLENV path). The home is made by WSL_ACCOUNT_SH itself,
 * exactly as a pane's spawn makes it (private, seeded, renamed into place).
 *
 * Prints the home it used on one line, then exits with WSL_ACCOUNT_COPY_EXIT:
 * `same` when the target project folder is the source's own (a rename there
 * would replace the original), `diverged` when the target already holds turns
 * the source lacks (it may hold an earlier state of the same file: A → B → A).
 * The copy goes through a temp file in the target folder and a rename. The
 * conversation's sibling folder (`<session id>/`) is copied without
 * overwriting anything, as copyTranscript does on Windows.
 */
export const WSL_ACCOUNT_COPY_SH = `umask 077
key=$1 share=$2 suffix=$3 src=$4 project=$5 id=$6
case "$key" in ''|*[!0-9a-f]*) exit 1 ;; esac
case "$id" in ''|*[!0-9A-Za-z-]*) exit 1 ;; esac
case "$project" in ''|.|..|*/*) exit 1 ;; esac
case "$src" in /*) ;; *) exit 1 ;; esac
[ -f "$src" ] && [ ! -L "$src" ] || exit 1
[ -n "\${WMUX_WSL_ACCOUNT_SH:-}" ] && [ -r "$WMUX_WSL_ACCOUNT_SH" ] || exit 1
unset CLAUDE_CONFIG_DIR WMUX_WSL_ACCOUNT_CODEX WMUX_WSL_ACCOUNT_CLAUDE_SHARE
export WMUX_WSL_ACCOUNT_CLAUDE="$key" WMUX_DATA_SUFFIX="$suffix"
[ "$share" != 1 ] || export WMUX_WSL_ACCOUNT_CLAUDE_SHARE=1
. "$WMUX_WSL_ACCOUNT_SH" quiet || exit 1
home=\${CLAUDE_CONFIG_DIR:-}
[ -n "$home" ] && [ -d "$home" ] || exit 1
printf '%s\\n' "$home"
dir="$home/projects/$project"
mkdir -p -- "$dir" || exit 1
real() { (builtin cd -P -- "$1" 2>/dev/null && pwd -P); }
[ "$(real "$dir")" != "$(real "\${src%/*}")" ] || exit ${WSL_ACCOUNT_COPY_EXIT.same}
target="$dir/$id.jsonl"
if [ -e "$target" ] || [ -L "$target" ]; then
  [ -f "$target" ] && [ ! -L "$target" ] || exit 1
  have=$(($(wc -c < "$target"))) || exit 1
  want=$(($(wc -c < "$src"))) || exit 1
  [ "$have" -le "$want" ] || exit ${WSL_ACCOUNT_COPY_EXIT.diverged}
  head -c "$have" -- "$src" | cmp -s -- - "$target" || exit ${WSL_ACCOUNT_COPY_EXIT.diverged}
fi
tmp=$(mktemp "$dir/.wmux-copy.XXXXXX") || exit 1
trap '[ -z "$tmp" ] || rm -f -- "$tmp"' EXIT
cp -- "$src" "$tmp" && mv -f -- "$tmp" "$target" || exit 1
tmp=
sib=\${src%.jsonl}
if [ -d "$sib" ] && [ ! -L "$sib" ]; then
  mkdir -p -- "$dir/$id" && cp -R -n -- "$sib/." "$dir/$id/" 2>/dev/null
fi
exit ${WSL_ACCOUNT_COPY_EXIT.copied}
`;

export const WSL_CODEX_HOOK = `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
export WSLENV="\${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE/w"
# The Windows bridge cannot see the Linux Codex that spawned this script: a
# TUI, or a shared app-server that kept another pane's environment (#1523).
# Hand it that argv as /proc holds it, each argument's NUL terminator turned
# into U+001F (an environment value cannot hold NUL); the bridge decides.
if [ -r "/proc/$PPID/cmdline" ]; then
  WMUX_CODEX_NOTIFIER_ARGV=$(tr '\\0' '\\037' < "/proc/$PPID/cmdline" | head -c 4096)
  export WMUX_CODEX_NOTIFIER_ARGV
  export WSLENV="$WSLENV:WMUX_CODEX_NOTIFIER_ARGV/w"
fi
# #1727 — which Linux process this pane's Codex is, as Claude's WSL_HOOK
# reports it; run only for the notification the bridge will actually get
# (below). The bridge refuses a shared app-server's notification outright, so
# a report only ever comes from the Codex that owns this pane.
${WSL_AGENT_PROC_FN}
# Codex also notifies for temporary title-generation and subagent threads.
# Only a saved top-level CLI session is a valid Resume target. Match the exact
# reported UUID and inspect its first metadata record; never guess the newest.
# thread/revert keeps the thread ID but writes rollout-<ts>-<id>_<rollout>.jsonl.
# The payload carries the turn's full input and answer. A Windows command line
# holds ~32K characters, so it goes over stdin and only the fields the bridge
# reads are passed on as argv.
notification=$(printf '%s' "\${1:-}" | "$WMUX_WSL_NODE" "$WMUX_WSL_CODEX_CONFIG" --notification) || exit 0
id=$(printf '%s\n' "$notification" | sed -n 1p)
payload=$(printf '%s\n' "$notification" | sed -n 2p)
for file in "\${CODEX_HOME:-$HOME/.codex}"/sessions/*/*/*/rollout-*-"$id".jsonl \
    "\${CODEX_HOME:-$HOME/.codex}"/sessions/*/*/*/rollout-*-"$id"_*.jsonl; do
  [ -f "$file" ] || continue
  IFS= read -r metadata < "$file" || continue
  if printf '%s' "$metadata" | "$WMUX_WSL_NODE" "$WMUX_WSL_CODEX_CONFIG" --is-resumable "$id"; then
    wmux_agent_proc
    export WMUX_WSL_AGENT_PROC
    export WSLENV="$WSLENV:WMUX_WSL_AGENT_PROC/w"
    exec "$WMUX_WSL_NODE" "$WMUX_WSL_CODEX_BRIDGE" "$payload"
  fi
done
exit 0
`;

// The MCP server runs in the Windows runtime, like the hook bridge: named-pipe
// auth, CDP on Windows loopback and Playwright all stay where they already work.
// One interop spawn per agent session, never per tool call. The server also
// learns which distro called it and where Windows drives are mounted (`wslpath
// -u 'C:\'`, e.g. /mnt/c/), so file tools can speak the agent's paths.
const WSL_MCP_ENV = 'export ELECTRON_RUN_AS_NODE=1 WMUX_WSL_DISTRO="$WSL_DISTRO_NAME"'
  + ' WMUX_WSL_MOUNT="$(wslpath -u \'C:\\\' 2>/dev/null)"'
  + ' WSLENV="${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE/w:WMUX_WSL_DISTRO/w:WMUX_WSL_MOUNT/w";';
export const WSL_MCP_LAUNCH = `${WSL_MCP_ENV} exec "$WMUX_WSL_NODE" "$WMUX_WSL_MCP"`;

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** WSL_MCP_LAUNCH for one named server: `runtime` is the Windows runtime as
 *  Linux reaches it (/mnt/…), `entry` the bundle as that runtime reads it
 *  (a Windows path). Pure. */
export function wslMcpLaunchOf(runtime: string, entry: string, args: readonly string[] = []): string {
  return `${WSL_MCP_ENV} exec ${[runtime, entry, ...args].map(shellQuote).join(' ')}`;
}
// Codex gets the same server through -c. JSON string syntax is valid TOML.
// Codex starts MCP servers with a sanitized environment (PATH, HOME, ...), so
// the shim appends env={...} with the pane's own values as literal strings.
// 30 s, not Codex's 10 s default: a cold Electron start over interop can take
// longer on Windows machines that scan every launch (antivirus, endpoint scanning).
const WSL_CODEX_MCP = `mcp_servers.wmux={command="/bin/sh",args=["-c",${JSON.stringify(WSL_MCP_LAUNCH)}],startup_timeout_sec=30`;

export const WSL_CODEX_SHIM = `#!/bin/bash
old_ifs=$IFS
IFS=:
clean=
for entry in $PATH; do
  [ "$entry" = "$WMUX_WSL_BIN" ] && continue
  clean="\${clean:+$clean:}$entry"
done
IFS=$old_ifs
real=$(PATH="$clean" command -v codex) || {
  printf '%s\\n' 'wmux: codex is not installed in this WSL distribution' >&2
  exit 127
}
if [ "\${WMUX_SHELL_INTEGRATION:-1}" = 0 ]; then exec "$real" "$@"; fi
# Scan the actual launch directory, including Codex's --cd override. No
# startup files or user commands are evaluated to inspect configuration.
launch_dir=$PWD
server_mode=
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  case "\${args[i]}" in
    --) break ;;
    app-server|mcp-server|remote-control|exec-server) server_mode=1 ;;
    -C|--cd) ((i++)); launch_dir=\${args[i]:-} ;;
    --cd=*) launch_dir=\${args[i]#--cd=} ;;
    -C?*) launch_dir=\${args[i]#-C} ;;
  esac
done
collect_configs() {
  local root file
  root=$(cd -- "$launch_dir" 2>/dev/null && pwd -P) || { printf 'invalid config'; return; }
  for file in /etc/codex/config.toml /etc/codex/managed_config.toml \
      "\${CODEX_HOME:-$HOME/.codex}/config.toml" "\${CODEX_HOME:-$HOME/.codex}"/*.config.toml; do
    if [ -e "$file" ]; then cat -- "$file" || printf 'invalid config'; printf '\\0'; fi
  done
  while :; do
    file="$root/.codex/config.toml"
    if [ -e "$file" ]; then cat -- "$file" || printf 'invalid config'; printf '\\0'; fi
    [ "$root" = / ] && break
    root=\${root%/*}; [ -n "$root" ] || root=/
  done
}
# Only this short-lived helper needs Electron's Node mode. Do not leak it to
# Codex or other Linux applications. It never runs on the daemon event loop.
# Bounded like the Claude shim's PATH lookup: a stalled interop call falls back
# to launching Codex unchanged instead of hanging the launch. 30 s, the MCP
# server's own startup budget: on antivirus-scanned machines this helper is the same
# cold Electron start, and a timeout here drops notify and MCP together.
wmux_guard=
command -v timeout >/dev/null 2>&1 && wmux_guard="timeout -k 1 30"
# The helper prints one line per key that no configuration layer owns.
free=$(collect_configs | ELECTRON_RUN_AS_NODE=1 \
  WSLENV="\${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE/w" \
  $wmux_guard "$WMUX_WSL_NODE" "$WMUX_WSL_CODEX_CONFIG" "$WMUX_WSL_CODEX_HOOK" "$@")
[ $? = 0 ] || free=
notify= mcp=
while IFS= read -r line; do
  case $line in notify=*) notify=$line ;; mcp) mcp=1 ;; esac
done <<< "$free"
overrides=()
[ -z "$notify" ] || overrides+=(-c "$notify")
# Server modes may serve other panes; never stamp this pane's identity on them.
# remote-control starts the shared app-server daemon; exec-server is a
# standalone service (both Codex 0.160+, both take -c).
# Global options may precede the subcommand (codex -c k=v app-server). Any
# matching word before -- counts: a false match only skips MCP, which is safe.
[ -z "$server_mode" ] || mcp=
if [ -n "$mcp" ] && [ -n "\${WMUX_WSL_MCP:-}" ]; then
  # TOML literal strings keep Windows backslashes as-is but cannot hold a
  # quote or control character. Codex refuses to start on an override it
  # cannot parse, so any such value skips the server instead.
  mcp_env=
  for name in WMUX_WSL_NODE WMUX_WSL_MCP WMUX_PTY_ID WMUX_WORKSPACE_ID WMUX_SURFACE_ID \
      WMUX_DATA_SUFFIX WSLENV WSL_DISTRO_NAME WSL_INTEROP; do
    [ -n "\${!name+set}" ] || continue
    case \${!name} in *"'"*|*[[:cntrl:]]*) mcp=; break ;; esac
    mcp_env="\${mcp_env:+$mcp_env,}$name='\${!name}'"
  done
  if [ -n "$mcp" ]; then
    overrides+=(-c ${shellQuote(WSL_CODEX_MCP)}",env={$mcp_env}}")
  else
    printf '%s\\n' 'wmux: wmux MCP server not mounted (a pane value cannot be passed to Codex safely); launching Codex without it.' >&2
  fi
fi
if [ -z "$notify" ]; then
  # Without notify, overrides holds only the MCP server, if it was mounted.
  if [ \${#overrides[@]} = 0 ]; then
    printf '%s\\n' 'wmux: Codex resume capture not injected (existing notify, unreadable configuration, or unavailable bridge); launching Codex unchanged.' >&2
  else
    printf '%s\\n' 'wmux: Codex resume capture not injected (existing notify, unreadable configuration, or unavailable bridge); launching Codex with only the wmux MCP server added.' >&2
  fi
fi
exec "$real" "\${overrides[@]}" "$@"
`;

function findUp(startDir: string, rels: string[]): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    for (const rel of rels) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findBridge(startDir: string, basename = 'wmux-bridge.mjs', agent = 'claude'): string {
  const found = findUp(startDir, [`cli-bundle/${basename}`, `integrations/${agent}/bin/${basename}`, `dist/cli-bundle/${basename}`]);
  if (!found) throw new Error(`WSL integration: bundled ${agent} bridge ${basename} is missing`);
  return found;
}

/**
 * The Claude bridge a WSL pane's hook runs, or null when it is missing: the
 * same lookup, so the global WSL hook (shared/wslGlobalHook.ts) and a pane's
 * hook always run the same file — one outside app.asar, which Linux can open.
 */
export function findWslClaudeBridge(startDir: string): string | null {
  try {
    return findBridge(startDir);
  } catch {
    return null;
  }
}

/**
 * #1730 — the daemon keeps this file in its data dir exactly while the
 * permission gate can be answered; the WSL hook checks it before paying for a
 * Windows process (WSL_HOOK). It carries no authority: the daemon still decides.
 */
export const WSL_GATE_FLAG_FILE = 'gate-armed';

/**
 * The hooks a WSL claude runs, per launch. The same events and matchers as a
 * Windows pane's (src/cli/commands/setupHooks.ts), each through hook.sh: the
 * lifecycle and human-paced ones (prompt, subagent, dialog, question) plus
 * the wide permission gate, which hook.sh short-circuits unless armed. The
 * wide PostToolUse activity hook stays out here as it does on Windows.
 */
export function wslClaudeHooks(): Record<string, Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> }>> {
  const hook = (event: string, matcher = '', extra = '', timeout = 10) => ({
    matcher,
    hooks: [{ type: 'command' as const, command: `/bin/sh "$WMUX_WSL_HOOK" ${event}${extra ? ` ${extra}` : ''}`, timeout }],
  });
  return {
    SessionStart: [hook('SessionStart')],
    SessionEnd: [hook('SessionEnd')],
    Stop: [hook('Stop')],
    StopFailure: [hook('StopFailure')],
    SubagentStop: [hook('SubagentStop')],
    UserPromptSubmit: [hook('UserPromptSubmit')],
    PermissionRequest: [hook('PermissionRequest')],
    Notification: [hook('Notification', 'permission_prompt')],
    PostToolUse: [hook('PostToolUse', 'AskUserQuestion')],
    PreToolUse: [
      hook('PreToolUse', 'AskUserQuestion'),
      // The broker self-defers at 120 s and the bridge gives up at 130 s.
      hook('PreToolUse', '', '--permission-gate', 150),
    ],
  };
}

function wslMcpConfig(): string {
  return JSON.stringify({ mcpServers: { wmux: { type: 'stdio', command: '/bin/sh', args: ['-c', WSL_MCP_LAUNCH] } } });
}

/**
 * The WSLENV flags that carry a login tab's account home into `distribution`,
 * or null when WSL cannot translate it. A drive path and a UNC path into this
 * same distro (`\\wsl.localhost\<distro>\…`, `\\wsl$\<distro>\…`) translate;
 * another distro's or a network share's UNC path does not, and WSL would drop
 * the variable. Anything else is passed through as a Linux path.
 */
export function accountHomeWslFlags(home: string, distribution: string): 'pu' | 'u' | null {
  if (/^[a-z]:[\\/]/i.test(home)) return 'pu';
  if (!/^[\\/]{2}/.test(home)) return 'u';
  const unc = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/]|$)/i.exec(home);
  return unc && unc[2].toLowerCase() === distribution.toLowerCase() ? 'pu' : null;
}

export function buildWslInjection(options: {
  target: WslTarget;
  cwd: string;
  env: Record<string, string>;
  integrationDir: string;
  bashInit: string;
  execCommand?: string;
  /** Only account-login tabs opt into Windows account-home transport. */
  wslAccountLoginEnvKey?: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
  runtimePath?: string;
  bridgePath?: string;
  codexBridgePath?: string;
  codexConfigPath?: string;
  /** Windows MCP entry; null skips MCP. Missing bundle also skips, never fails the pane. */
  mcpEntryPath?: string | null;
}): { args: string[]; env: Record<string, string> } {
  const { target, cwd, integrationDir } = options;
  const dir = path.join(integrationDir, 'wsl');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const write = (file: string, text: string) => {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text, { mode: 0o700 });
  };
  write(path.join(dir, 'hook.sh'), WSL_HOOK);
  write(path.join(bin, 'claude'), WSL_CLAUDE_SHIM);
  write(path.join(dir, 'codex-hook.sh'), WSL_CODEX_HOOK);
  write(path.join(bin, 'codex'), WSL_CODEX_SHIM);
  write(path.join(dir, 'claude-settings.json'), JSON.stringify({ hooks: wslClaudeHooks() }));
  const mcpEntry = options.mcpEntryPath === undefined
    ? findUp(__dirname, ['mcp-bundle/index.js', 'dist/mcp/mcp/entry.js'])
    : options.mcpEntryPath;
  if (mcpEntry) write(path.join(dir, 'claude-mcp.json'), wslMcpConfig());
  write(path.join(dir, 'bashrc.integration'), options.bashInit);
  write(path.join(dir, 'bashrc'), `
# The pane's accounts, before the user's startup files: one that execs zsh or
# tmux still hands them on. A pane that has accounts but cannot reach their
# script says so instead of running on the distro's default account unnoticed.
__wmux_accounts=
if [ -n "\${WMUX_WSL_ACCOUNT_CLAUDE:-}\${WMUX_WSL_ACCOUNT_CODEX:-}" ]; then
  if [ -z "\${WMUX_WSL_ACCOUNT_SH:-}" ] || [ ! -r "$WMUX_WSL_ACCOUNT_SH" ]; then
    printf 'wmux: this pane cannot reach its account script from this WSL distro, so it runs on the default account here; signing in here would sign in the default account.\\n' >&2
  elif . "$WMUX_WSL_ACCOUNT_SH" quiet; then
    __wmux_accounts=1
  fi
fi
# Keep the user's shell setup even when wmux hooks are disabled.
if [ "\${WMUX_SHELL_INTEGRATION:-1}" = 0 ]; then
  [ ! -r "$HOME/.bashrc" ] || . "$HOME/.bashrc"
else
  . "$WMUX_WSL_BASHRC.integration"
fi
# A login tab whose selected account folder this distro cannot open: say so
# instead of letting the login land in the default home unnoticed.
if [ -n "$WMUX_WSL_ACCOUNT_HOME_UNREACHABLE" ]; then
  printf 'wmux: %s cannot be opened from this WSL distro, so this login will not be saved to the selected account. Use an account folder on a local drive or inside this distro.\\n' "$WMUX_WSL_ACCOUNT_HOME_UNREACHABLE" >&2
fi
# And again after them, so they win over an export there; this pass prints the first-use line.
[ -z "$__wmux_accounts" ] || . "$WMUX_WSL_ACCOUNT_SH" interactive
unset __wmux_accounts
${WSL_TASK_GIT_ENV}
# An explicit workspace directory wins over a cd in the user's startup files.
if [ -z "$WMUX_WSL_CWD" ] || ! builtin cd -- "$WMUX_WSL_CWD"; then
  printf 'wmux: cannot enter WSL directory "%s"; check the directory and WSLENV transport, then retry.\\n' "$WMUX_WSL_CWD" >&2
  exit 1
fi
# Only wmux panes see the shims. Existing agent configuration is retained.
if [ "\${WMUX_SHELL_INTEGRATION:-1}" != 0 ]; then
  export PATH="$WMUX_WSL_BIN:$PATH"
fi
`);
  const env: Record<string, string> = { ...options.env,
    WMUX_WSL_CWD: cwd,
    WMUX_WSL_NODE: options.runtimePath ?? process.execPath,
    WMUX_WSL_BRIDGE: options.bridgePath ?? findBridge(__dirname),
    WMUX_WSL_CODEX_BRIDGE: options.codexBridgePath ?? findBridge(__dirname, 'wmux-codex-notify.mjs', 'codex'),
    WMUX_WSL_CODEX_CONFIG: options.codexConfigPath ?? findBridge(__dirname, 'wmux-wsl-codex-config.mjs', 'codex'),
    WMUX_WSL_CODEX_HOOK: path.join(dir, 'codex-hook.sh'),
    WMUX_WSL_HOOK: path.join(dir, 'hook.sh'),
    WMUX_WSL_GATE_FLAG: path.join(integrationDir, WSL_GATE_FLAG_FILE),
    WMUX_WSL_SETTINGS: path.join(dir, 'claude-settings.json'),
    WMUX_WSL_BIN: bin,
    WMUX_WSL_BASHRC: path.join(dir, 'bashrc'),
    ...(mcpEntry ? { WMUX_WSL_MCP: mcpEntry, WMUX_WSL_MCP_CONFIG: path.join(dir, 'claude-mcp.json') } : {}),
  };
  const entries = [
    'WMUX_PTY_ID', 'WMUX_WORKSPACE_ID', 'WMUX_SURFACE_ID', 'WMUX_DATA_SUFFIX',
    'WMUX_WSL_NODE/p', 'WMUX_WSL_BRIDGE/u', 'WMUX_WSL_HOOK/p', 'WMUX_WSL_GATE_FLAG/p',
    'WMUX_WSL_CODEX_BRIDGE/u', 'WMUX_WSL_CODEX_CONFIG/u', 'WMUX_WSL_CODEX_HOOK/p',
    'WMUX_WSL_CWD/u', 'WMUX_WSL_SETTINGS/p', 'WMUX_WSL_BIN/p', 'WMUX_WSL_BASHRC/p', 'WMUX_SHELL_INTEGRATION',
    ...(mcpEntry ? ['WMUX_WSL_MCP/u', 'WMUX_WSL_MCP_CONFIG/p'] : []),
    // A fan-out or automation pane's claude skips the workspace-trust dialog
    // (shared/agentFirstRun.ts CLAUDE_SANDBOXED_ENV). wsl.exe passes only the
    // variables WSLENV names, so without this Linux claude in a WSL task pane
    // stopped on "Is this a project you created or one you trust?" (#2231).
    // Only a pane that carries it: an ordinary WSL pane keeps the dialog.
    ...(options.env.CLAUDE_CODE_SANDBOXED ? ['CLAUDE_CODE_SANDBOXED/u'] : []),
    // The same worker pane's DISABLE_AUTOUPDATER (main/worktask/fanoutEnvironment.ts
    // workerAutoUpdateEnv), so Linux claude in it does not update the launcher
    // either. Only beside the worker marker: an ordinary WSL pane's env is not sent.
    ...(options.env.CLAUDE_CODE_SANDBOXED && options.env.DISABLE_AUTOUPDATER !== undefined ? ['DISABLE_AUTOUPDATER/u'] : []),
    // The Claude file send setting (shared/claudeFileSend.ts), when it is on.
    ...(options.env[CLAUDE_FILE_SEND_ENV] ? [`${CLAUDE_FILE_SEND_ENV}/u`] : []),
  ];
  // Ordinary WSL panes keep their Linux profiles: copied Windows config can
  // contain Windows-only notify/MCP/hooks. Only forward the login's vendor.
  const loginKey = options.wslAccountLoginEnvKey;
  // A bound workspace's accounts get their own home in the distro instead
  // (shared/wslAccountHome.ts): the Windows folder never crosses over, only
  // its key. A login tab's own variable stays the Windows folder (above).
  // Recomputed on every spawn, so a recovered pane's replayed env is redone.
  for (const name of WSL_ACCOUNT_INJECTED_VARS) delete env[name];
  // And their WSLENV names a replayed env still lists: only this spawn's go back in.
  if (env.WSLENV) env.WSLENV = env.WSLENV.split(':').filter((entry) => !WSL_ACCOUNT_INJECTED_VARS.includes(entry.split('/')[0].toUpperCase())).join(':');
  let accountHomes = false;
  for (const key of parseWslAccountKeys(env[WSL_ACCOUNT_KEYS_ENV])) {
    const folder = env[key];
    if (!folder || key === loginKey) continue;
    const vendor = ACCOUNT_ENV_VENDOR[key];
    const name = `WMUX_WSL_ACCOUNT_${vendor.toUpperCase()}`;
    env[name] = wslAccountHomeKey(folder);
    entries.push(name);
    if (accountFolderShares(folder, vendor)) {
      env[`${name}_SHARE`] = '1';
      entries.push(`${name}_SHARE`);
    }
    accountHomes = true;
  }
  if (accountHomes) {
    write(path.join(dir, 'account.sh'), WSL_ACCOUNT_SH);
    env.WMUX_WSL_ACCOUNT_SH = path.join(dir, 'account.sh');
    // Kept on the pane's env only (not in WSLENV): its sign-in key names the distro (shared/wslAccountMark.ts).
    env[WSL_ACCOUNT_DISTRO_ENV] = target.distribution;
    entries.push('WMUX_WSL_ACCOUNT_SH/p');
  }
  const home = loginKey ? env[loginKey] : undefined;
  let unreachableKey: string | null = null;
  if ((loginKey === 'CODEX_HOME' || loginKey === 'CLAUDE_CONFIG_DIR') && home) {
    const flags = accountHomeWslFlags(home, target.distribution);
    if (flags) {
      entries.push(`${loginKey}/${flags}`);
    } else {
      // wsl.exe would print "Failed to translate" into the tab and drop the
      // variable anyway; leave it out and let the tab explain why.
      unreachableKey = loginKey;
      env.WMUX_WSL_ACCOUNT_HOME_UNREACHABLE = `${loginKey} (${home})`;
      entries.push('WMUX_WSL_ACCOUNT_HOME_UNREACHABLE');
    }
  }
  env.WSLENV = mergeWslEnv(env.WSLENV, entries);
  if (unreachableKey) {
    const key = unreachableKey.toUpperCase();
    env.WSLENV = env.WSLENV.split(':').filter((s) => s.split('/')[0].toUpperCase() !== key).join(':');
  }
  // WSL runs bash explicitly so --rcfile reaches Linux, never wsl.exe. The
  // interactive init sources ~/.bashrc first. Exec units avoid startup output.
  const bootstrap = options.execCommand === undefined
    ? 'exec /bin/bash --rcfile "$WMUX_WSL_BASHRC" -i'
    : `if [ -z "$WMUX_WSL_CWD" ] || ! builtin cd -- "$WMUX_WSL_CWD"; then
  printf 'wmux: cannot enter WSL directory "%s"; check the directory and WSLENV transport, then retry.\\n' "$WMUX_WSL_CWD" >&2
  exit 1
fi
if [ "\${WMUX_SHELL_INTEGRATION:-1}" != 0 ]; then export PATH="$WMUX_WSL_BIN:$PATH"; fi
# An account that cannot get its home fails the run, never runs it on the default account:
# gated on the account ids, which always arrive, not on the script path, which wsl.exe can drop.
if [ -n "\${WMUX_WSL_ACCOUNT_CLAUDE:-}\${WMUX_WSL_ACCOUNT_CODEX:-}" ]; then
  if [ -z "\${WMUX_WSL_ACCOUNT_SH:-}" ] || [ ! -r "$WMUX_WSL_ACCOUNT_SH" ]; then
    printf 'wmux: this run cannot reach its account script from this WSL distro, so it does not run on the default account.\\n' >&2
    exit 1
  fi
  . "$WMUX_WSL_ACCOUNT_SH" exec || exit 1
fi
eval "$1"`;
  return {
    args: [...wslTargetArgs(target), '--cd', cwd, '--exec', '/bin/bash', '--noprofile', '--norc', '-c', bootstrap,
      'wmux-wsl', ...(options.execCommand === undefined ? [] : [options.execCommand])],
    env,
  };
}
