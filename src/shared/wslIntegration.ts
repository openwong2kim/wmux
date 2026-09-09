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
# Remove this shim directory from PATH, including repeated/nested injections.
old_ifs=$IFS
IFS=:
clean=
for entry in $PATH; do
  [ "$entry" = "$WMUX_WSL_BIN" ] && continue
  clean="\${clean:+$clean:}$entry"
done
IFS=$old_ifs
real=$(PATH="$clean" command -v claude) || {
  printf '%s\\n' 'wmux: claude is not installed in this WSL distribution' >&2
  exit 127
}
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
builtin cd -- "$WMUX_WSL_CWD" || exit 1
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
  // existing init sources ~/.bashrc first. Exec units use the same bootstrap.
  const bootstrap = options.execCommand === undefined
    ? 'exec /bin/bash --rcfile "$WMUX_WSL_BASHRC" -i'
    : '. "$WMUX_WSL_BASHRC"; eval "$1"';
  return {
    args: [...wslTargetArgs(target), '--cd', cwd, '--exec', '/bin/bash', '-c', bootstrap,
      'wmux-wsl', ...(options.execCommand === undefined ? [] : [options.execCommand])],
    env,
  };
}
