import fs from 'node:fs';
import { isWslDistroSpawnArgs } from './wslDistro';
import os from 'node:os';
import { execFile } from 'node:child_process';

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

export interface ResolvedWslCwd { cwd: string; target: WslTarget }
export const WSL_PROBE_TIMEOUT_MS = 60_000;
export const WSL_RPC_TIMEOUT_MS = WSL_PROBE_TIMEOUT_MS + 15_000;
type Probe = (args: string[]) => string | Promise<string>;
// Coalesce concurrent probes only. Never cache directory validity across creates:
// a project can be removed or the distro's default user changed between retries.
const inFlight = new Map<string, Promise<ResolvedWslCwd>>();

export async function resolveWslCwd(
  shell: string,
  cwd: string | undefined,
  target?: WslTarget,
  probe?: Probe,
  selectionArgs?: string[],
): Promise<ResolvedWslCwd> {
  const requested = cwd || '~';
  if (!isLinuxCwd(requested) && !/^[A-Za-z]:[\\/]/.test(requested)) {
    throw new Error('WSL working directory must be an absolute Linux/Windows path or ~/path');
  }
  // ConPTY joins argv into a Windows command line. Until a round-trip test
  // establishes double-quote handling, reject it rather than split the path.
  if (/[\0\r\n"]/.test(requested)) throw new Error('WSL working directory cannot contain double quotes or control characters');
  const targetArgs = target ? wslTargetArgs(target)
    : isWslDistroSpawnArgs(shell, selectionArgs) ? selectionArgs : [];
  const args = [...targetArgs, '--exec', '/bin/sh', '-c', WSL_CWD_PROBE, 'wmux-cwd', requested];
  const key = JSON.stringify([shell, targetArgs, requested]);
  if (!probe && inFlight.has(key)) return inFlight.get(key)!;
  const operation = (async () => {
    let output: string;
    try {
      output = await (probe ? probe(args) : new Promise<string>((resolve, reject) => {
        execFile(shell, args, { encoding: 'utf8', timeout: WSL_PROBE_TIMEOUT_MS,
          maxBuffer: 16_384, windowsHide: true, cwd: os.homedir(),
        }, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve(stdout);
        });
      }));
    } catch (error) {
      throw new Error(`WSL could not open ${JSON.stringify(requested)} in ${targetArgs[1] || 'the default distro'}: ${error instanceof Error ? error.message : String(error)}. Check the distro and directory, then retry.`);
    }
    const [distribution, user, canonicalCwd] = output.split('\0');
    const resolvedTarget = { distribution, user };
    if (!validWslTarget(resolvedTarget) || !isLinuxCwd(canonicalCwd) || !canonicalCwd.startsWith('/') || canonicalCwd.includes('"')) {
      throw new Error('WSL did not return a valid distribution, user and working directory (double quotes are unsupported)');
    }
    return { cwd: canonicalCwd, target: resolvedTarget };
  })();
  if (!probe) inFlight.set(key, operation);
  try { return await operation; }
  finally { if (inFlight.get(key) === operation) inFlight.delete(key); }
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
