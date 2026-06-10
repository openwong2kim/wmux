import fs from 'node:fs';
import path from 'node:path';

/**
 * Single source of truth for Windows shell candidate paths and pwsh-7
 * launchability resolution, shared by the main process (ShellDetector) and
 * the daemon (DaemonSessionManager / daemon config) — issue #183.
 *
 * Before this module, the daemon kept its own pwsh-7 path table that only
 * listed the traditional installer location, so on a machine where
 * PowerShell 7 is installed exclusively via the Microsoft Store the daemon's
 * default-shell fallback silently dropped to Windows PowerShell 5.1 — the
 * exact divergence #179/#180 fixed for the main process.
 */

/**
 * Resolve a Windows shell candidate to a path that node-pty can actually
 * spawn, or null if it is not launchable (#179).
 *
 * A regular file launches as-is. The WindowsApps pwsh.exe installed via the
 * Microsoft Store, however, is an App Execution Alias — a 0-byte
 * IO_REPARSE_TAG_APPEXECLINK reparse point. fs.existsSync() does not follow
 * it (so existsSync-only detection misses it entirely), AND node-pty's
 * CreateProcess cannot launch the alias stub directly — it silently falls
 * back to Windows PowerShell 5.1 (dogfood 2026-06-10: declaring the alias as
 * the shell spawned 5.1, not pwsh 7). So we must hand back the *resolved*
 * package target (readlink, the same path libuv would resolve), which spawns
 * pwsh 7 correctly. Requiring the resolved target to exist also filters out a
 * dead alias stub left by an uninstalled package.
 */
export function resolveLaunchableWindowsExe(p: string): string | null {
  if (!p) return null;
  try {
    if (fs.existsSync(p)) return p;
    if (!fs.lstatSync(p).isSymbolicLink()) return null;
    const target = fs.readlinkSync(p);
    // win32 semantics explicitly: this helper only runs for Windows paths,
    // but unit tests exercise it on POSIX hosts too.
    const resolved = path.win32.isAbsolute(target) ? target : path.resolve(path.dirname(p), target);
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * PowerShell 7 candidate locations on Windows, in preference order:
 * traditional installer first, then the Microsoft Store App Execution Alias.
 * Built with literal backslashes (not path.join) so the exact same strings
 * are produced on POSIX test hosts.
 */
export function windowsPwsh7Candidates(): string[] {
  return [
    `${process.env.ProgramFiles || 'C:\\Program Files'}\\PowerShell\\7\\pwsh.exe`,
    `${process.env.LOCALAPPDATA || ''}\\Microsoft\\WindowsApps\\pwsh.exe`,
  ];
}

/**
 * Find a launchable PowerShell 7 on Windows, resolving the Store alias to
 * its real package target. Returns null when no usable pwsh 7 is present.
 */
export function findWindowsPwsh7(): string | null {
  for (const p of windowsPwsh7Candidates()) {
    const launchable = resolveLaunchableWindowsExe(p);
    if (launchable) return launchable;
  }
  return null;
}

/** Windows PowerShell 5.1 — present on every Windows box. */
export function windowsPowerShell51Path(): string {
  return `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * Candidate absolute paths for a bare shell executable name (e.g.
 * "pwsh.exe", "zsh"), per platform, in preference order. Single source of
 * truth for the well-known location tables that previously lived inside
 * DaemonSessionManager.resolveShellPath (#185). Platform is checked at call
 * time (not import time) so the daemon's session-create path — and tests
 * that redefine process.platform — resolve against the right table.
 */
export function bareShellCandidates(basename: string): string[] {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    switch (basename) {
      case 'powershell.exe': return [windowsPowerShell51Path()];
      case 'pwsh.exe': return windowsPwsh7Candidates();
      case 'cmd.exe': return [`${systemRoot}\\System32\\cmd.exe`];
      case 'bash.exe': return [`${systemRoot}\\System32\\bash.exe`, `${progFiles}\\Git\\bin\\bash.exe`];
      case 'wsl.exe': return [`${systemRoot}\\System32\\wsl.exe`];
      default: return [];
    }
  }
  if (process.platform === 'darwin') {
    switch (basename) {
      case 'zsh': return ['/bin/zsh'];
      case 'bash': return ['/bin/bash'];
      case 'pwsh': return ['/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh'];
      case 'fish': return ['/opt/homebrew/bin/fish', '/usr/local/bin/fish'];
      default: return [];
    }
  }
  if (process.platform === 'linux') {
    switch (basename) {
      case 'bash': return ['/bin/bash'];
      case 'zsh': return ['/usr/bin/zsh', '/bin/zsh'];
      case 'pwsh': return ['/usr/bin/pwsh', '/snap/bin/pwsh'];
      case 'fish': return ['/usr/bin/fish'];
      default: return [];
    }
  }
  return [];
}

/**
 * Resolve a bare shell name to a launchable absolute path, or null when no
 * well-known location matches (callers may then fall back to PATH search).
 * On Windows each candidate goes through the Store-alias readlink resolution,
 * so a bare "pwsh.exe" resolves on Store-only boxes too (#179/#183).
 */
export function resolveBareShellName(cmd: string): string | null {
  const basename = path.basename(cmd).toLowerCase();
  for (const c of bareShellCandidates(basename)) {
    if (process.platform === 'win32') {
      const launchable = resolveLaunchableWindowsExe(c);
      if (launchable) return launchable;
    } else {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

/**
 * Default shell resolution for Windows shared by main and daemon:
 * PowerShell 7 (either install flavor) → Windows PowerShell 5.1 →
 * bare names as a last resort (let CreateProcess search PATH).
 * 5.1 ships on every Windows box, so a 5.1-first order would mask an
 * installed pwsh 7 forever (#176/#178/#181).
 */
export function getWindowsDefaultShell(): string {
  const pwsh7 = findWindowsPwsh7();
  if (pwsh7) return pwsh7;
  const candidates = [windowsPowerShell51Path(), 'powershell.exe', 'cmd.exe'];
  for (const shell of candidates) {
    try {
      if (fs.existsSync(shell)) return shell;
    } catch {
      /* skip */
    }
  }
  return 'cmd.exe';
}
