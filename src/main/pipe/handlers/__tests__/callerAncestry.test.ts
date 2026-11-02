// @wmux-lane unit — 'win32' here is the platform the ancestry read is told it runs on; the native table, creation times and execFile are all fakes.
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  table: null as Array<{ pid: number; ppid: number }> | null,
  created: new Map<number, bigint>(),
}));
vi.mock('../../../pty/winSnapshotNative', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../pty/winSnapshotNative')>()),
  tryProcessHandleApi: () => (native.table === null ? null : { processTable: () => native.table }),
  tryProcessCreatedAt: (pid: number) => native.created.get(pid) ?? null,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn((_file: string, _args: string[], _opts: unknown, done: (err: Error | null, stdout: string) => void) => {
    done(null, '7 8\r\n');
  }),
}));

import { execFile } from 'node:child_process';
import { ancestryScript, parseAncestryOutput, readWindowsAncestry, walkNativeAncestry } from '../callerAncestry';

describe('callerAncestry', () => {
  it('parses child/parent pairs and skips noise', () => {
    expect([...parseAncestryOutput('39876 25020\r\n25020 49076\r\n\r\nbogus\r\n7 7\r\n')]).toEqual([
      [39876, 25020],
      [25020, 49076],
    ]);
  });

  it('stops the chain at a parent created after its child', () => {
    expect(ancestryScript(42)).toContain('$q.CreationDate -gt $c.CreationDate');
    expect(ancestryScript(42)).toMatch(/^\$p=42;/);
  });
});

describe('walkNativeAncestry', () => {
  const procs = [
    { pid: 300, ppid: 200 },
    { pid: 200, ppid: 100 },
    { pid: 100, ppid: 4 },
  ];
  const times = (entries: Array<[number, number]>) => {
    const map = new Map(entries.map(([pid, t]) => [pid, BigInt(t)]));
    return (pid: number) => map.get(pid) ?? null;
  };

  it('walks up while each parent is listed and no newer than its child', () => {
    expect([...walkNativeAncestry(300, procs, times([[300, 30], [200, 20], [100, 10]]))]).toEqual([
      [300, 200],
      [200, 100],
    ]);
  });

  it('stops at a parent created after its child: a reused pid, not the parent', () => {
    expect([...walkNativeAncestry(300, procs, times([[300, 30], [200, 40], [100, 10]]))]).toEqual([]);
    expect([...walkNativeAncestry(300, procs, times([[300, 30], [200, 20], [100, 25]]))]).toEqual([[300, 200]]);
  });

  it('walks past an unreadable creation time, which proves nothing', () => {
    // Another account's process: its time cannot be read, so its edges cannot be judged.
    expect([...walkNativeAncestry(300, procs, times([[300, 30], [100, 10]]))]).toEqual([
      [300, 200],
      [200, 100],
    ]);
    expect([...walkNativeAncestry(300, procs, () => null)]).toEqual([
      [300, 200],
      [200, 100],
    ]);
  });

  it('is empty for a caller missing from the table, and bounded on a cycle', () => {
    expect(walkNativeAncestry(999, procs, () => 1n).size).toBe(0);
    const cycle = [{ pid: 1, ppid: 2 }, { pid: 2, ppid: 1 }];
    expect(walkNativeAncestry(1, cycle, () => 1n).size).toBe(2);
  });
});

describe('readWindowsAncestry', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    native.table = null;
    native.created.clear();
    vi.mocked(execFile).mockClear();
  });

  it('reads the chain natively without PowerShell', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    native.table = [{ pid: 300, ppid: 200 }, { pid: 200, ppid: 100 }];
    native.created.set(300, 30n).set(200, 20n);
    expect([...(await readWindowsAncestry(300, 1000))!]).toEqual([[300, 200]]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('asks PowerShell only when the native table cannot be read', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    expect([...(await readWindowsAncestry(300, 1000))!]).toEqual([[7, 8]]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
