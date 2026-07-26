import { isLinuxLikeCwd, isWslShell } from './wslCwd';

export type SessionLocation =
  | { domain: 'host'; cwd: string; shell: string }
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
  | 'UNSUPPORTED_WSL_PATH';

function distroFromUnc(value: string): string | undefined {
  const match = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\|$)/i.exec(value);
  return match?.[1];
}

export function classifySessionLocation(
  shell: string,
  cwd: string,
  distro?: string,
): SessionLocation {
  if (!isWslShell(shell)) return { domain: 'host', cwd, shell };
  const resolvedDistro = distro || distroFromUnc(cwd);
  return {
    domain: 'wsl',
    cwd,
    shell,
    ...(resolvedDistro ? { distro: resolvedDistro } : {}),
  };
}

function normalizeHostIdentity(cwd: string): string {
  let value = cwd.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(value)) value = value[0].toLowerCase() + value.slice(1);
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

function normalizeGuestIdentity(cwd: string): string {
  let value = cwd;
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

export function locationIdentity(location: SessionLocation): string {
  if (location.domain === 'host') {
    return `host\0${normalizeHostIdentity(location.cwd)}`;
  }
  return `wsl\0${location.distro ?? ''}\0${normalizeGuestIdentity(location.cwd)}`;
}

export function locationsEqual(a: SessionLocation, b: SessionLocation): boolean {
  return locationIdentity(a) === locationIdentity(b);
}

export function preparePtyLocation(
  location: SessionLocation,
  hostHome: string,
): { spawnCwd: string; prefixArgs: string[] } {
  if (location.domain === 'wsl' && isLinuxLikeCwd(location.cwd)) {
    return { spawnCwd: hostHome, prefixArgs: ['--cd', location.cwd] };
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

export function toHostAccessiblePath(
  location: SessionLocation,
  targetPath: string,
): { ok: true; path: string } | { ok: false; error: LocationError } {
  if (location.domain === 'host') return { ok: true, path: targetPath };
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
    return { ok: true, file: executable, args: [...args], cwd: location.cwd };
  }
  if (!context?.active || !context.sessionId) {
    return { ok: false, error: 'ACTIVE_CONTEXT_REQUIRED' };
  }
  if (location.distro && context.distro && location.distro !== context.distro) {
    return { ok: false, error: 'WSL_DISTRO_MISMATCH' };
  }
  const distro = location.distro ?? context.distro;
  const prefix = distro ? ['-d', distro] : [];
  return {
    ok: true,
    file: 'wsl.exe',
    args: [...prefix, '--cd', location.cwd, '--exec', executable, ...args],
  };
}
