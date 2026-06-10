import fs from 'node:fs';
import path from 'node:path';
import { isMac, isLinux, platformChoice } from '../../shared/platform';

export interface ShellInfo {
  name: string;
  path: string;
  args?: string[];
}

export class ShellDetector {
  detect(): ShellInfo[] {
    return platformChoice<ShellInfo[]>({
      win: this.detectWindows(),
      mac: this.detectMac(),
      linux: this.detectLinux(),
      default: this.detectUnix(),
    });
  }

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
  private resolveLaunchableWindowsExe(p: string): string | null {
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

  private detectWindows(): ShellInfo[] {
    const shells: ShellInfo[] = [];

    // PowerShell 7+ (pwsh)
    const pwshPaths = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\WindowsApps\\pwsh.exe'),
    ];
    for (const p of pwshPaths) {
      const launchable = this.resolveLaunchableWindowsExe(p);
      if (launchable) {
        shells.push({ name: 'PowerShell 7', path: launchable });
        break;
      }
    }

    // Windows PowerShell 5.1
    const ps5 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    if (fs.existsSync(ps5)) {
      shells.push({ name: 'Windows PowerShell', path: ps5 });
    }

    // Git Bash
    const gitBashPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    for (const p of gitBashPaths) {
      if (fs.existsSync(p)) {
        shells.push({ name: 'Git Bash', path: p, args: ['--login', '-i'] });
        break;
      }
    }

    // WSL
    const wslPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\wsl.exe');
    if (fs.existsSync(wslPath)) {
      shells.push({ name: 'WSL', path: wslPath });
    }

    // cmd.exe
    const cmd = process.env.COMSPEC || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\cmd.exe');
    if (fs.existsSync(cmd)) {
      shells.push({ name: 'Command Prompt', path: cmd });
    }

    return shells;
  }

  private detectMac(): ShellInfo[] {
    const shells: ShellInfo[] = [];
    const seen = new Set<string>();

    const push = (name: string, p: string, args?: string[]): void => {
      if (!p || seen.has(p)) return;
      try {
        if (fs.existsSync(p)) {
          shells.push(args ? { name, path: p, args } : { name, path: p });
          seen.add(p);
        }
      } catch {
        /* skip */
      }
    };

    // $SHELL takes precedence — most users want their configured login shell.
    const envShell = process.env.SHELL;
    if (envShell) {
      const base = path.basename(envShell);
      const friendly =
        base === 'zsh' ? 'Zsh'
        : base === 'bash' ? 'Bash'
        : base === 'fish' ? 'Fish'
        : base === 'pwsh' ? 'PowerShell 7'
        : base.charAt(0).toUpperCase() + base.slice(1);
      push(friendly, envShell);
    }

    // macOS Catalina+ default
    push('Zsh', '/bin/zsh');
    push('Bash', '/bin/bash');
    // Homebrew (Apple Silicon) and legacy Intel locations
    push('PowerShell 7', '/opt/homebrew/bin/pwsh');
    push('PowerShell 7', '/usr/local/bin/pwsh');
    push('Fish', '/opt/homebrew/bin/fish');

    return shells;
  }

  private detectLinux(): ShellInfo[] {
    const shells: ShellInfo[] = [];
    const seen = new Set<string>();

    const push = (name: string, p: string, args?: string[]): void => {
      if (!p || seen.has(p)) return;
      try {
        if (fs.existsSync(p)) {
          shells.push(args ? { name, path: p, args } : { name, path: p });
          seen.add(p);
        }
      } catch {
        /* skip */
      }
    };

    const envShell = process.env.SHELL;
    if (envShell) {
      const base = path.basename(envShell);
      const friendly =
        base === 'bash' ? 'Bash'
        : base === 'zsh' ? 'Zsh'
        : base === 'fish' ? 'Fish'
        : base === 'pwsh' ? 'PowerShell 7'
        : base.charAt(0).toUpperCase() + base.slice(1);
      push(friendly, envShell);
    }

    push('Bash', '/bin/bash');
    push('Zsh', '/bin/zsh');
    push('Fish', '/usr/bin/fish');
    push('PowerShell 7', '/usr/bin/pwsh');
    push('PowerShell 7', '/snap/bin/pwsh');

    return shells;
  }

  private detectUnix(): ShellInfo[] {
    // Fallback for unknown unix-likes — try $SHELL then /bin/sh.
    const shells: ShellInfo[] = [];
    const envShell = process.env.SHELL;
    if (envShell) {
      try {
        if (fs.existsSync(envShell)) {
          shells.push({ name: path.basename(envShell), path: envShell });
        }
      } catch { /* skip */ }
    }
    try {
      if (fs.existsSync('/bin/sh')) {
        shells.push({ name: 'sh', path: '/bin/sh' });
      }
    } catch { /* skip */ }
    return shells;
  }

  getDefault(): string {
    const shells = this.detect();
    if (shells.length > 0) return shells[0].path;
    if (isMac) return process.env.SHELL || '/bin/zsh';
    if (isLinux) return process.env.SHELL || '/bin/bash';
    return 'powershell.exe';
  }
}
