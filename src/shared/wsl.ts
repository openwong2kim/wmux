import fs from 'node:fs';
import { decodeWslOutput, isWslDistroSpawnArgs } from './wslDistro';
import os from 'node:os';
import { execFile } from 'node:child_process';

import { isWslShell, isLinuxCwd, validWslTarget, wslTargetArgs, type WslTarget } from './wslTarget';
export { isWslShell, isLinuxCwd, validWslTarget, wslTargetArgs, type WslTarget } from './wslTarget';

/**
 * #1305 — what the probe prints when the directory itself is gone, as opposed
 * to any other reason a distro cannot be entered.
 *
 * A MARKER, not `cd`'s own message and not an exit code. `cd`'s wording is the
 * shell's and is localized, so matching it would work in English and nowhere
 * else; an exit code does not survive the injected-probe path the tests and
 * other callers use. The marker travels on stderr, which is already what the
 * thrown message is built from, so both paths classify identically.
 */
export const WSL_CWD_MISSING_MARKER = 'wmux-cwd-missing';

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
if [ ! -d "$candidate" ]; then
  printf '${WSL_CWD_MISSING_MARKER}: %s\\n' "$candidate" >&2
  exit 3
fi
cd -- "$candidate"
printf '%s\\0%s\\0%s\\0' "$WSL_DISTRO_NAME" "$(id -un)" "$PWD"
`;

export interface ResolvedWslCwd { cwd: string; target: WslTarget }

/**
 * #1305 — true when the probe failed because the directory is gone.
 *
 * The distinction is the whole point: every other failure (a stopped distro, a
 * permission problem, a transient interop hiccup) is answered by retrying, and
 * this one never is. It is what lets a caller offer starting fresh in the home
 * directory instead of a Retry button that can only fail again.
 */
export function isWslCwdMissingError(error: unknown): boolean {
  return error instanceof Error && (error as { wslCwdMissing?: boolean }).wslCwdMissing === true;
}
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
        // BUFFER, not a forced encoding, because the two streams speak
        // different encodings and only one of them is wsl.exe's (#1390):
        //   stderr is wsl.exe's OWN diagnostic ("no distribution with the
        //     supplied name", localized), UTF-16LE on any install that does
        //     not honour WSL_UTF8. Forcing utf8 here is what stored
        //     `L\0i\0n\0u\0x\0` in recoveryError and reported it as
        //     SPAWN_FAILED, with every non-ASCII character already lost.
        //   stdout belongs to the Linux child, is UTF-8, and is deliberately
        //     NUL-SEPARATED by WSL_CWD_PROBE. Decode it as UTF-8 and never
        //     sniff it: the NUL rule would read a successful probe as UTF-16.
        execFile(shell, args, { encoding: 'buffer', timeout: WSL_PROBE_TIMEOUT_MS,
          maxBuffer: 16_384, windowsHide: true, cwd: os.homedir(),
        }, (error, stdout, stderr) => {
          if (error) reject(new Error(decodeWslOutput(stderr).trim() || error.message));
          else resolve(stdout.toString('utf8'));
        });
      }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const where = targetArgs[1] || 'the default distro';
      // #1305 — a gone directory is not a "check the distro and retry" failure:
      // retrying it fails identically for as long as the directory is missing,
      // which is what left a recovered pane with no way out but closing it.
      // Say so, and flag it for the caller that can offer one.
      if (detail.includes(WSL_CWD_MISSING_MARKER)) {
        throw Object.assign(
          new Error(`The directory ${JSON.stringify(requested)} no longer exists in ${where}. Restore it and retry, or start fresh in your home directory.`),
          { wslCwdMissing: true },
        );
      }
      throw new Error(`WSL could not open ${JSON.stringify(requested)} in ${where}: ${detail}. Check the distro and directory, then retry.`);
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
