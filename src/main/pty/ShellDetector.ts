import fs from 'node:fs';
import path from 'node:path';

export interface ShellInfo {
  name: string;
  path: string;
  args?: string[];
}

export class ShellDetector {
  detect(): ShellInfo[] {
    const shells: ShellInfo[] = [];

    // PowerShell 7+ (pwsh)
    const pwshPaths = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\WindowsApps\\pwsh.exe'),
    ];
    for (const p of pwshPaths) {
      if (fs.existsSync(p)) {
        shells.push({ name: 'PowerShell 7', path: p });
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

  getDefault(): string {
    const shells = this.detect();
    return shells.length > 0 ? shells[0].path : 'powershell.exe';
  }
}
