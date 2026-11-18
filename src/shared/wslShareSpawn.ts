import { wslShareToLinux } from './wslPaths';
import { isWslShellPath } from './wslDistro';

/**
 * The wsl.exe a create spawns, at the same System32 location ShellDetector
 * lists as the "WSL" shell.
 */
export function defaultWslShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${(env.SystemRoot || 'C:\\Windows').replace(/[\\/]+$/, '')}\\System32\\wsl.exe`;
}

/**
 * A pane opened in a WSL share folder (`\\wsl.localhost\<distro>\...`) starts a
 * WSL shell in that distro at the Linux path, instead of a Windows shell whose
 * cwd validation silently drops the UNC path and lands in home.
 *
 * Windows only. `knownDistros` is `wsl --list`'s answer; empty means the
 * enumeration failed, so the distro is trusted as written (it already passed
 * the distro-name check). Any other platform or cwd returns `options` as is.
 *
 * A shell the caller named that is not WSL (a profile's PowerShell or cmd)
 * is kept: its commands are written for it. That answers `needsWslShell`,
 * and the caller starts it outside the share and says why.
 */
export function applyWslShareCwd<T extends { cwd?: string; shell?: string; wslDistro?: string }>(
  options: T,
  platform: NodeJS.Platform,
  knownDistros: string[],
): { options: T } | { error: string } | { needsWslShell: true } {
  if (platform !== 'win32' || typeof options.cwd !== 'string') return { options };
  const share = wslShareToLinux(options.cwd);
  if (!share) return { options };
  if (options.shell && !isWslShellPath(options.shell)) return { needsWslShell: true };
  let distro = share.distro;
  if (knownDistros.length > 0) {
    const match = knownDistros.find((d) => d.toLowerCase() === distro.toLowerCase());
    if (!match) return { error: `WSL distro "${distro}" is not installed` };
    distro = match;
  }
  return {
    options: {
      ...options,
      cwd: share.linuxPath,
      wslDistro: distro,
      shell: isWslShellPath(options.shell) ? options.shell : defaultWslShellPath(),
    },
  };
}
