import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { processStartTime, statStartTime } from '../processStartTime';

const supported = process.platform === 'darwin' || process.platform === 'linux';
const children: ChildProcess[] = [];

function startChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe.runIf(supported)('processStartTime', () => {
  it('reads the same value for a live process every time', () => {
    const first = processStartTime(process.pid);
    expect(typeof first).toBe('bigint');
    expect(processStartTime(process.pid)).toBe(first);
  });

  it.runIf(process.platform === 'darwin')('is the start time ps reports, in microseconds', () => {
    const lstart = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
    const seconds = Math.floor(Date.parse(lstart) / 1000);
    expect(Number((processStartTime(process.pid) as bigint) / 1_000_000n)).toBe(seconds);
  });

  it('puts a process started later at or after its parent, and tells the two apart', async () => {
    // The test worker has been running for a while, so the child starts later.
    const child = await startChild();
    const parent = processStartTime(process.pid) as bigint;
    const started = processStartTime(child.pid as number) as bigint;
    expect(started).toBeGreaterThanOrEqual(parent);
    expect(started).not.toBe(parent);
  });

  it('has no value for a process that has exited, or for a pid that is not one', async () => {
    const child = await startChild();
    const pid = child.pid as number;
    await new Promise((r) => { child.once('exit', r); child.kill(); });
    expect(processStartTime(pid)).toBeNull();
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(processStartTime(bad), String(bad)).toBeNull();
  });
});

describe.runIf(!supported)('processStartTime where the OS gives no reading here', () => {
  it('has no value', () => {
    expect(processStartTime(process.pid)).toBeNull();
  });
});

describe('statStartTime', () => {
  it('reads field 22 after a command name holding spaces and parentheses', () => {
    const stat = '1234 (my (proc) x) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 12345678 123 18446744073709551615\n';
    expect(statStartTime(stat)).toBe(98765n);
  });

  it('has no value for a line that is cut short or not one', () => {
    expect(statStartTime('1234 (sh) S 1 1234')).toBeNull();
    expect(statStartTime('garbage')).toBeNull();
  });
});

describe.runIf(process.platform === 'darwin' && process.getuid?.() !== 0)('processStartTime on macOS, another user', () => {
  // proc_pidinfo refuses another user's process (EPERM), so no start time is
  // read for it and main refuses its claim as `start-unread`. launchd (pid 1)
  // runs as root.
  it('reads no start time for a process running as another user', () => {
    expect(processStartTime(1)).toBeNull();
  });
});
