import { isLinuxLikeCwd, isWslShell } from './wslCwd';

export type SessionLocation =
  | { domain: 'host'; cwd: string; shell: string }
  | { domain: 'msys'; cwd: string; shell: string }
  | { domain: 'wsl'; cwd: string; shell: string; distro?: string };

export interface ActiveSessionContext {
  sessionId: string;
  active: true;
  distro?: string;
}

export type LocationError =
  | 'ACTIVE_CONTEXT_REQUIRED'
  | 'WSL_DISTRO_MISMATCH'
  | 'WSL_DISTRO_REQUIRED'
  | 'UNSUPPORTED_WSL_PATH'
  | 'UNSUPPORTED_MSYS_PATH'
  | 'UNRESOLVED_GUEST_PATH';

/**
 * Host platform, read lazily and defensively. This module is imported by the
 * renderer as well as main/daemon, and a context-isolated renderer has no
 * `process`; the two call sites that need the platform (the guest-path guard
 * and host identity case-folding) are main/daemon-only in practice, so a
 * missing `process` degrades to the POSIX branch rather than throwing.
 */
function hostPlatform(): string {
  return typeof process !== 'undefined' ? process.platform : '';
}

function distroFromUnc(value: string): string | undefined {
  const match = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\|$)/i.exec(value);
  return match?.[1];
}

/**
 * Sole owner of "no non-host path is ever resolved through Windows filesystem
 * APIs" (issue #21 AC 6).
 *
 * A `host` location can still carry a guest path: a session persisted before
 * `location` existed, a workspace whose profile has no `shell` (so nothing can
 * classify it as wsl/msys), or any RPC payload built from a bare cwd. Rather
 * than have each consumer sniff for `/home`, `\\wsl$` and friends — which
 * issue #21 explicitly forbids — every host path entering a Windows API passes
 * through here, and an unclassifiable guest path is rejected by name.
 *
 * Only meaningful on Windows: `/home/me` is a perfectly good host path on
 * macOS and Linux.
 */
function isUnresolvedGuestPath(location: SessionLocation, targetPath: string): boolean {
  if (location.domain !== 'host') return false;
  if (hostPlatform() !== 'win32') return false;
  return isLinuxLikeCwd(targetPath);
}

/** The one way to build a host location — see `hostCommandTarget` for targets. */
export function hostLocation(cwd: string, shell = ''): SessionLocation {
  return { domain: 'host', cwd, shell };
}

function isSessionLocationShape(value: unknown): value is SessionLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const location = value as Partial<SessionLocation> & { distro?: unknown };
  if (
    location.domain !== 'host'
    && location.domain !== 'msys'
    && location.domain !== 'wsl'
  ) return false;
  if (typeof location.cwd !== 'string' || !location.cwd.trim()) return false;
  if (typeof location.shell !== 'string') return false;
  if (location.domain !== 'wsl') return true;
  return location.distro === undefined || typeof location.distro === 'string';
}

/**
 * Sole validator for a `SessionLocation` arriving over a process boundary
 * (issue #21 — the contract was previously re-declared in five consumers, two
 * of which disagreed on whether `msys` was a legal domain).
 *
 * Accepts either a structured location or a bare cwd string, which is how
 * every pre-location caller still addresses these APIs. A bare string is a
 * host location by construction; whether that host path is actually reachable
 * is decided by `toHostAccessiblePath`, not here.
 */
export function parseSessionLocation(input: unknown): SessionLocation | null {
  if (typeof input === 'string') {
    const cwd = input.trim();
    return cwd ? hostLocation(cwd) : null;
  }
  return isSessionLocationShape(input) ? input : null;
}

/**
 * Sole owner of the legacy-record fallback: sessions persisted before
 * `location` existed carry only `{ cmd, cwd }` and are classified on read.
 * Previously spelled out as `location ?? classifySessionLocation(cmd, cwd)` at
 * thirteen sites across three processes.
 */
export function resolveSessionLocation(record: {
  cmd?: string;
  shell?: string;
  cwd: string;
  location?: SessionLocation | null;
  distro?: string;
}): SessionLocation {
  const parsed = parseSessionLocation(record.location);
  if (parsed) return parsed;
  return classifySessionLocation(record.shell ?? record.cmd ?? '', record.cwd, record.distro);
}

