import fs from 'node:fs';
import path from 'node:path';
import { mergeWslEnv, wslTargetArgs, type WslTarget } from './wsl';

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
# --mcp-config is variadic: the = form keeps it from swallowing a prompt argument.
exec "$real" --settings "$WMUX_WSL_SETTINGS" \${WMUX_WSL_MCP_CONFIG:+--mcp-config="$WMUX_WSL_MCP_CONFIG"} "$@"
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
# reports it. The bridge refuses a shared app-server's notification outright,
# so a report only ever comes from the Codex that owns this pane.
${WSL_AGENT_PROC_FN}
wmux_agent_proc
export WMUX_WSL_AGENT_PROC
export WSLENV="$WSLENV:WMUX_WSL_AGENT_PROC/w"
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
export const WSL_MCP_LAUNCH = 'export ELECTRON_RUN_AS_NODE=1 WMUX_WSL_DISTRO="$WSL_DISTRO_NAME"'
  + ' WMUX_WSL_MOUNT="$(wslpath -u \'C:\\\' 2>/dev/null)"'
  + ' WSLENV="${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE/w:WMUX_WSL_DISTRO/w:WMUX_WSL_MOUNT/w";'
  + ' exec "$WMUX_WSL_NODE" "$WMUX_WSL_MCP"';

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
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
    Stop: [hook('Stop')],
    StopFailure: [hook('StopFailure')],
    SubagentStop: [hook('SubagentStop')],
    UserPromptSubmit: [hook('UserPromptSubmit')],
    PermissionRequest: [hook('PermissionRequest')],
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

export function buildWslInjection(options: {
  target: WslTarget;
  cwd: string;
  env: Record<string, string>;
  integrationDir: string;
  bashInit: string;
  execCommand?: string;
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
# Keep the user's shell setup even when wmux hooks are disabled.
if [ "\${WMUX_SHELL_INTEGRATION:-1}" = 0 ]; then
  [ ! -r "$HOME/.bashrc" ] || . "$HOME/.bashrc"
else
  . "$WMUX_WSL_BASHRC.integration"
fi
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
  ];
  env.WSLENV = mergeWslEnv(env.WSLENV, entries);
  // WSL runs bash explicitly so --rcfile reaches Linux, never wsl.exe. The
  // interactive init sources ~/.bashrc first. Exec units avoid startup output.
  const bootstrap = options.execCommand === undefined
    ? 'exec /bin/bash --rcfile "$WMUX_WSL_BASHRC" -i'
    : `if [ -z "$WMUX_WSL_CWD" ] || ! builtin cd -- "$WMUX_WSL_CWD"; then
  printf 'wmux: cannot enter WSL directory "%s"; check the directory and WSLENV transport, then retry.\\n' "$WMUX_WSL_CWD" >&2
  exit 1
fi
if [ "\${WMUX_SHELL_INTEGRATION:-1}" != 0 ]; then export PATH="$WMUX_WSL_BIN:$PATH"; fi
eval "$1"`;
  return {
    args: [...wslTargetArgs(target), '--cd', cwd, '--exec', '/bin/bash', '--noprofile', '--norc', '-c', bootstrap,
      'wmux-wsl', ...(options.execCommand === undefined ? [] : [options.execCommand])],
    env,
  };
}
