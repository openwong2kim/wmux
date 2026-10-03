import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHILD_WRITE_TIMEOUT_MS, ChildBackend, ChildWriteTimeoutError } from '../childBackend';
import { FakeClaude, until } from './fakeClaude';

afterEach(() => { vi.useRealTimers(); });

describe('ChildBackend', () => {
  it('reaps the process group once the root exits, whatever ended it', async () => {
    const fake = new FakeClaude();
    const backend = fake.backend();
    await backend.start('claude', [], '/tmp', {}, { line: () => undefined, exit: () => undefined });
    const pid = fake.pid!;
    fake.exit(1, null);
    await until(() => !backend.alive);
    expect(fake.reaped).toEqual([pid]);
  });

  it('kills the child when a write does not drain, so the line never lands late', async () => {
    const stopped: unknown[] = [];
    const stdin = new Writable({ write: () => undefined }); // never calls back
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout: new PassThrough(), stderr: new PassThrough(), pid: 3_999_999, exitCode: null, signalCode: null,
    });
    const backend = new ChildBackend(
      () => { setImmediate(() => child.emit('spawn')); return child as unknown as ChildProcessWithoutNullStreams; },
      (c) => stopped.push(c),
      () => undefined,
    );
    await backend.start('claude', [], '/tmp', {}, { line: () => undefined, exit: () => undefined });
    vi.useFakeTimers();
    const writing = backend.write('{"type":"user"}');
    const outcome = expect(writing).rejects.toBeInstanceOf(ChildWriteTimeoutError);
    await vi.advanceTimersByTimeAsync(CHILD_WRITE_TIMEOUT_MS + 1);
    await outcome;
    expect(stopped).toEqual([child]);
  });
});
