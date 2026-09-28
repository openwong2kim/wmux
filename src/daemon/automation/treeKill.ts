// Kill a PTY's whole process tree before the session is destroyed.
//
// `stopAgent` (chat/agentProcess.ts) needs a ChildProcess we own; a scheduled
// run is a PTY whose root is the wrapper shell, and an agent can leave tool
// subprocesses in their own process groups. So: walk parentage from the PTY
// pid with `ps`, SIGKILL leaves first, then the root. Windows: taskkill /T.

import { execFile } from 'node:child_process';
import path from 'node:path';

/** Every descendant of `root` (root included), from `pid ppid` rows. */
export function collectDescendants(rows: ReadonlyArray<readonly [number, number]>, root: number): number[] {
  const found = new Set<number>([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, ppid] of rows) {
      if (pid > 1 && found.has(ppid) && !found.has(pid)) {
        found.add(pid);
        changed = true;
      }
    }
  }
  return [...found];
}

export function parsePsRows(output: string): Array<[number, number]> {
  const rows: Array<[number, number]> = [];
  for (const line of output.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push([pid, ppid]);
  }
  return rows;
}

export function killProcessTree(rootPid: number): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(rootPid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve());
    });
  }
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (_error, output) => {
      const targets = collectDescendants(parsePsRows(output ?? ''), rootPid);
      // Leaves first, so a parent cannot respawn a child we already killed.
      for (const pid of targets.reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
      resolve();
    });
  });
}
