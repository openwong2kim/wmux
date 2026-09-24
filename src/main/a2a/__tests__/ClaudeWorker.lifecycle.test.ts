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

import { ClaudeWorker, WORKER_RUN_TIMEOUT_MS } from '../ClaudeWorker';

interface FakeProc extends EventEmitter {
  pid: number;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = 0; // 0: skip the real process.kill SIGKILL fallback
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn() });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => true);
  return proc;
}

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
  spawnMock.mockReturnValue(proc);
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

  it('fails the task and stops the process when no result arrives in time', async () => {
    vi.useFakeTimers();
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    expect(statuses()).toEqual([{ status: 'working', message: undefined }]);

    await vi.advanceTimersByTimeAsync(WORKER_RUN_TIMEOUT_MS);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(statuses().at(-1)?.status).toBe('failed');
    expect(statuses().at(-1)?.message).toMatch(/no result within 30 min/);
    expect(worker.isFull).toBe(false);

    // The kill's own close must not report the task a second time.
    proc.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    expect(statuses().filter((s) => s.status === 'failed')).toHaveLength(1);
  });

  it('fails the task when the worker exits cleanly without a result', async () => {
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    proc.emit('close', 0, null);
    await Promise.resolve();
    expect(statuses().at(-1)).toEqual({ status: 'failed', message: 'Worker exited without a result' });
  });

  it('completes on a result line and does not time out afterwards', async () => {
    vi.useFakeTimers();
    await worker.execute('task-1', 'ws-receiver', 'do the thing');
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: 'OK', is_error: false }) + '\n'));
    proc.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(WORKER_RUN_TIMEOUT_MS);

    expect(statuses().map((s) => s.status)).toEqual(['working', 'completed']);
    expect(statuses().at(-1)?.message).toBe('OK');
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
