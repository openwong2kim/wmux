import fs from 'node:fs';
import { isWslDistroSpawnArgs } from './wslDistro';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { isWslShell, isLinuxCwd, validWslTarget, wslTargetArgs, type WslTarget } from './wslTarget';
export { isWslShell, isLinuxCwd, validWslTarget, wslTargetArgs, type WslTarget } from './wslTarget';

// Arguments are data, never interpolated into shell source. Resolve ~ inside
// Linux, and ask the selected distro to validate the directory. A missing
// directory fails visibly instead of silently resuming a different project.
export const WSL_CWD_PROBE = `
set -eu
candidate=$1
case "$candidate" in
  '~') candidate=$HOME ;;
  '~/'*) candidate="$HOME/\${candidate#\\~/}" ;;
  [A-Za-z]:*) candidate=$(wslpath -u "$candidate") ;;
esac
cd -- "$candidate"
printf '%s\\0%s\\0%s\\0' "$WSL_DISTRO_NAME" "$(id -un)" "$PWD"
`;

export function resolveWslCwd(
  shell: string,
  cwd: string | undefined,
  target?: WslTarget,
  probe = (args: string[]) => execFileSync(shell, args, {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 16_384, windowsHide: true,
    cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'],
  }),
  selectionArgs?: string[],
): { cwd: string; target: WslTarget } {
  const requested = cwd || '~';
  if (!isLinuxCwd(requested) && !/^[A-Za-z]:[\\/]/.test(requested)) {
    throw new Error('WSL working directory must be an absolute Linux/Windows path or ~/path');
  }
  if (/[\0\r\n]/.test(requested)) throw new Error('Invalid WSL working directory');
  // A recovered pane keeps its target; new panes honor #1245's resolved choice.
  const targetArgs = target ? wslTargetArgs(target)
    : isWslDistroSpawnArgs(shell, selectionArgs) ? selectionArgs : [];
  const output = probe([...targetArgs, '--exec', '/bin/sh', '-c', WSL_CWD_PROBE, 'wmux-cwd', requested]);
  const [distribution, user, canonicalCwd] = output.split('\0');
  const resolvedTarget = { distribution, user };
  if (!validWslTarget(resolvedTarget) || !isLinuxCwd(canonicalCwd) || !canonicalCwd.startsWith('/')) {
    throw new Error('WSL did not return a valid distribution, user and working directory');
  }
  return { cwd: canonicalCwd, target: resolvedTarget };
}

/** Preserve Linux paths through daemon restart; Windows stat cannot test them. */
export function recoveryCwd(session: { cmd: string; cwd: string }, platform = process.platform): string {
  if (isWslShell(session.cmd, platform)) return session.cwd;
  return fs.existsSync(session.cwd) ? session.cwd : os.homedir();
}

/** Override only our entries; preserve the user's other WSLENV transfers. */
export function mergeWslEnv(existing: string | undefined, entries: string[]): string {
  const names = new Set(entries.map((s) => s.split('/')[0].toUpperCase()));
  return [...(existing ?? '').split(':').filter((s) => s && !names.has(s.split('/')[0].toUpperCase())), ...entries].join(':');
}
