import { describe, expect, it, vi } from 'vitest';
import { captureTreePosix, captureTreeWin32, matchesRecordedStart, parsePsIdentityRows, recordedStartOf, survivorsStillRunning, survivorsStillRunningWin32, type PosixProcRow, type PosixTreeDeps } from '../verifiedTreeKill';
import type { ProcessHandle, ProcessHandleApi, ProcessOpenResult } from '../../../main/pty/winSnapshotNative';

const noWait = async (): Promise<void> => undefined;

interface FakeProc {
  pid: number;
  ppid: number;
  createdAt: bigint;
  exited?: boolean;
  /** Ignores TerminateProcess. */
  unkillable?: boolean;
  /** Elevated: may be waited on, not terminated. */
  denied?: boolean;
  /** OpenProcess fails outright. */
  unopenable?: boolean;
  /** Started by its parent when the parent is first terminated (a late child). */
  spawnsOnTerminate?: FakeProc;
  /** Listed in the table, but exited before it can be opened. */
  goneOnOpen?: boolean;
}

/** A Windows process table behind the ProcessHandleApi surface. */
function fakeWin(procs: FakeProc[], opts: { now?: bigint | ((tableReads: number) => bigint); tableFails?: boolean; tables?: Array<Array<{ pid: number; ppid: number }>> } = {}) {
  let tableReads = 0;
  const table = new Map(procs.map((p) => [p.pid, p]));
  const handles = new Map<ProcessHandle, FakeProc>();
  const opened: number[] = [];
  const terminated: number[] = [];
  let open = 0;
  const api: ProcessHandleApi = {
    processTable: () => {
      if (opts.tableFails) throw new Error('snapshot failed');
      const scripted = opts.tables?.[tableReads++];
      if (scripted) return scripted;
      return [...table.values()].filter((p) => !p.exited).map(({ pid, ppid }) => ({ pid, ppid }));
    },
    open: (pid): ProcessOpenResult => {
      const p = table.get(pid);
      if (!p || p.exited || p.goneOnOpen) return { gone: true };
      if (p.unopenable) return { failure: 'OpenProcess failed (error 5)' };
      const handle = { pid } as unknown as ProcessHandle;
      handles.set(handle, p);
      opened.push(pid);
      open++;
      return { handle, createdAt: p.createdAt, canTerminate: !p.denied };
    },
    terminate: (h) => {
      const p = handles.get(h)!;
      terminated.push(p.pid);
      if (p.unkillable) return false;
      p.exited = true;
      if (p.spawnsOnTerminate && !table.has(p.spawnsOnTerminate.pid)) table.set(p.spawnsOnTerminate.pid, p.spawnsOnTerminate);
      return true;
    },
    hasExited: (h) => handles.get(h)!.exited === true,
    close: () => { open--; },
    now: () => (typeof opts.now === 'function' ? opts.now(tableReads) : opts.now ?? 1_000n),
  };
  return { api, opened, terminated, openHandles: () => open };
}

