// The global WSL hook: Claude Code sessions started in a WSL distro OUTSIDE
// wmux report to wmux like any other external session (shared/
// externalSessions.ts). Opt-in only — `wmux setup-hooks --wsl [<distro>]`
// merges hooks into that distro's Claude settings (cli/commands/
// setupHooksWsl.ts); nothing here edits a settings file.
//
// Two files under `<wmux data dir>/hooks/` on the Windows side, both reached
// from Linux through /mnt/<drive>:
//   - WSL_GLOBAL_HOOK_SCRIPT, the hook command: a POSIX sh script that runs the
//     wmux hook bridge in the Windows runtime, as the per-launch WSL_HOOK of a
//     wmux pane does (shared/wslIntegration.ts);
//   - WSL_RUNTIME_POINTER, written by the running app at every start: which
//     runtime and bridge to run. An app update moves both (Squirrel's
//     versioned app-x.y.z folders), so the script never names them itself.
// A suffixed instance (WMUX_DATA_SUFFIX) keeps both in its own data dir and
// its script carries the suffix, so its hooks reach its own daemon and never
// the production one.

import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from './settingsFile';

/** The hook command's file name; also how an installed hook is recognised as wmux's. */
export const WSL_GLOBAL_HOOK_SCRIPT = 'wmux-wsl-hook.sh';
/** Runtime + bridge Windows paths, one per line, written by the app at boot. */
export const WSL_RUNTIME_POINTER = 'wsl-runtime';

/** Where the kernel says whether Windows interop is on (WSLInterop, or WSLInterop-late on newer WSL). */
const BINFMT_DIR = '/proc/sys/fs/binfmt_misc';

/** A data suffix the script can carry verbatim (constants.ts dataSuffix values are short tags). */
export function isScriptableSuffix(suffix: string): boolean {
  return /^[A-Za-z0-9._-]{0,64}$/.test(suffix);
}

/**
 * The env the bridge reads to say where a session runs (wmux-bridge.mjs
 * whereFromEnv), plus the entrypoint it tells a headless `claude -p` by.
 * WMUX_TMUX_TARGET is the tmux lookup this script makes on the Linux side.
 */
const FORWARDED_ENV = [
  'WSL_DISTRO_NAME', 'TMUX', 'TMUX_PANE', 'STY', 'ZELLIJ', 'ZELLIJ_SESSION_NAME',
  'SSH_CONNECTION', 'TERM_PROGRAM', 'CLAUDE_CODE_ENTRYPOINT', 'WMUX_TMUX_TARGET',
] as const;

/**
 * The hook script for an instance with data suffix `suffix` ('' for
 * production). Pure. `binfmtDir` exists for tests only.
 *
 * WSLENV (measured on WSL 2): a name listed in it is overwritten in the
 * Windows child by its Linux value and, when unset in Linux, DELETED from the
 * child. So only names set here are listed, and WMUX_DATA_SUFFIX only by a
 * suffixed instance's script, which sets it itself. `/w` is the direction
 * that carries a value from Linux to a Windows process.
 */
