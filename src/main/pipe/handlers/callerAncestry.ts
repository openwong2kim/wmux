/**
 * One caller's ancestor chain, read by main itself, for when the full process
 * snapshot is unavailable (on Windows a failed or timed-out Win32_Process
 * snapshot). One PowerShell spawn walks the chain in-process and stops at the
 * first parent created after its child — Windows never re-parents an orphan,
 * so such a parent is a reused pid, not the real one.
 *
 * The result has the snapshot's `ppidByPid` shape so the same walk
 * (`walkToOwningAnchor`) runs over it.
 *
 * The chain is read natively first (#2992): the snapshot can fail on its
 * socket tables while the process table still reads, and PowerShell can be
 * stopped by policy or anti-virus. PowerShell runs only when the native
 * process table is unavailable.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { tryProcessCreatedAt, tryProcessHandleApi, type NativeProcRow } from '../../pty/winSnapshotNative';

const MAX_HOPS = 16;

/**
 * The script's walk over a native pid → ppid table: up from `pid`, stopping at
 * a parent that is not listed or was created after its child. An unreadable
 * creation time proves nothing and does not stop it, as in walkToOwningAnchor.
 */
export function walkNativeAncestry(
  pid: number,
  procs: readonly NativeProcRow[],
  createdAt: (pid: number) => bigint | null,
): Map<number, number> {
  const ppidOf = new Map<number, number>();
  for (const row of procs) ppidOf.set(row.pid, row.ppid);
  const ppidByPid = new Map<number, number>();
  let p = pid;
  for (let i = 0; i < MAX_HOPS; i++) {
    const parent = ppidOf.get(p);
    if (parent === undefined || parent <= 0 || parent === p || !ppidOf.has(parent)) break;
    const childCreated = createdAt(p);
    const parentCreated = createdAt(parent);
    if (childCreated !== null && parentCreated !== null && parentCreated > childCreated) break;
    ppidByPid.set(p, parent);
    p = parent;
  }
  return ppidByPid;
}

/** The caller's ancestry from the native process table, or null when that table cannot be read. */
function readNativeAncestry(pid: number): Map<number, number> | null {
  let procs: NativeProcRow[];
  try {
    const api = tryProcessHandleApi();
    if (!api) return null;
    procs = api.processTable();
  } catch {
    return null;
  }
  return walkNativeAncestry(pid, procs, tryProcessCreatedAt);
}

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
  const native = readNativeAncestry(pid);
  if (native) return Promise.resolve(native);
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
