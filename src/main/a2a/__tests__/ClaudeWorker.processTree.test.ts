import { spawn, type ChildProcess } from 'node:child_process';
import { describe, it, expect, afterEach, vi } from 'vitest';

// #1472 review — stopping a worker must take its children with it. A
// bypassPermissions run starts shell tools, builds and MCP servers; signalling
// only the `claude` pid left them running after the task was marked failed.
// These use real processes, so they only run where process groups exist.

vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../account/accountStore', () => ({
  getAccountStore: () => ({ resolveAccountEnv: () => ({}) }),
}));

import { terminateProcessTree } from '../ClaudeWorker';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};

/** First stdout line of a process. */
const firstLine = (proc: ChildProcess): Promise<string> =>
  new Promise((resolve) => {
    let buf = '';
    proc.stdout?.on('data', (c: Buffer) => {
      buf += c.toString();
      const i = buf.indexOf('\n');
      if (i !== -1) resolve(buf.slice(0, i).trim());
    });
  });

const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

describe.skipIf(process.platform === 'win32')('terminateProcessTree (real processes)', () => {
  it('takes down the children, not just the leader', async () => {
    // Leader shell starts a long sleep as its child and reports its pid, the
    // way a worker's Bash tool leaves a process behind.
    const proc = spawn('sh', ['-c', 'sleep 300 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const child = Number(await firstLine(proc));
    leftovers.push(child, proc.pid ?? 0);
    expect(alive(child)).toBe(true);

    terminateProcessTree(proc, 200);

    expect(await waitFor(() => !alive(child), 3000)).toBe(true);
    expect(await waitFor(() => proc.exitCode !== null || proc.signalCode !== null, 3000)).toBe(true);
  });

  // Claude Code runs each Bash tool command in a process group of its own, so
  // signalling the worker's group alone left the command running, reparented
  // to init. This child also ignores SIGTERM, and its parent dies on SIGTERM:
  // only the groups snapshotted before the kill can still reach it.
  it('reaches a child in its own process group after its parent is gone', async () => {
    const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const leaderScript =
      "const { spawn } = require('node:child_process');" +
      `const c = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' });` +
      'console.log(c.pid); setInterval(() => {}, 1000);';
    const proc = spawn(process.execPath, ['-e', leaderScript], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const child = Number(await firstLine(proc));
    leftovers.push(child, proc.pid ?? 0);
    expect(alive(child)).toBe(true);

    terminateProcessTree(proc, 300);

    expect(await waitFor(() => proc.exitCode !== null || proc.signalCode !== null, 3000)).toBe(true);
    expect(await waitFor(() => !alive(child), 3000)).toBe(true);
  });

  it('escalates to SIGKILL for a process that ignores SIGTERM', async () => {
    const proc = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
    );
    await firstLine(proc);
    leftovers.push(proc.pid ?? 0);

    terminateProcessTree(proc, 300);

    // Past SIGTERM, still running...
    await new Promise((r) => setTimeout(r, 150));
    expect(proc.exitCode).toBeNull();
    expect(proc.signalCode).toBeNull();
    // ...until the fallback lands.
    expect(await waitFor(() => proc.signalCode === 'SIGKILL', 3000)).toBe(true);
  });
});