describe('captureTreeWin32', () => {
  it('kills the root and every descendant and verifies each exited', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n },
      { pid: 12, ppid: 11, createdAt: 120n },
      { pid: 99, ppid: 1, createdAt: 50n },
    ]);
    const tree = captureTreeWin32(10, f.api, { sleep: noWait })!;
    expect(tree.pids().sort()).toEqual([10, 11, 12]);
    const r = await tree.kill({ timeoutMs: 100 });
    expect(r).toEqual({ ok: true, killed: [10, 11, 12] });
    expect(f.terminated).not.toContain(99);
    expect(f.openHandles()).toBe(0);
  });

  it('never takes an orphan whose dead parent pid went to a process of the tree', async () => {
    // 77 was started by an earlier process that had pid 11; 11 is ours now.
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n },
      { pid: 77, ppid: 11, createdAt: 40n },
      { pid: 78, ppid: 77, createdAt: 45n },
    ]);
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 100 });
    expect(r).toEqual({ ok: true, killed: [10, 11] });
    expect(f.terminated).not.toContain(77);
    expect(f.terminated).not.toContain(78);
  });

  it('never takes a process created after the table was read', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 5_000n },
    ], { now: 1_000n });
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 0 });
    expect(f.terminated).not.toContain(11);
    expect(r.killed).toEqual([10]);
  });

  it('reports the tree unverified when a listed child with children of its own lost its pid to a later process', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 99, createdAt: 1_500n },
      { pid: 12, ppid: 11, createdAt: 900n },
    ], {
      now: (tableReads) => (tableReads === 0 ? 1_000n : 2_000n),
      tables: [[{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }]],
    });
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 100 });
    expect(f.terminated).not.toContain(11);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors).toEqual([expect.objectContaining({ pid: 11, unverified: true })]);
  });

  it('never takes a process that took a listed child\'s pid while the table was read', async () => {
    // The table lists 11 under 10 (its first owner, gone since); the process
    // now on 11 was created after the table was asked for, under another parent.
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 99, createdAt: 1_500n },
    ], {
      // The clock reads 1000 before the first table, 2000 after it.
      now: (tableReads) => (tableReads === 0 ? 1_000n : 2_000n),
      tables: [[{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }]],
    });
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 100 });
    expect(f.terminated).not.toContain(11);
    expect(r).toEqual({ ok: true, killed: [10] });
  });

  it('finds and kills a child a captured process started during the kill', async () => {
    const late: FakeProc = { pid: 13, ppid: 11, createdAt: 130n };
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, spawnsOnTerminate: late },
    ]);
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 100 });
    expect(r).toEqual({ ok: true, killed: [10, 11, 13] });
    expect(f.terminated).toContain(13);
  });

  it('fails closed when the tree is still starting processes at the deadline', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, spawnsOnTerminate: { pid: 13, ppid: 11, createdAt: 130n } },
    ]);
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors[0].reason).toMatch(/kept starting processes/);
  });

  it('fails closed when a process exits between the table and its opening while its children run', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, goneOnOpen: true },
      { pid: 12, ppid: 11, createdAt: 120n },
    ]);
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors).toEqual([expect.objectContaining({ pid: 11, unverified: true })]);
    // A process that exits with no children left in the table is no question.
    const g = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, goneOnOpen: true },
    ]);
    expect((await captureTreeWin32(10, g.api, { sleep: noWait })!.kill({ timeoutMs: 100 })).ok).toBe(true);
  });

  it('fails closed when a descendant does not exit', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, unkillable: true },
    ]);
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors).toEqual([{ pid: 11, reason: 'TerminateProcess failed', startTime: '110' }]);
    expect(f.openHandles()).toBe(0);
  });

  it('fails closed on a descendant it may not terminate (elevated)', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, denied: true },
    ]);
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors.map((s) => s.pid)).toEqual([11]);
  });

  it('reports the tree unverified when a child it could not identify has children of its own', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, unopenable: true },
      { pid: 12, ppid: 11, createdAt: 120n },
    ]);
    const tree = captureTreeWin32(10, f.api, { sleep: noWait })!;
    const r = await tree.kill({ timeoutMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors).toEqual([expect.objectContaining({ pid: 11, unverified: true })]);
  });

  it('fails closed on a child it cannot identify', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, unopenable: true },
    ]);
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors.map((s) => s.pid)).toEqual([11]);
  });

  it('keeps a child it could not identify unverified even once it is gone', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, unopenable: true },
    ]);
    const tree = captureTreeWin32(10, f.api, { sleep: noWait })!;
    // 11 exits after the capture (a grandchild it started would be out of reach).
    f.api.processTable = () => [{ pid: 10, ppid: 1 }];
    const r = await tree.kill({ timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors).toEqual([expect.objectContaining({ pid: 11, unverified: true })]);
  });

  it('fails closed when the process table cannot be read', async () => {
    const f = fakeWin([{ pid: 10, ppid: 1, createdAt: 100n }], { tableFails: true });
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 0 });
    expect(r.ok).toBe(false);
  });

  it('has no tree when the root is gone, or is not the caller\'s process', () => {
    expect(captureTreeWin32(10, fakeWin([]).api)).toBeNull();
    const f = fakeWin([{ pid: 10, ppid: 1, createdAt: 100n }, { pid: 11, ppid: 10, createdAt: 110n }]);
    expect(captureTreeWin32(10, f.api, { rootIsOurs: (t) => t === '42' })).toBeNull();
    expect(f.terminated).toEqual([]);
    expect(f.openHandles()).toBe(0);
  });

  it('release() kills nothing and closes every handle', () => {
    const f = fakeWin([{ pid: 10, ppid: 1, createdAt: 100n }, { pid: 11, ppid: 10, createdAt: 110n }]);
    captureTreeWin32(10, f.api)!.release();
    expect(f.terminated).toEqual([]);
    expect(f.openHandles()).toBe(0);
  });
});