export function wslGlobalHookScript(suffix: string, options: { binfmtDir?: string } = {}): string {
  if (!isScriptableSuffix(suffix)) throw new Error(`WSL hook: unsupported data suffix ${JSON.stringify(suffix)}`);
  const binfmt = options.binfmtDir ?? BINFMT_DIR;
  if (/['\n]/.test(binfmt)) throw new Error('WSL hook: unsupported binfmt directory');
  const forwarded = [...FORWARDED_ENV, ...(suffix ? ['WMUX_DATA_SUFFIX'] : [])].join(' ');
  return `#!/bin/sh
# wmux: Claude Code hooks for sessions started in this WSL distro outside wmux.
# Installed by \`wmux setup-hooks --wsl\`, removed by
# \`wmux setup-hooks --wsl --uninstall\`. Every path exits 0 and prints nothing
# of its own: a hook must never fail or slow claude.
#
# A wmux pane already hooks its own claude (per-launch settings).
[ -z "\${WMUX_WSL_HOOK:-}" ] || exit 0
# Without Windows interop there is no wmux to report to.
wmux_interop=
for wmux_file in '${binfmt}/WSLInterop' '${binfmt}/WSLInterop-late'; do
  [ -r "$wmux_file" ] || continue
  wmux_line=
  { IFS= read -r wmux_line; } 2>/dev/null < "$wmux_file"
  if [ "$wmux_line" = enabled ]; then wmux_interop=1; break; fi
done
[ -n "$wmux_interop" ] || exit 0
command -v wslpath >/dev/null 2>&1 || exit 0
# The running wmux writes its runtime and bridge (Windows paths, one per line)
# beside this script at every start.
wmux_pointer="\${0%/*}/${WSL_RUNTIME_POINTER}"
[ -r "$wmux_pointer" ] || exit 0
wmux_exe=
wmux_bridge=
{ IFS= read -r wmux_exe; IFS= read -r wmux_bridge; } 2>/dev/null < "$wmux_pointer"
wmux_cr=$(printf '\\r')
wmux_exe=\${wmux_exe%"$wmux_cr"}
wmux_bridge=\${wmux_bridge%"$wmux_cr"}
[ -n "$wmux_exe" ] && [ -n "$wmux_bridge" ] || exit 0
wmux_exe=$(wslpath -u "$wmux_exe" 2>/dev/null) || exit 0
[ -n "$wmux_exe" ] && [ -x "$wmux_exe" ] || exit 0
wmux_bridge_file=$(wslpath -u "$wmux_bridge" 2>/dev/null) || exit 0
[ -n "$wmux_bridge_file" ] && [ -f "$wmux_bridge_file" ] || exit 0
# tmux lives on this side; the bridge runs on Windows and cannot ask it. Only
# at a session's start and a turn's start, like the bridge's own lookup.
unset WMUX_TMUX_TARGET
case "\${1:-}" in
  SessionStart|UserPromptSubmit)
    if [ -n "\${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
      wmux_bound=
      command -v timeout >/dev/null 2>&1 && wmux_bound='timeout 2'
      if [ -n "\${TMUX_PANE:-}" ]; then
        wmux_target=$($wmux_bound tmux display-message -p -t "$TMUX_PANE" '#S:#I' 2>/dev/null </dev/null) || wmux_target=
      else
        wmux_target=$($wmux_bound tmux display-message -p '#S:#I' 2>/dev/null </dev/null) || wmux_target=
      fi
      if [ -n "$wmux_target" ]; then WMUX_TMUX_TARGET=$wmux_target; export WMUX_TMUX_TARGET; fi
    fi
    ;;
esac
${suffix ? `# This instance's own daemon (an isolated wmux).
WMUX_DATA_SUFFIX='${suffix}'
export WMUX_DATA_SUFFIX
` : ''}export ELECTRON_RUN_AS_NODE=1
wmux_env=ELECTRON_RUN_AS_NODE/w
for wmux_name in ${forwarded}; do
  eval "wmux_value=\\\${$wmux_name:-}"
  [ -z "$wmux_value" ] || wmux_env="$wmux_env:$wmux_name/w"
done
export WSLENV="\${WSLENV:+$WSLENV:}$wmux_env"
"$wmux_exe" "$wmux_bridge" "$@" 2>/dev/null
exit 0
`;
}

/** The pointer file's text: runtime, then bridge, as Windows paths. */
export function wslRuntimePointerText(runtimePath: string, bridgePath: string): string {
  return `${runtimePath}\n${bridgePath}\n`;
}

/**
 * Write the pointer atomically (tmp + rename: the hook reads it at any moment)
 * and only when it changed. `hooksDir` is `<getWmuxDir()>/hooks`, which is
 * already suffix-scoped. Returns whether the file was written.
 */
export function writeWslRuntimePointer(hooksDir: string, runtimePath: string, bridgePath: string): boolean {
  if (/[\r\n]/.test(runtimePath) || /[\r\n]/.test(bridgePath)) throw new Error('WSL runtime pointer: a path holds a line break');
  const file = path.join(hooksDir, WSL_RUNTIME_POINTER);
  const text = wslRuntimePointerText(runtimePath, bridgePath);
  try {
    if (fs.readFileSync(file, 'utf8') === text) return false;
  } catch {
    // Absent or unreadable: write it.
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return true;
}

export type WslRuntimePointerOutcome = 'written' | 'up-to-date' | 'skipped' | 'no-bridge';

/**
 * The boot-time write. Windows only. The production (packaged) app writes
 * into the real data dir; an isolated (suffixed) instance into its own, which
 * `hooksDir` already is; an unsuffixed dev run writes nothing, so a dev build
 * never becomes the runtime of the user's real WSL hooks.
 */
export function refreshWslRuntimePointerAtBoot(input: {
  platform: NodeJS.Platform | string;
  isPackaged: boolean;
  suffix: string;
  hooksDir: string;
  runtimePath: string;
  bridgePath: string | null;
}): WslRuntimePointerOutcome {
  if (input.platform !== 'win32') return 'skipped';
  if (!input.isPackaged && input.suffix === '') return 'skipped';
  if (!input.bridgePath) return 'no-bridge';
  return writeWslRuntimePointer(input.hooksDir, input.runtimePath, input.bridgePath) ? 'written' : 'up-to-date';
}
