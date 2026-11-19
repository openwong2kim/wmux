// @wmux-lane integration — the sink writes its daily log into a mkdtemp directory.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #3440: when the launcher made the daemon's stderr the rotated
 * daemon-stderr.log (DAEMON_STDERR_TO_FILE_ENV), the sink stops copying
 * console output onto stderr, so that file holds only what bypasses the sink
 * (a native abort's line). Without the flag, stderr is teed as before.
 */
class RecordingStream extends EventEmitter {
  chunks: string[] = [];
  write(chunk: unknown, ...rest: unknown[]): boolean {
    this.chunks.push(String(chunk));
    const callback = rest[rest.length - 1];
    if (typeof callback === 'function') queueMicrotask(() => (callback as () => void)());
    return true;
  }
}

const ENV = 'WMUX_DAEMON_STDERR_TO_FILE';

describe('daemon log sink: stderr as the launcher file', () => {
  let dir: string;
  let stdout: RecordingStream;
  let stderr: RecordingStream;
  const realStdout = process.stdout;
  const realStderr = process.stderr;
  let prevFlag: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    prevFlag = process.env[ENV];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-daemon-stderr-'));
    stdout = new RecordingStream();
    stderr = new RecordingStream();
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
    Object.defineProperty(process, 'stderr', { value: stderr, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true });
    Object.defineProperty(process, 'stderr', { value: realStderr, configurable: true });
    if (prevFlag === undefined) delete process.env[ENV];
    else process.env[ENV] = prevFlag;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function dailyLog(): string {
    const name = fs.readdirSync(path.join(dir, 'logs')).find((f) => f.endsWith('.log'));
    if (!name) throw new Error('the sink wrote no daily log');
    return fs.readFileSync(path.join(dir, 'logs', name), 'utf8');
  }

  it('with the flag: console lines reach the daily log only, and the flag is not inherited', async () => {
    process.env[ENV] = '1';
    const sink = await import('../logSink');
    expect(sink.DAEMON_STDERR_TO_FILE_ENV).toBe(ENV);
    sink.initDaemonLogSink(dir);
    expect(process.env[ENV]).toBeUndefined();
    expect(sink.stdioErrorsConsumed()).toBe(true);

    const done = vi.fn();
    process.stderr.write('[daemon] a warning line\n', done);
    sink.logLine('error', 'test', 'an error line');
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(stderr.chunks).toEqual([]);
    expect(done).toHaveBeenCalledTimes(1);
    const log = dailyLog();
    expect(log).toContain('daemon sink started');
    expect(log).toContain('[daemon] a warning line');
    expect(log).toContain('[error] [test] an error line');
    // stdout is unchanged: still teed.
    process.stdout.write('an info line\n');
    expect(stdout.chunks).toEqual(['an info line\n']);
  });

  it('with the flag: a line the daily log cannot take (no log dir) goes to stderr instead', async () => {
    process.env[ENV] = '1';
    fs.writeFileSync(path.join(dir, 'logs'), 'a file where the log dir should be');
    const sink = await import('../logSink');
    sink.initDaemonLogSink(dir);
    const done = vi.fn();
    process.stderr.write('[daemon] a warning line\n', done);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(stderr.chunks.some((c) => c.includes('daemon sink started'))).toBe(true);
    expect(stderr.chunks).toContain('[daemon] a warning line\n');
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('with the flag: a line whose append fails goes to stderr, and the next one that fits goes to the log only', async () => {
    process.env[ENV] = '1';
    // Today's log path is a directory: every append to it fails.
    const today = path.join(dir, 'logs', `daemon-${new Date().toISOString().slice(0, 10)}.log`);
    fs.mkdirSync(today, { recursive: true });
    const sink = await import('../logSink');
    sink.initDaemonLogSink(dir);
    process.stderr.write('[daemon] first line\n');
    expect(stderr.chunks).toContain('[daemon] first line\n');
    fs.rmdirSync(today);
    process.stderr.write('[daemon] second line\n');
    expect(stderr.chunks).not.toContain('[daemon] second line\n');
    expect(dailyLog()).toContain('[daemon] second line');
  });

  it('without the flag: stderr is teed as before', async () => {
    delete process.env[ENV];
    const sink = await import('../logSink');
    sink.initDaemonLogSink(dir);
    process.stderr.write('[daemon] a warning line\n');
    expect(stderr.chunks.some((c) => c.includes('daemon sink started'))).toBe(true);
    expect(stderr.chunks).toContain('[daemon] a warning line\n');
    expect(dailyLog()).toContain('[daemon] a warning line');
  });

  it('a value other than 1 keeps the tee', async () => {
    process.env[ENV] = '0';
    const sink = await import('../logSink');
    sink.initDaemonLogSink(dir);
    process.stderr.write('[daemon] a warning line\n');
    expect(stderr.chunks).toContain('[daemon] a warning line\n');
  });
});
