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
