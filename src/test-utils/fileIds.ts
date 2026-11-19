import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

/** Two 64-bit file IDs (NTFS has them) that round to the same Number. */
export const FAR_IDS = [2n ** 60n + 1n, 2n ** 60n + 3n] as const;

/** `st` with file ID `ino`: exact in a bigint stat, rounded the way a Number stat rounds it. */
export function withIno<T extends fs.Stats | fs.BigIntStats>(st: T, ino: bigint): T {
  return Object.assign(st, { ino: typeof st.ino === 'bigint' ? ino : Number(ino) });
}

export interface FakeIds {
  /** The ID a stat of the path reports (lstat or stat, promise or sync). */
  byPath: () => bigint;
  /** The ID a stat of a descriptor opened on the path reports (FileHandle.stat, fstatSync). */
  byHandle?: () => bigint;
}

/**
 * Make the files named report fake 64-bit file IDs. Each ID is a function, so
 * a test can change it on an event such as the open. Paths are compared
 * resolved and real. Restored by vi.restoreAllMocks().
 */
export function fakeFileIds(files: Record<string, FakeIds>): void {
  const byName = new Map<string, FakeIds>();
  for (const [file, ids] of Object.entries(files)) {
    byName.set(path.resolve(file), ids);
    byName.set(fs.realpathSync.native(file), ids);
  }
  const idsOf = (p: unknown): FakeIds | undefined => (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)
    ? byName.get(path.resolve(String(p))) : undefined);
  for (const name of ['lstat', 'stat'] as const) {
    const real = fs.promises[name].bind(fs.promises) as (...a: unknown[]) => Promise<fs.Stats | fs.BigIntStats>;
    vi.spyOn(fs.promises, name).mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      const st = await real(p, ...rest);
      const ids = idsOf(p);
      return ids ? withIno(st, ids.byPath()) : st;
    }) as never);
  }
  for (const name of ['lstatSync', 'statSync'] as const) {
    const real = fs[name].bind(fs) as (...a: unknown[]) => fs.Stats | fs.BigIntStats | undefined;
    vi.spyOn(fs, name).mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const st = real(p, ...rest);
      const ids = idsOf(p);
      return st && ids ? withIno(st, ids.byPath()) : st;
    }) as never);
  }
  const open = fs.promises.open.bind(fs.promises) as (...a: unknown[]) => Promise<fs.promises.FileHandle>;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    const handle = await open(p, ...rest);
    const byHandle = idsOf(p)?.byHandle;
    if (byHandle) {
      const stat = handle.stat.bind(handle) as (o?: fs.StatOptions) => Promise<fs.Stats | fs.BigIntStats>;
      handle.stat = (async (o?: fs.StatOptions) => withIno(await stat(o), byHandle())) as typeof handle.stat;
    }
    return handle;
  }) as never);
  const opened = new Map<number, () => bigint>();
  const openSync = fs.openSync.bind(fs) as (...a: unknown[]) => number;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    const fd = openSync(p, ...rest);
    const byHandle = idsOf(p)?.byHandle;
    if (byHandle) opened.set(fd, byHandle);
    else opened.delete(fd);
    return fd;
  }) as never);
  const fstatSync = fs.fstatSync.bind(fs) as (...a: unknown[]) => fs.Stats | fs.BigIntStats;
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, ...rest: unknown[]) => {
    const st = fstatSync(fd, ...rest);
    const byHandle = opened.get(fd);
    return byHandle ? withIno(st, byHandle()) : st;
  }) as never);
}
