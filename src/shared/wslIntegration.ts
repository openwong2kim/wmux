import fs from 'node:fs';
import path from 'node:path';
import { mergeWslEnv, wslTargetArgs, type WslTarget } from './wsl';

// Per-launch settings only. Never edit ~/.claude/settings.json in either OS.
// Use the existing bridge in its Windows runtime: this preserves the named-pipe
// authentication and pane routing instead of adding a network listener.
export const WSL_HOOK = `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
export WSLENV="\${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE/w"
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
exec "$real" --settings "$WMUX_WSL_SETTINGS" "$@"
`;

function findBridge(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    for (const rel of ['cli-bundle/wmux-bridge.mjs', 'integrations/claude/bin/wmux-bridge.mjs', 'dist/cli-bundle/wmux-bridge.mjs']) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('WSL integration: bundled Claude hook bridge is missing');
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
  const hooks = Object.fromEntries(['SessionStart', 'Stop', 'StopFailure'].map((event) => [event, [{
    matcher: '', hooks: [{ type: 'command', command: `/bin/sh "$WMUX_WSL_HOOK" ${event}`, timeout: 10 }],
  }]]));
  write(path.join(dir, 'claude-settings.json'), JSON.stringify({ hooks }));
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
# Only wmux panes see the shim. Existing Claude settings/hooks are retained.
if [ "\${WMUX_SHELL_INTEGRATION:-1}" != 0 ]; then
  export PATH="$WMUX_WSL_BIN:$PATH"
fi
`);
  const env: Record<string, string> = { ...options.env,
    WMUX_WSL_CWD: cwd,
    WMUX_WSL_NODE: options.runtimePath ?? process.execPath,
    WMUX_WSL_BRIDGE: options.bridgePath ?? findBridge(__dirname),
    WMUX_WSL_HOOK: path.join(dir, 'hook.sh'),
    WMUX_WSL_SETTINGS: path.join(dir, 'claude-settings.json'),
    WMUX_WSL_BIN: bin,
    WMUX_WSL_BASHRC: path.join(dir, 'bashrc'),
  };
  const entries = [
    'WMUX_PTY_ID', 'WMUX_WORKSPACE_ID', 'WMUX_SURFACE_ID', 'WMUX_DATA_SUFFIX',
    'WMUX_WSL_NODE/p', 'WMUX_WSL_BRIDGE/u', 'WMUX_WSL_HOOK/p',
    'WMUX_WSL_CWD/u', 'WMUX_WSL_SETTINGS/p', 'WMUX_WSL_BIN/p', 'WMUX_WSL_BASHRC/p', 'WMUX_SHELL_INTEGRATION',
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
