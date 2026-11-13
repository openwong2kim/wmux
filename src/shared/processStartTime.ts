// When a process started, as the OS reports it. Read with a pid, it tells the
// process that has the pid now from an earlier one that had it.
//
// macOS: proc_pidinfo(PROC_PIDTBSDINFO) through koffi, from struct proc_bsdinfo
// (pbi_start_tvsec at byte 120, pbi_start_tvusec at 128, 136 bytes in all), as
// microseconds since the epoch. Linux: field 22 of /proc/<pid>/stat, in clock
// ticks since boot. Values compare only with values from this same function on
// the same machine. Elsewhere, or when the reading fails: null.

import fs from 'node:fs';

const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;
const START_TVSEC = 120;
const START_TVUSEC = 128;

type ProcPidInfo = (pid: number, flavor: number, arg: number, buffer: Buffer, size: number) => number;

let procPidInfo: ProcPidInfo | null | undefined;

function loadProcPidInfo(): ProcPidInfo | null {
  if (procPidInfo !== undefined) return procPidInfo;
  try {
    // Runtime require, external to every bundle (its binary sits beside the package).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as { load(name: string): { func(name: string, result: string, args: string[]): unknown } };
    procPidInfo = koffi.load('libSystem.B.dylib').func('proc_pidinfo', 'int', ['int', 'int', 'uint64_t', 'void *', 'int']) as ProcPidInfo;
  } catch {
    procPidInfo = null;
  }
  return procPidInfo;
}

function darwinStartTime(pid: number): bigint | null {
  const read = loadProcPidInfo();
  if (!read) return null;
  const info = Buffer.alloc(PROC_BSDINFO_SIZE);
  try {
    if (read(pid, PROC_PIDTBSDINFO, 0, info, PROC_BSDINFO_SIZE) !== PROC_BSDINFO_SIZE) return null;
  } catch {
    return null;
  }
  const micros = info.readBigUInt64LE(START_TVSEC) * 1_000_000n + info.readBigUInt64LE(START_TVUSEC);
  return micros > 0n ? micros : null;
}

/** Field 22 (starttime) of a /proc/<pid>/stat line. */
export function statStartTime(stat: string): bigint | null {
  // Field 2 is the command name in parentheses and may hold spaces or ')';
  // field 3 starts after the last ')', so field 22 is the 20th from there.
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const ticks = stat.slice(close + 2).split(' ')[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? BigInt(ticks) : null;
}

function linuxStartTime(pid: number): bigint | null {
  try {
    return statStartTime(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/** The start time of the process that has `pid` now; null when it cannot be read. */
export function processStartTime(pid: number): bigint | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'darwin') return darwinStartTime(pid);
  if (process.platform === 'linux') return linuxStartTime(pid);
  return null;
}

// A process start bound to the boot it was read in: `<boot id>:<value>`.
// The value alone repeats across boots (Linux counts ticks from boot), so a
// start is compared only with one read in the same boot. Neither part moves
// when the clock is stepped: Linux's boot_id and starttime ticks, macOS's
// kern.bootsessionuuid and the start the kernel stored at fork. (macOS's
// kern.boottime would not do: XNU shifts it with every clock step.)

type SysctlByName = (name: string, oldp: Buffer, oldlenp: Buffer, newp: null, newlen: number) => number;

/** Kept once read; a failed read is tried again next time. */
let bootIdCache: string | null = null;

function darwinBootId(): string | null {
  try {
    // Runtime require, external to every bundle (its binary sits beside the package).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as { load(name: string): { func(name: string, result: string, args: string[]): unknown } };
    const sysctl = koffi.load('libSystem.B.dylib').func('sysctlbyname', 'int', ['str', 'void *', 'void *', 'void *', 'size_t']) as SysctlByName;
    const out = Buffer.alloc(64);
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(out.length));
    if (sysctl('kern.bootsessionuuid', out, len, null, 0) !== 0) return null;
    return out.subarray(0, Number(len.readBigUInt64LE())).toString('utf8').replace(/\0.*$/s, '');
  } catch {
    return null;
  }
}

/** This boot's id (Linux boot_id, macOS kern.bootsessionuuid); null elsewhere or when it cannot be read. */
export function currentBootId(): string | null {
  if (bootIdCache) return bootIdCache;
  let id: string | null = null;
  if (process.platform === 'linux') {
    try {
      id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      id = null;
    }
  } else if (process.platform === 'darwin') {
    id = darwinBootId();
  }
  bootIdCache = id && /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(id) ? id.toLowerCase() : null;
  return bootIdCache;
}

/** The start of the process that has `pid` now, bound to this boot; null when either cannot be read. */
export function kernelStartOf(pid: number): string | null {
  const boot = currentBootId();
  const start = boot === null ? null : processStartTime(pid);
  return start === null ? null : `${boot}:${start}`;
}

/**
 * Whether two {@link kernelStartOf} readings name the same process: the
 * same boot and the same start. A start from another boot never matches (a
 * process does not outlive its boot). Null when either is absent: the caller
 * compares what else it has.
 */
export function sameKernelStart(a: string | null | undefined, b: string | null | undefined): boolean | null {
  if (!a || !b) return null;
  const at = a.lastIndexOf(':');
  const bt = b.lastIndexOf(':');
  if (at <= 0 || bt <= 0) return null;
  return a.slice(0, at) === b.slice(0, bt) && a.slice(at + 1) === b.slice(bt + 1);
}