export function classifySessionLocation(
  shell: string,
  cwd: string,
  distro?: string,
): SessionLocation {
  if (!isWslShell(shell)) {
    if (isMsysShell(shell) && cwd.startsWith('/')) return { domain: 'msys', cwd, shell };
    return { domain: 'host', cwd, shell };
  }
  const resolvedDistro = distro || distroFromUnc(cwd);
  return {
    domain: 'wsl',
    cwd,
    shell,
    ...(resolvedDistro ? { distro: resolvedDistro } : {}),
  };
}

/**
 * Host path → cache/equality identity.
 *
 * Case-folds on the case-insensitive host filesystems (win32, darwin) so that
 * a PR-creation `invalidate(worktreePath, branch)` reliably hits the entry the
 * metadata poll's `get(cwd, branch)` created — `C:\a` vs `c:/a/` must not miss
 * and leave the stale 5-min entry alive (CX8). This matches
 * `normalizeWorktreePath` in shared/workTask.ts, which these caches used
 * before session locations existed.
 *
 * Backslashes are separators only on Windows: `a\b` is a legal directory name
 * on Linux, so rewriting it there would collapse `/x/a\b` and `/x/a/b` onto
 * one identity.
 */
function normalizeHostIdentity(cwd: string, platform: NodeJS.Platform): string {
  // A drive-letter or UNC path is Windows-shaped whatever OS is reading the
  // record — a persisted session is classified on whichever machine loads it.
  // Elsewhere backslash is a legal filename character, so `/x/a\b` and
  // `/x/a/b` must stay distinct on Linux.
  const windowsShaped = platform === 'win32'
    || /^[A-Za-z]:[\\/]/.test(cwd)
    || cwd.startsWith('\\\\');
  let value = windowsShaped ? cwd.replace(/\\/g, '/') : cwd;
  const unc = value.startsWith('//') ? '//' : '';
  value = unc + value.slice(unc.length).replace(/\/{2,}/g, '/');
  // Case-insensitive filesystems fold; ext4 does not.
  if (windowsShaped || platform === 'darwin') value = value.toLowerCase();
  while (value.length > unc.length + 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

function normalizeGuestIdentity(cwd: string): string {
  let value = cwd;
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

export function locationIdentity(
  location: SessionLocation,
  platform: NodeJS.Platform = hostPlatform() as NodeJS.Platform,
): string {
  if (location.domain === 'host') {
    return `host\0${normalizeHostIdentity(location.cwd, platform)}`;
  }
  if (location.domain === 'msys') {
    return `msys\0${normalizeGuestIdentity(location.cwd)}`;
  }
  return `wsl\0${location.distro ?? ''}\0${normalizeGuestIdentity(location.cwd)}`;
}

export function locationsEqual(
  a: SessionLocation,
  b: SessionLocation,
  platform: NodeJS.Platform = hostPlatform() as NodeJS.Platform,
): boolean {
  return locationIdentity(a, platform) === locationIdentity(b, platform);
}

export function preparePtyLocation(
  location: SessionLocation,
  hostHome: string,
): { spawnCwd: string; prefixArgs: string[] } {
  if (location.domain === 'wsl' && isLinuxLikeCwd(location.cwd)) {
    return { spawnCwd: hostHome, prefixArgs: ['--cd', location.cwd] };
  }
  if (location.domain === 'msys') {
    return {
      spawnCwd: msysWindowsPath(location.shell, location.cwd) ?? hostHome,
      prefixArgs: [],
    };
  }
  return { spawnCwd: location.cwd, prefixArgs: [] };
}

export function resolveReplayLocation(
  shell: string,
  cwd: string,
  hostHome: string,
  hostDirectoryExists: (cwd: string) => boolean,
  distro?: string,
): {
  location: SessionLocation;
  spawnCwd: string;
  prefixArgs: string[];
  degraded: boolean;
  originalCwd?: string;
} {
  const original = classifySessionLocation(shell, cwd, distro);
  if (original.domain === 'wsl' && isLinuxLikeCwd(cwd)) {
    return { location: original, ...preparePtyLocation(original, hostHome), degraded: false };
  }
  if (original.domain === 'msys') {
    const prepared = preparePtyLocation(original, hostHome);
    if (hostDirectoryExists(prepared.spawnCwd)) {
      return { location: original, ...prepared, degraded: false };
    }
  }
  if (hostDirectoryExists(cwd)) {
    return { location: original, ...preparePtyLocation(original, hostHome), degraded: false };
  }
  const fallback = classifySessionLocation(shell, hostHome, distro);
  return {
    location: fallback,
    ...preparePtyLocation(fallback, hostHome),
    degraded: true,
    originalCwd: cwd,
  };
}

function mountedWindowsPath(value: string): string | undefined {
  const match = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(value);
  if (!match) return undefined;
  const tail = match[2] ? `\\${match[2].replace(/\//g, '\\')}` : '\\';
  return `${match[1].toUpperCase()}:${tail}`;
}

function isMsysShell(shell: string): boolean {
  return /(?:^|[\\/])(?:ba|z|k)?sh\.exe$/i.test(shell);
}

function msysWindowsPath(shell: string, value: string): string | undefined {
  if (!isMsysShell(shell)) return undefined;
  const match = /^\/([A-Za-z])(?:\/(.*))?$/.exec(value);
  if (!match) return undefined;
  const tail = match[2] ? `\\${match[2].replace(/\//g, '\\')}` : '\\';
  return `${match[1].toUpperCase()}:${tail}`;
}

export function toHostAccessiblePath(
  location: SessionLocation,
  targetPath: string,
): { ok: true; path: string } | { ok: false; error: LocationError } {
  if (location.domain === 'host') {
    if (isUnresolvedGuestPath(location, targetPath)) {
      return { ok: false, error: 'UNRESOLVED_GUEST_PATH' };
    }
    return { ok: true, path: targetPath };
  }
  if (location.domain === 'msys') {
    if (/^[A-Za-z]:[\\/]/.test(targetPath)) return { ok: true, path: targetPath };
    const converted = msysWindowsPath(location.shell, targetPath);
    return converted
      ? { ok: true, path: converted }
      : { ok: false, error: 'UNSUPPORTED_MSYS_PATH' };
  }
  if (/^[A-Za-z]:[\\/]/.test(targetPath) || /^\\\\(?!wsl(?:\.localhost|\$)\\)/i.test(targetPath)) {
    return { ok: true, path: targetPath };
  }
  const mounted = mountedWindowsPath(targetPath);
  if (mounted) return { ok: true, path: mounted };
  if (/^\\\\wsl(?:\.localhost|\$)\\/i.test(targetPath)) return { ok: true, path: targetPath };
  if (!targetPath.startsWith('/')) return { ok: false, error: 'UNSUPPORTED_WSL_PATH' };
  if (!location.distro) return { ok: false, error: 'WSL_DISTRO_REQUIRED' };
  return {
    ok: true,
    path: `\\\\wsl.localhost\\${location.distro}${targetPath.replace(/\//g, '\\')}`,
  };
}

export function prepareLocationCommand(
  location: SessionLocation,
  executable: string,
  args: readonly string[],
  context?: ActiveSessionContext,
): { ok: true; file: string; args: string[]; cwd?: string }
  | { ok: false; error: LocationError } {
  if (location.domain === 'host') {
    if (isUnresolvedGuestPath(location, location.cwd)) {
      return { ok: false, error: 'UNRESOLVED_GUEST_PATH' };
    }
    return { ok: true, file: executable, args: [...args], cwd: location.cwd };
  }
  if (location.domain === 'msys') {
    const cwd = msysWindowsPath(location.shell, location.cwd);
    if (!cwd) return { ok: false, error: 'UNSUPPORTED_MSYS_PATH' };
    return { ok: true, file: executable, args: [...args], cwd };
  }
  const distro = location.distro ?? context?.distro;
  if (!distro) return { ok: false, error: 'WSL_DISTRO_REQUIRED' };
  if (!context?.active || !context.sessionId) {
    return { ok: false, error: 'ACTIVE_CONTEXT_REQUIRED' };
  }
  if (location.distro && context.distro && location.distro !== context.distro) {
    return { ok: false, error: 'WSL_DISTRO_MISMATCH' };
  }
  return {
    ok: true,
    file: 'wsl.exe',
    args: ['-d', distro, '--cd', location.cwd, '--exec', executable, ...args],
  };
}
