import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

// #1472 — an approved background run never returned: the worker wrote its
// message to `claude -p`'s stdin and never closed it, and `claude -p` reads
// stdin to EOF before it starts. Nothing bounded the wait, so the task sat in
// `working` forever. These drive execute() against a fake child process.

const { sendToRendererMock, spawnMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  spawnMock: vi.fn(),
}));
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../account/accountStore', () => ({
  getAccountStore: () => ({ resolveAccountEnv: () => ({}) }),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

import {
  ClaudeWorker,
  WORKER_EXIT_DRAIN_MS,
  WORKER_HARD_TIMEOUT_MS,
  WORKER_IDLE_TIMEOUT_MS,
} from '../ClaudeWorker';

interface FakeProc extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = 0; // no pid: kills go through proc.kill, never to a real process
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn() });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => true);
  return proc;
}

const resultLine = (text: string) => Buffer.from(JSON.stringify({ type: 'result', result: text, is_error: false }) + '\n');

/** Task status updates sent so far, in order. */
const statuses = () =>
  sendToRendererMock.mock.calls
    .filter((c) => c[1] === 'a2a.task.update')
    .map((c) => ({ status: (c[2] as { status: string }).status, message: (c[2] as { message?: string }).message }));

let proc: FakeProc;
let worker: ClaudeWorker;

beforeEach(() => {
  sendToRendererMock.mockReset();
  sendToRendererMock.mockResolvedValue(undefined);
  proc = fakeProc();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => proc);
  worker = new ClaudeWorker(() => ({}) as BrowserWindow);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ClaudeWorker run lifecycle (#1472)', () => {
  it('sends the message as stream-json input and then closes stdin', async () => {
    await worker.execute('task-1', 'ws-receiver', 'do the thing');

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');

    expect(proc.stdin.write).toHaveBeenCalledTimes(1);
    const written = JSON.parse(String(proc.stdin.write.mock.calls[0][0]));
    expect(written).toEqual({ type: 'user', message: { role: 'user', content: 'do the thing' } });
    // The fix itself: without EOF `claude -p` never starts the run.
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
    expect(proc.stdin.end.mock.invocationCallOrder[0]).toBeGreaterThan(proc.stdin.write.mock.invocationCallOrder[0]);
  });

  it('stops a run that goes silent, and ignores a result it flushes while dying', async () => {
    vi.useFakeTimers();
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    expect(statuses()).toEqual([{ status: 'working', message: undefined }]);

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TIMEOUT_MS);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(statuses().at(-1)).toEqual({
      status: 'failed',
      message: 'Worker produced no output for 10 min and was stopped',
    });
    expect(worker.isFull).toBe(false);

    // The dying process flushes a result, then exits: neither is a transition.
    proc.stdout.emit('data', resultLine('late'));
    proc.emit('exit', null, 'SIGTERM');
    proc.emit('close', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(WORKER_EXIT_DRAIN_MS);
    expect(statuses().map((s) => s.status)).toEqual(['working', 'failed']);
  });

  it('keeps a run that keeps streaming alive past the idle limit, up to the hard cap', async () => {
    vi.useFakeTimers();
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    const chunk = Buffer.from(JSON.stringify({ type: 'assistant' }) + '\n');

    for (let elapsed = 0; elapsed < WORKER_HARD_TIMEOUT_MS - WORKER_IDLE_TIMEOUT_MS; elapsed += WORKER_IDLE_TIMEOUT_MS / 2) {
      await vi.advanceTimersByTimeAsync(WORKER_IDLE_TIMEOUT_MS / 2);
      proc.stdout.emit('data', chunk);
    }
    expect(statuses().map((s) => s.status)).toEqual(['working']);

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_TIMEOUT_MS);
    expect(statuses().at(-1)).toEqual({ status: 'failed', message: 'Worker ran past the 2 h limit and was stopped' });
  });

  it('fails the task when the worker exits cleanly without a result', async () => {
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    proc.emit('close', 0, null);
    await Promise.resolve();
    expect(statuses().at(-1)).toEqual({ status: 'failed', message: 'Worker exited without a result' });
  });

  it('settles on exit when stdout never closes (a child still holds it)', async () => {
    vi.useFakeTimers();
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    proc.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(WORKER_EXIT_DRAIN_MS);

    expect(statuses().at(-1)).toEqual({ status: 'failed', message: 'Worker exited without a result' });
    // What still holds the pipe is stopped.
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('takes a result that arrives in the drain window after exit', async () => {
    vi.useFakeTimers();
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    proc.emit('exit', 0, null);
    proc.stdout.emit('data', resultLine('OK'));
    await vi.advanceTimersByTimeAsync(WORKER_EXIT_DRAIN_MS);

    expect(statuses()).toEqual([
      { status: 'working', message: undefined },
      { status: 'completed', message: 'OK' },
    ]);
  });

  it('survives a stdin EPIPE and reports the task failed exactly once', async () => {
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    expect(() => proc.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    proc.emit('exit', 1, null);
    proc.emit('close', 1, null);
    await Promise.resolve();
    expect(statuses().filter((s) => s.status === 'failed')).toEqual([
      { status: 'failed', message: 'Process exited with code 1' },
    ]);
  });

  it('completes on a result line and no timer fires afterwards', async () => {
    vi.useFakeTimers();
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    proc.stdout.emit('data', resultLine('OK'));
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(WORKER_HARD_TIMEOUT_MS);

    expect(statuses().map((s) => s.status)).toEqual(['working', 'completed']);
    expect(statuses().at(-1)?.message).toBe('OK');
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('holds the capacity slot across the "working" update, so a burst cannot exceed it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    sendToRendererMock.mockImplementation(() => gate);
    spawnMock.mockImplementation(() => fakeProc());

    const runs = [1, 2, 3, 4, 5].map((n) => worker.execute(`task-${n}`, 'ws-receiver', 'go'));
    release();
    await Promise.all(runs);

    expect(spawnMock).toHaveBeenCalledTimes(4);
    const failed = sendToRendererMock.mock.calls.filter((c) => (c[2] as { status: string }).status === 'failed');
    expect(failed.map((c) => [(c[2] as { taskId: string }).taskId, (c[2] as { message: string }).message]))
      .toEqual([['task-5', 'Worker at capacity']]);
  });

  it('refuses a second execute for a task that is already running', async () => {
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('kills every worker on stop and fails their tasks', async () => {
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    worker.stop();
    await Promise.resolve();
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(statuses().at(-1)).toEqual({ status: 'failed', message: 'wmux quit while the worker was running' });
  });
});
