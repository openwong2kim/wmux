import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

// #1473 — the worker's kill path, against REAL processes on every platform CI
// runs (this is the Windows dogfood: on win32 it drives `taskkill /T /F` for
// real). The only substitution is the binary: `claude` is swapped for a node
// script shaped like a worker — a parent that starts a long-sleeping child —
// and every other spawn (taskkill included) goes through untouched.

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../account/accountStore', () => ({
  getAccountStore: () => ({ resolveAccountEnv: () => ({}) }),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) =>
      command === 'claude'
        ? actual.spawn(process.execPath, [process.env.CW_WORKER_SCRIPT as string], options)
        : actual.spawn(command, args, options)) as typeof actual.spawn,
  };
});

import { ClaudeWorker, WORKER_IDLE_TIMEOUT_MS } from '../ClaudeWorker';

// Worker stand-in: starts a child that sleeps forever — on POSIX in a process
// group of its own, as Claude Code does for each Bash tool command — records
// both pids, and then idles without output until it is killed.
const WORKER_SCRIPT = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  detached: process.platform !== 'win32',
});
writeFileSync(process.env.CW_PIDFILE, process.pid + ' ' + child.pid);
setInterval(() => {}, 1000);
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls without setTimeout, so it also works while timers are faked. */
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return cond();
}

let dir = '';
let run = 0;
const leftovers: number[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wmux-worker-tree-'));
  process.env.CW_WORKER_SCRIPT = join(dir, 'worker.js');
  writeFileSync(process.env.CW_WORKER_SCRIPT, WORKER_SCRIPT);
});

afterEach(() => {
  vi.useRealTimers();
  for (const pid of leftovers.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Start a worker and wait until its tree is up. */
async function startTree(worker: ClaudeWorker, taskId: string): Promise<{ parent: number; child: number }> {
  const pidFile = join(dir, `pids-${++run}`);
  process.env.CW_PIDFILE = pidFile;
  sendToRendererMock.mockReset();
  sendToRendererMock.mockResolvedValue(undefined);
  await worker.execute(taskId, 'ws-receiver', 'hang');
  expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').includes(' '), 20_000)).toBe(true);
  const [parent, child] = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
  leftovers.push(parent, child);
  expect(alive(parent)).toBe(true);
  expect(alive(child)).toBe(true);
  return { parent, child };
}

/** How the task ended, as the worker reported it. */
const terminal = () =>
  sendToRendererMock.mock.calls
    .map((c) => c[2] as { status: string; message?: string })
    .filter((u) => u.status === 'failed' || u.status === 'completed');

const GONE_WITHIN_MS = 15_000;

describe(`ClaudeWorker kill path on real processes (${process.platform})`, () => {
  it('cancel takes down the worker and its child, and reports nothing further', async () => {
    const worker = new ClaudeWorker(() => ({}) as BrowserWindow);
    const { parent, child } = await startTree(worker, 'task-cancel');

    expect(worker.cancel('task-cancel')).toBe(true);

    expect(await until(() => !alive(parent) && !alive(child), GONE_WITHIN_MS)).toBe(true);
    // Cancel is recorded by the RPC layer; the worker adds no second outcome.
    await new Promise((r) => setTimeout(r, 500));
    expect(terminal()).toEqual([]);
  }, 60_000);

  it('the idle timeout takes down the worker and its child, and fails the task once', async () => {
    // Only the timer functions are faked: the processes and their I/O stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const worker = new ClaudeWorker(() => ({}) as BrowserWindow);
    const { parent, child } = await startTree(worker, 'task-timeout');

    vi.advanceTimersByTime(WORKER_IDLE_TIMEOUT_MS);
    vi.useRealTimers();

    expect(await until(() => !alive(parent) && !alive(child), GONE_WITHIN_MS)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(terminal()).toHaveLength(1);
    expect(terminal()[0]).toMatchObject({ status: 'failed', message: 'Worker produced no output for 10 min and was stopped' });
  }, 60_000);

  it('stop takes down the worker and its child, and fails the task once', async () => {
    const worker = new ClaudeWorker(() => ({}) as BrowserWindow);
    const { parent, child } = await startTree(worker, 'task-stop');

    worker.stop();

    expect(await until(() => !alive(parent) && !alive(child), GONE_WITHIN_MS)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(terminal()).toHaveLength(1);
    expect(terminal()[0]).toMatchObject({ status: 'failed', message: 'wmux quit while the worker was running' });
  }, 60_000);
});
