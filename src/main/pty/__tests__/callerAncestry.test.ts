import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, nativeTableMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  nativeTableMock: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: execFileMock,
}));
vi.mock('../winSnapshotNative', () => ({ tryNativeProcessTable: nativeTableMock }));

import {
  cachedFor,
  CallerTableResolver,
  callerDescendsFrom,
  createPaneAncestryGate,
  daemonLiveShellPid,
  identitySnapshot,
} from '../callerAncestry';

const snap = (entries: Array<[number, number]>) => async () => ({ ppidByPid: new Map(entries), listeners: [] });

describe('callerDescendsFrom', () => {
  const table = new Map<number, number>([[30, 20], [20, 10], [10, 1], [40, 1]]);

  it('finds the claimed shell among the caller\'s ancestors', () => {
    expect(callerDescendsFrom(30, table, 10)).toBe(true);
  });

  it('counts the caller\'s own pid only when it is the claimed shell', () => {
    expect(callerDescendsFrom(40, table, 40)).toBe(true);
    expect(callerDescendsFrom(40, table, 10)).toBe(false);
  });

  it('stops on cycles and unknown parents', () => {
    expect(callerDescendsFrom(5, new Map([[5, 6], [6, 5]]), 99)).toBe(false);
    expect(callerDescendsFrom(77, table, 10)).toBe(false);
  });
});

describe('CallerTableResolver', () => {
  it('reuses a fresh table that already contains the caller', async () => {
    const fn = vi.fn(snap([[30, 1]]));
    const r = new CallerTableResolver(fn);
    await r.tableFor(30, 1000);
    await r.tableFor(30, 1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('falls back to a recent good table when both reads fail', async () => {
    let now = 0;
    let fail = false;
    const r = new CallerTableResolver(async () => {
      if (fail) throw new Error('down');
      return { ppidByPid: new Map([[30, 20]]), listeners: [] };
    }, () => now);
    expect(await r.tableFor(30, 1000)).not.toBeNull();
    fail = true;
    now = 10_000; // past the reuse window, inside the last-good window
    expect((await r.tableFor(30, 1000))?.get(30)).toBe(20);
    now = 60_000; // too old to trust
    expect(await r.tableFor(30, 1000)).toBeNull();
  });
});

describe('createPaneAncestryGate', () => {
  const resolver = () => new CallerTableResolver(snap([[30, 20], [20, 10], [10, 1]]));

  it('hit / miss by the claimed pane\'s live shell pid', async () => {
    const gate = createPaneAncestryGate({ resolver: resolver(), liveShellPid: async (p) => (p === 'A' ? 10 : 99) });
    expect(await gate.check(30, 'A')).toBe('hit');
    expect(await gate.check(30, 'B')).toBe('miss');
  });

  it('a dead session is a miss; an unreadable session list is unavailable', async () => {
    const dead = daemonLiveShellPid(async () => [{ id: 'A', pid: 10, state: 'dead' }]);
    expect(await createPaneAncestryGate({ resolver: resolver(), liveShellPid: dead }).check(30, 'A')).toBe('miss');
    const broken = daemonLiveShellPid(async () => { throw new Error('daemon down'); });
    expect(await createPaneAncestryGate({ resolver: resolver(), liveShellPid: broken }).check(30, 'A')).toBe('unavailable');
  });
});

describe('identitySnapshot', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => { execFileMock.mockReset(); nativeTableMock.mockReset(); });
  afterEach(() => { Object.defineProperty(process, 'platform', platform); });

  it('win32: uses the native process table when it is available', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    nativeTableMock.mockReturnValue([{ pid: 30, ppid: 20 }]);
    const s = await identitySnapshot(1000);
    expect(s.ppidByPid.get(30)).toBe(20);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('win32: falls back to one CIM query when the native table is unavailable', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    nativeTableMock.mockReturnValue(null);
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string }) => void) => {
      cb(null, { stdout: '30 20\r\n20 4\r\n' });
    });
    const s = await identitySnapshot(1000);
    expect(s.ppidByPid.get(30)).toBe(20);
    expect(execFileMock.mock.calls[0][0]).toMatch(/powershell\.exe$/i);
  });

  it('rejects an empty table instead of reporting it as a successful read', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string }) => void) => {
      cb(null, { stdout: '' });
    });
    await expect(identitySnapshot(1000)).rejects.toThrow();
  });
});

describe('cachedFor', () => {
  it('shares one read inside the window and drops a failed read', async () => {
    let now = 0;
    let fail = false;
    const read = vi.fn(async () => { if (fail) throw new Error('down'); return [1]; });
    const get = cachedFor(read, 1500, () => now);
    await get(); await get();
    expect(read).toHaveBeenCalledTimes(1);
    now = 2000; fail = true;
    await expect(get()).rejects.toThrow();
    fail = false;
    await get();
    expect(read).toHaveBeenCalledTimes(3);
  });
});
