import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import launch from 'cross-spawn';

/** Own a process group; never run executable strings through a user shell. */
export function spawnAgent(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return launch(command, args, { cwd, env, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' }) as ChildProcessWithoutNullStreams;
}

/** Called only for a child we own, while its ChildProcess identity is live.
 * A process-group kill also reaches ordinary tool subprocesses. */
export function stopAgent(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000 }, () => undefined);
    return;
  }
  // Some tools start their own process group. Walk parentage before terminating
  // the root, then signal descendants while the original child is still live.
  execFile('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (_error, output) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const rows = output.split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    const descendants = new Set<number>([pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [candidate, parent] of rows) if (candidate > 1 && descendants.has(parent) && !descendants.has(candidate)) {
        descendants.add(candidate); changed = true;
      }
    }
    for (const target of [...descendants].reverse()) {
      try { process.kill(target, 'SIGKILL'); } catch { /* already exited */ }
    }
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already exited */ }
  });
}
