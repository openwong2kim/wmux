import { isWslShellPath, isValidWslDistroName } from './wslDistro';
/** The Linux execution target is independent of the Windows PTY host cwd. */
export interface WslTarget {
  distribution: string;
  user: string;
}

export function isWslShell(shell: string | undefined, platform = process.platform): boolean {
  return platform === 'win32' && isWslShellPath(shell);
}

export function isLinuxCwd(cwd: string | undefined): cwd is string {
  return typeof cwd === 'string' && !/[\0\r\n]/.test(cwd) &&
    ((cwd.startsWith('/') && !cwd.startsWith('//')) || cwd === '~' || cwd.startsWith('~/'));
}

export function validWslTarget(value: unknown): value is WslTarget {
  if (!value || typeof value !== 'object') return false;
  const t = value as WslTarget;
  return isValidWslDistroName(t.distribution) && [t.distribution, t.user].every((s) => typeof s === 'string' &&
    s.length > 0 && s.length <= 256 && !/[\0\r\n]/.test(s) && !s.startsWith('-'));
}

export function wslTargetArgs(target?: WslTarget): string[] {
  if (target === undefined) return [];
  if (!validWslTarget(target)) throw new Error('Invalid WSL distribution or user');
  return ['--distribution', target.distribution, '--user', target.user];
}

