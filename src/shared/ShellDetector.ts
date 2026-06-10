import fs from 'node:fs';
import path from 'node:path';
import { isMac, isLinux, platformChoice } from './platform';
import { findWindowsPwsh7, windowsPowerShell51Path } from './shellResolution';

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

  private detectWindows(): ShellInfo[] {
    const shells: ShellInfo[] = [];

    // PowerShell 7+ (pwsh) — candidate paths + Store-alias readlink resolution
    // live in shared/shellResolution (#179/#183) so the daemon resolves the
    // exact same set of installs as the main process.
    const pwsh7 = findWindowsPwsh7();
    if (pwsh7) {
      shells.push({ name: 'PowerShell 7', path: pwsh7 });
    }

    // Windows PowerShell 5.1
    const ps5 = windowsPowerShell51Path();
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
