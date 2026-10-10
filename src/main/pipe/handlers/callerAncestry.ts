/**
 * One caller's ancestor chain, read by main itself, for when the full process
 * snapshot is unavailable (on Windows a failed or timed-out Win32_Process
 * snapshot). One PowerShell spawn walks the chain in-process and stops at the
 * first parent created after its child — Windows never re-parents an orphan,
 * so such a parent is a reused pid, not the real one.
 *
 * The result has the snapshot's `ppidByPid` shape so the same walk
 * (`walkToOwningAnchor`) runs over it.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

const MAX_HOPS = 16;

/** `child parent` pairs, one per line, as the script prints them. */
export function parseAncestryOutput(stdout: string): Map<number, number> {
  const ppidByPid = new Map<number, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const child = Number(m[1]);
    const parent = Number(m[2]);
    if (child > 0 && parent > 0 && child !== parent) ppidByPid.set(child, parent);
  }
  return ppidByPid;
}

export function ancestryScript(pid: number): string {
  return (
    `$p=${pid}; for ($i=0; $i -lt ${MAX_HOPS}; $i++) { ` +
    `$c=Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if (-not $c) { break }; ` +
    `$q=Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.ParentProcessId); ` +
    `if (-not $q -or $q.CreationDate -gt $c.CreationDate) { break }; ` +
    `Write-Output ("$p " + $c.ParentProcessId); $p=$c.ParentProcessId }`
  );
}

/** The caller's ancestry on Windows, or null when it cannot be read in time. */
export function readWindowsAncestry(pid: number, timeoutMs: number): Promise<Map<number, number> | null> {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0 || timeoutMs <= 0) {
    return Promise.resolve(null);
  }
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-Command', ancestryScript(pid)],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs },
      (err, stdout) => resolve(err ? null : parseAncestryOutput(String(stdout))),
    );
  });
}