function fakePosix(initial: PosixProcRow[], opts: { stuck?: number[]; reuse?: Record<number, string>; failAfter?: number } = {}) {
  const rows = new Map(initial.map((r) => [r.pid, { ...r }]));
  const signals: Array<[number, NodeJS.Signals]> = [];
  let reads = 0;
  const deps: PosixTreeDeps = {
    listProcesses: async () => {
      reads++;
      if (opts.failAfter !== undefined && reads > opts.failAfter) throw new Error('ps failed');
      return [...rows.values()].map((r) => ({ ...r }));
    },
    signal: (pid, sig) => {
      signals.push([pid, sig]);
      if (sig !== 'SIGKILL' || pid < 0 || opts.stuck?.includes(pid)) return;
      const r = rows.get(pid);
      if (!r) return;
      // A reused pid: the old process is gone, another one took the number.
      if (opts.reuse?.[pid]) rows.set(pid, { ...r, start: opts.reuse[pid], stat: 'S' });
      else r.stat = 'Z';
    },
  };
  return { deps, signals };
}

const row = (pid: number, ppid: number, start = `t${pid}`): PosixProcRow => ({ pid, ppid, stat: 'S', start });

describe('captureTreePosix', () => {
  it('freezes the tree, kills it, and verifies every process is gone or a zombie', async () => {
    const f = fakePosix([row(1, 0), row(100, 1), row(101, 100), row(102, 101), row(200, 1)]);
    const tree = (await captureTreePosix(100, f.deps, { sleep: noWait }))!;
    expect(f.signals.filter(([, s]) => s === 'SIGSTOP').map(([p]) => p)).toEqual([100, 101, 102]);
    const r = await tree.kill({ timeoutMs: 100 });
    expect(r).toEqual({ ok: true, killed: [100, 101, 102] });
    expect(f.signals.some(([p]) => p === 200)).toBe(false);
  });

  it('counts a pid another process took as gone', async () => {
    const f = fakePosix([row(1, 0), row(100, 1), row(101, 100)], { reuse: { 101: 'later' } });
    const r = await (await captureTreePosix(100, f.deps, { sleep: noWait }))!.kill({ timeoutMs: 100 });
    expect(r.ok).toBe(true);
  });

  it('fails closed when a process survives the kill', async () => {
    const f = fakePosix([row(1, 0), row(100, 1), row(101, 100)], { stuck: [101] });
    const r = await (await captureTreePosix(100, f.deps, { sleep: noWait }))!.kill({ timeoutMs: 0 });
    expect(r).toEqual({ ok: false, killed: [100], survivors: [{ pid: 101, reason: 'still running', startTime: 't101' }] });
  });

  it('fails closed when a process of the tree cannot be frozen', async () => {
    const f = fakePosix([row(1, 0), row(100, 1), row(101, 100)]);
    const signal = f.deps.signal;
    f.deps.signal = (pid, sig) => {
      if (pid === 101 && sig === 'SIGSTOP') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      signal(pid, sig);
    };
    const r = await (await captureTreePosix(100, f.deps, { sleep: noWait }))!.kill({ timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors.map((x) => x.reason).join()).toMatch(/could not be frozen/);
  });

  it('never follows a captured pid another process took while the tree was frozen', async () => {
    let reads = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const deps: PosixTreeDeps = {
      listProcesses: async () => {
        reads++;
        // Read 1: 100 -> 101. Read 2: 101 was killed by someone else and
        // another process got its pid, with a child of its own (102), and
        // 100 also started 103 before it was frozen.
        if (reads === 1) return [row(1, 0), row(100, 1), row(101, 100)];
        return [row(1, 0), row(100, 1), { pid: 101, ppid: 100, stat: 'S', start: 'other' }, row(102, 101), row(103, 100)];
      },
      signal: (pid, sig) => { signals.push([pid, sig]); },
    };
    const tree = (await captureTreePosix(100, deps, { sleep: noWait }))!;
    expect(signals.some(([p]) => p === 102)).toBe(false);
    const r = await tree.kill({ timeoutMs: 0 });
    expect(signals.some(([p]) => p === 102)).toBe(false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors.map((x) => x.reason).join()).toMatch(/replaced while frozen/);
  });

  it('fails closed when the tree is still growing after every capture round', async () => {
    let next = 101;
    const rows = [row(1, 0), row(100, 1)];
    const deps: PosixTreeDeps = {
      // Every read shows one more descendant: the capture never settles.
      listProcesses: async () => {
        rows.push(row(next, next - 1));
        next++;
        return rows.map((r) => ({ ...r }));
      },
      signal: (pid, sig) => {
        const r = rows.find((x) => x.pid === pid);
        if (sig === 'SIGKILL' && r) r.stat = 'Z';
      },
    };
    const r = await (await captureTreePosix(100, deps, { sleep: noWait }))!.kill({ timeoutMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors.map((x) => x.reason).join()).toMatch(/still growing/);
  });

  it('fails closed when the table cannot be read to verify, naming each process by its start time', async () => {
    const f = fakePosix([row(1, 0), row(100, 1)], { failAfter: 2 });
    const r = await (await captureTreePosix(100, f.deps, { sleep: noWait }))!.kill({ timeoutMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors).toContainEqual(expect.objectContaining({ pid: 100, startTime: 't100' }));
  });

  it('has no tree when the root is gone, a zombie, or not the caller\'s process', async () => {
    expect(await captureTreePosix(100, fakePosix([row(1, 0)]).deps)).toBeNull();
    expect(await captureTreePosix(100, fakePosix([{ ...row(100, 1), stat: 'Z' }]).deps)).toBeNull();
    const f = fakePosix([row(100, 1)]);
    expect(await captureTreePosix(100, f.deps, { rootIsOurs: (t) => t === 'other' })).toBeNull();
    expect(f.signals).toEqual([]);
  });

  it('never signals a captured pid another process took meanwhile', async () => {
    const rows = [row(1, 0), row(100, 1), row(101, 100)];
    const signals: Array<[number, NodeJS.Signals]> = [];
    const deps: PosixTreeDeps = {
      listProcesses: async () => rows.map((r) => ({ ...r })),
      signal: (pid, sig) => {
        signals.push([pid, sig]);
        const r = rows.find((x) => x.pid === pid);
        if (sig === 'SIGKILL' && r) r.stat = 'Z';
      },
    };
    const tree = (await captureTreePosix(100, deps, { sleep: noWait }))!;
    // 101 was killed by someone else and its pid went to an unrelated process.
    rows[2] = { pid: 101, ppid: 1, stat: 'S', start: 'unrelated' };
    const r = await tree.kill({ timeoutMs: 0 });
    expect(signals.filter(([p, s]) => p === 101 && s === 'SIGKILL')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('release() lets the frozen tree run again', async () => {
    const f = fakePosix([row(1, 0), row(100, 1), row(101, 100)]);
    (await captureTreePosix(100, f.deps))!.release();
    await vi.waitFor(() => expect(f.signals.filter(([, s]) => s === 'SIGCONT').map(([p]) => p)).toEqual([100, 101]), { timeout: 5_000 });
    expect(f.signals.some(([, s]) => s === 'SIGKILL')).toBe(false);
  });
});

describe('matchesRecordedStart', () => {
  it('has no answer when nothing was recorded', () => {
    expect(matchesRecordedStart(undefined, '1')).toBeNull();
  });

  it.skipIf(process.platform !== 'win32')('Windows: a FILETIME exactly, a DMTF record from before #2398 in UTC microseconds', () => {
    expect(matchesRecordedStart('133000000000000000', '133000000000000000')).toBe(true);
    expect(matchesRecordedStart('133000000000000000', '133000000000000010')).toBe(false);
    // 2022-06-15 12:00:00.123456 UTC as the FILETIME and as DMTF at +540.
    const ft = (BigInt(Date.UTC(2022, 5, 15, 12, 0, 0)) * 1000n + 123456n) * 10n + 116444736000000000n;
    expect(matchesRecordedStart('20220615210000.123456+540', ft.toString())).toBe(true);
    expect(matchesRecordedStart('20220615210000.123457+540', ft.toString())).toBe(false);
    expect(matchesRecordedStart('uptime-12', ft.toString())).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('POSIX: lstart, however many spaces pad the day', () => {
    expect(matchesRecordedStart('Sat Oct  4 10:00:00 2026', 'Sat Oct 4 10:00:00 2026')).toBe(true);
    expect(matchesRecordedStart('Sat Oct  4 10:00:00 2026', 'Sat Oct 4 10:00:01 2026')).toBe(false);
  });
});

describe('recordedStartOf', () => {
  it('Windows: the FILETIME a session records, else its older start time', () => {
    expect(recordedStartOf({ pidCreatedAtFt: '133', pidStartTime: '20220615210000.123456+540' }, 'win32')).toBe('133');
    expect(recordedStartOf({ pidStartTime: '20220615210000.123456+540' }, 'win32')).toBe('20220615210000.123456+540');
  });

  it('POSIX: the lstart', () => {
    expect(recordedStartOf({ pidCreatedAtFt: '133', pidStartTime: 'Sat Oct 18 10:00:00 2026' }, 'linux')).toBe('Sat Oct 18 10:00:00 2026');
  });
});

describe('survivorsStillRunning', () => {
  it('drops a process that is gone, and an entry that is not a process (an unverified tree)', async () => {
    // A pid far above any this machine hands out: gone.
    const gone = { pid: 0x7ffffff0, reason: 'still running', startTime: '1' };
    const unchecked = { pid: 0x7ffffff0, reason: 'the process table could not be read', unverified: true as const };
    expect(await survivorsStillRunning([gone, unchecked])).toEqual([]);
  });
});

describe('survivorsStillRunningWin32', () => {
  it('does not follow a child of an exited survivor that is gone or cannot be identified', () => {
    const f = fakeWin([
      { pid: 11, ppid: 1, createdAt: 110n, exited: true },
      { pid: 21, ppid: 11, createdAt: 150n, goneOnOpen: true },
      { pid: 22, ppid: 21, createdAt: 160n },
    ]);
    expect(survivorsStillRunningWin32([{ pid: 11, reason: 'access denied', startTime: '110' }], f.api)).toEqual([]);
  });

  it('stays unverified when a child that vanished shows a child of its own in a later table', async () => {
    // 11 forks 12 after the first table and exits before it is opened.
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, exited: true },
      { pid: 12, ppid: 11, createdAt: 120n },
    ], {
      tables: [[{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }]],
    });
    const r = await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.survivors).toEqual([expect.objectContaining({ pid: 11, unverified: true })]);
  });

  it('a child that vanished with nothing under it in any later table is no question', async () => {
    const f = fakeWin([
      { pid: 10, ppid: 1, createdAt: 100n },
      { pid: 11, ppid: 10, createdAt: 110n, goneOnOpen: true },
    ]);
    expect((await captureTreeWin32(10, f.api, { sleep: noWait })!.kill({ timeoutMs: 100 })).ok).toBe(true);
  });

  it('a survivor still running is still running; one that exited is not', () => {
    const f = fakeWin([{ pid: 11, ppid: 1, createdAt: 110n }, { pid: 12, ppid: 1, createdAt: 120n, exited: true }]);
    const s11 = { pid: 11, reason: 'access denied', startTime: '110' };
    const s12 = { pid: 12, reason: 'access denied', startTime: '120' };
    expect(survivorsStillRunningWin32([s11, s12], f.api)).toEqual([s11]);
  });

  it('once a survivor exited, what it started meanwhile still counts, grandchildren too', () => {
    const f = fakeWin([
      { pid: 11, ppid: 1, createdAt: 110n, exited: true },
      { pid: 21, ppid: 11, createdAt: 150n },
      { pid: 22, ppid: 21, createdAt: 160n },
      // An orphan older than the survivor, on a pid it reused: not its.
      { pid: 23, ppid: 11, createdAt: 50n },
    ]);
    const r = survivorsStillRunningWin32([{ pid: 11, reason: 'access denied', startTime: '110' }], f.api);
    expect(r.map((x) => x.pid).sort()).toEqual([21, 22]);
  });

  it('the children of a later owner of the survivor\'s pid are not its', () => {
    const f = fakeWin([
      // pid 11 now belongs to a process created at 300.
      { pid: 11, ppid: 1, createdAt: 300n },
      { pid: 21, ppid: 11, createdAt: 150n },
      { pid: 24, ppid: 11, createdAt: 350n },
    ]);
    const r = survivorsStillRunningWin32([{ pid: 11, reason: 'access denied', startTime: '110' }], f.api);
    expect(r.map((x) => x.pid)).toEqual([21]);
  });
});

describe('parsePsIdentityRows', () => {
  it('reads pid, ppid, state and the multi-word start time', () => {
    expect(parsePsIdentityRows('  100     1 Ss   Sat Oct 18 10:00:00 2026\n 101 100 R+ Sat Oct 18  10:00:01 2026\n')).toEqual([
      { pid: 100, ppid: 1, stat: 'Ss', start: 'Sat Oct 18 10:00:00 2026' },
      { pid: 101, ppid: 100, stat: 'R+', start: 'Sat Oct 18 10:00:01 2026' },
    ]);
  });
});
