import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class MetadataCollector {
  async getGitBranch(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        timeout: 3000,
      });
      const branch = stdout.trim();
      return branch || undefined;
    } catch {
      return undefined;
    }
  }

  async getListeningPorts(pid?: number): Promise<number[]> {
    if (pid !== undefined && !(Number.isInteger(pid) && pid > 0)) {
      return [];
    }
    try {
      // Use PowerShell to get listening TCP connections
      const script = pid
        ? `Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`
        : `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -ne 0 -and $_.OwningProcess -ne 4 } | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique | Select-Object -First 20`;

      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
        timeout: 5000,
      });

      const ports = stdout
        .trim()
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((p) => !isNaN(p) && p > 0);

      return [...new Set(ports)].sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  async collect(cwd?: string): Promise<{ gitBranch?: string; cwd?: string; listeningPorts?: number[] }> {
    const [gitBranch, listeningPorts] = await Promise.all([
      cwd ? this.getGitBranch(cwd) : Promise.resolve(undefined),
      this.getListeningPorts(),
    ]);

    return {
      gitBranch,
      cwd,
      listeningPorts: listeningPorts.length > 0 ? listeningPorts : undefined,
    };
  }
}
