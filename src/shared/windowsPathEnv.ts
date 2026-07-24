import { execFileSync } from 'child_process';
import * as path from 'path';

/**
 * Refresh a child process's PATH from the live Windows registry at spawn time.
 *
 * THE BUG this addresses (RCA 2026-07-24): the env every pane inherits is built
 * from the wmux control process's `process.env` (`resolveSpawnEnv(globalThis.
 * process.env, …)` in PTYManager and pty.handler). That object is a SNAPSHOT
 * taken when the process launched, and a process launched at login / kept alive
 * in the tray for days never sees a PATH the OS wrote to the registry AFTER it
 * started — Node's `process.env` does not track `WM_SETTINGCHANGE`. So a user
 * who installs Node/Python/etc. (which append to `HKCU\Environment\Path`) and
 * then opens a NEW pane still gets the stale PATH and "command not found",
 * unlike every native terminal, which composes PATH fresh from the registry for
 * each new shell.
 *
 * Spawning a child shell to read its env does NOT help: a child inherits the
 * parent's (stale) environment block, it does not re-read the registry. Reading
 * the registry directly is the only way to recover the current PATH from inside
 * a long-lived process.
 *
 * Scope: PATH only. It is the variable installers mutate and the one behind the
 * "my tool isn't found" symptom, and machine+user PATH compose by a known rule
 * (concatenate) so it can be reconstructed safely. Refreshing arbitrary other
 * user variables is a larger, riskier change left for later. Recovery-replayed
 * sessions (the daemon replays a persisted create-time env verbatim on reboot)
 * are also out of scope here — this fixes the env at CREATE time.
 *
 * Fail-open everywhere: a non-win32 platform, the kill switch, or any failed
 * read returns the caller's env untouched, so a pane never ends up with a WORSE
 * PATH than before. Electron-free (only child_process/path) so the daemon could
 * reuse it for the recovery path later.
 */

const SYSTEM_ENV_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_ENV_KEY = 'HKCU\\Environment';

/** Coalesce spawn bursts (session recovery fans out many creates) to one read. */
const CACHE_TTL_MS = 5_000;

let cache: { value: string | null; at: number } | null = null;

/** Test seam: clear the module-level registry-read cache between cases. */
export function resetFreshPathCacheForTests(): void {
  cache = null;
}

/**
 * Read the raw `Path` value from a registry Environment key via `reg.exe`.
 * `reg.exe` is used (not a cmdlet/.NET call) because it is immune to PowerShell
 * language-mode lockdown and returns the value WITHOUT expanding `%VAR%` — we do
 * the expansion ourselves against the caller's env. Returns null on any failure
 * or when the key has no `Path` value (e.g. a user with no user-scoped PATH).
 */
function readRegistryEnvPath(root: string): string | null {
  try {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const out = execFileSync(reg, ['query', root, '/v', 'Path'], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    });
    for (const line of out.split(/\r?\n/)) {
      // reg output row:  "    Path    REG_EXPAND_SZ    C:\a;C:\b"
      const m = line.match(/^\s*Path\s+REG(?:_EXPAND)?_SZ\s+(.*\S)\s*$/i);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** Expand `%VAR%` references against `baseEnv` (case-insensitive). Unknown vars
 *  are left literal so a bad reference degrades to a harmless dead PATH entry. */
export function expandPercentRefs(value: string, baseEnv: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(baseEnv).find((k) => k.toLowerCase() === name.toLowerCase());
    const v = key ? baseEnv[key] : undefined;
    return typeof v === 'string' ? v : whole;
  });
}

/**
 * Compose the current registry PATH the way Windows does — machine PATH then
 * user PATH — with `%VAR%` expanded. Returns null only when NEITHER key could be
 * read (so the caller keeps its existing PATH).
 */
export function composeRegistryPath(
  systemRaw: string | null,
  userRaw: string | null,
  baseEnv: NodeJS.ProcessEnv,
): string | null {
  if (systemRaw === null && userRaw === null) return null;
  const parts: string[] = [];
  if (systemRaw !== null) parts.push(expandPercentRefs(systemRaw, baseEnv));
  if (userRaw !== null) parts.push(expandPercentRefs(userRaw, baseEnv));
  return parts.filter(Boolean).join(';');
}

/**
 * Merge the fresh registry PATH with any entries the running process added at
 * runtime that the registry doesn't carry (e.g. the wmux `bin` shim path, or a
 * tool that mutated its own PATH). Fresh entries lead (native-terminal order);
 * runtime-only extras are appended. Dedup is case-insensitive (win32 paths).
 */
export function mergeFreshPathWithBase(freshPath: string, baseEnv: NodeJS.ProcessEnv): string {
  const SEP = ';';
  const fresh = freshPath.split(SEP).filter(Boolean);
  const seen = new Set(fresh.map((e) => e.toLowerCase()));
  const baseKey = Object.keys(baseEnv).find((k) => k.toLowerCase() === 'path');
  const baseVal = baseKey ? baseEnv[baseKey] : undefined;
  const extras =
    typeof baseVal === 'string'
      ? baseVal.split(SEP).filter((e) => e && !seen.has(e.toLowerCase()))
      : [];
  return [...fresh, ...extras].join(SEP);
}

export interface FreshPathDeps {
  platform?: NodeJS.Platform;
  disabled?: boolean;
  now?: () => number;
  readRegistryPath?: (root: string) => string | null;
}

/**
 * Return a copy of `baseEnv` whose PATH is refreshed from the live registry, so
 * a pane spawned by a long-lived process sees tools installed AFTER that process
 * started — matching what a freshly opened terminal gets. Off-win32, disabled
 * (`WMUX_NO_PATH_REFRESH=1`), or a failed read returns `baseEnv` UNCHANGED so a
 * pane never gets a worse PATH than today. `deps` is a test seam.
 */
export function withFreshWindowsPath(
  baseEnv: NodeJS.ProcessEnv,
  deps: FreshPathDeps = {},
): NodeJS.ProcessEnv {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return baseEnv;
  const disabled = deps.disabled ?? process.env.WMUX_NO_PATH_REFRESH === '1';
  if (disabled) return baseEnv;

  const now = deps.now ?? Date.now;
  const read = deps.readRegistryPath ?? readRegistryEnvPath;

  let fresh: string | null;
  const t = now();
  if (cache && t - cache.at < CACHE_TTL_MS) {
    fresh = cache.value;
  } else {
    fresh = composeRegistryPath(read(SYSTEM_ENV_KEY), read(USER_ENV_KEY), baseEnv);
    cache = { value: fresh, at: t };
  }
  if (!fresh) return baseEnv; // both reads failed — keep the existing PATH

  const merged = mergeFreshPathWithBase(fresh, baseEnv);
  const copy: NodeJS.ProcessEnv = { ...baseEnv };
  const baseKey = Object.keys(baseEnv).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  copy[baseKey] = merged;
  return copy;
}
