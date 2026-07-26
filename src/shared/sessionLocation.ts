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
  | 'UNSUPPORTED_MSYS_PATH';

function distroFromUnc(value: string): string | undefined {
  const match = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\|$)/i.exec(value);
  return match?.[1];
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
  if (location.domain === 'msys') {
    return `msys\0${normalizeGuestIdentity(location.cwd)}`;
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
