// Kill a PTY's whole process tree before the session is destroyed.
//
// `stopAgent` (chat/agentProcess.ts) needs a ChildProcess we own; a scheduled
// run is a PTY whose root is the wrapper shell, and an agent can leave tool
// subprocesses in their own process groups. So, on POSIX:
//   1. freeze: SIGSTOP the root and every descendant found by walking
//      `ps -axo pid,ppid`, rescanning until no new descendant appears (a
//      frozen parent cannot fork a child the next scan would miss);
//   2. SIGKILL everything found, leaves first, then the PTY's process group
//      (the PTY root is a session leader, so its pgid is its pid) and the root.
// The group and root kills run even when `ps` fails or returns nothing.
// Windows: taskkill /T /F.

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

export interface TreeKillDeps {
  /** `pid ppid` rows of the process table; [] when it cannot be read. */
  listProcesses: () => Promise<Array<[number, number]>>;
  signal: (pid: number, sig: NodeJS.Signals) => void;
}

/** Freeze-and-rescan rounds before the kill. */
export const TREE_KILL_SCAN_ROUNDS = 4;

const defaultDeps: TreeKillDeps = {
  listProcesses: () =>
    new Promise((resolve) => {
      execFile('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => {
        resolve(error ? [] : parsePsRows(output ?? ''));
      });
    }),
  signal: (pid, sig) => process.kill(pid, sig),
};

export async function killProcessTreePosix(rootPid: number, deps: TreeKillDeps = defaultDeps): Promise<void> {
  const send = (pid: number, sig: NodeJS.Signals): void => {
    try { deps.signal(pid, sig); } catch { /* already exited */ }
  };
  const targets = new Set<number>();
  for (let round = 0; round < TREE_KILL_SCAN_ROUNDS; round++) {
    let rows: Array<[number, number]> = [];
    try {
      rows = await deps.listProcesses();
    } catch {
      rows = [];
    }
    if (rows.length === 0) break;
    let added = 0;
    for (const pid of collectDescendants(rows, rootPid)) {
      if (targets.has(pid)) continue;
      targets.add(pid);
      send(pid, 'SIGSTOP');
      added++;
    }
    if (added === 0) break;
  }
  // Leaves first (discovery order is parent-before-child).
  for (const pid of [...targets].reverse()) send(pid, 'SIGKILL');
  send(-rootPid, 'SIGKILL');
  send(rootPid, 'SIGKILL');
}

export function killProcessTree(rootPid: number): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(rootPid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve());
    });
  }
  return killProcessTreePosix(rootPid);
}
