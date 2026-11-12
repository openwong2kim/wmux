// Linux /proc readers for the process questions the daemon asks per event, so
// answering them starts no `ps`. Each reader returns null when /proc cannot
// answer (off Linux, an unreadable file, an unexpected format); the caller
// then asks `ps` as before. `{ value: null }` means the pid does not exist.

import fs from 'node:fs';
import os from 'node:os';
import { statStartTime } from '../shared/processStartTime';

/** An answer from /proc: `value` null when no process has the pid. */
export type ProcAnswer<T> = { value: T | null } | null;

export interface ProcRow {
  pid: number;
  ppid: number;
  /** As `ps -o args=` prints it. */
  args: string;
}

const isLinux = (): boolean => process.platform === 'linux';

const isGone = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ESRCH';
};

/**
 * `/proc/<pid>/<file>`, `gone` when no process has the pid, null when it
 * cannot be read. A thread id has a /proc entry too, but `ps -p` finds no
 * process for it: only a pid that is its own thread group counts.
 */
function readPid(pid: number, file: string): string | 'gone' | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const tgid = /^Tgid:\s*(\d+)$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
    if (tgid === undefined) return null;
    if (Number(tgid) !== pid) return 'gone';
    return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch (err) {
    return isGone(err) ? 'gone' : null;
  }
}

/** The fields after `(comm)` in a stat line: [0] is the state, [1] the ppid. */
function statTail(stat: string): string[] | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const tail = stat.slice(close + 2).split(' ');
  return tail.length > 20 ? tail : null;
}

/** The one-letter state of `pid` (`ps -o stat=`'s first letter). */
export function procState(pid: number): ProcAnswer<string> {
  if (!isLinux()) return null;
  const stat = readPid(pid, 'stat');
  if (stat === 'gone') return { value: null };
  const state = stat === null ? undefined : statTail(stat)?.[0];
  return state && /^[A-Za-z]$/.test(state) ? { value: state } : null;
}

/** The executable name of `pid`, as `ps -o comm=` prints it. */
export function procComm(pid: number): ProcAnswer<string> {
  if (!isLinux()) return null;
  const comm = readPid(pid, 'comm');
  if (comm === 'gone') return { value: null };
  return comm === null ? null : { value: comm.replace(/\n$/, '') };
}

let clockTicks: number | null | undefined;

/** The kernel's clock ticks per second (AT_CLKTCK in this process's auxv), what `ps` divides start times by. */
function ticksPerSecond(): number | null {
  if (clockTicks !== undefined) return clockTicks;
  clockTicks = null;
  try {
    const auxv = fs.readFileSync('/proc/self/auxv');
    const word = ['ia32', 'arm', 'mips', 'mipsel', 'ppc'].includes(process.arch) ? 4 : 8;
    const le = os.endianness() === 'LE';
    const read = (at: number): number =>
      word === 8
        ? Number(le ? auxv.readBigUInt64LE(at) : auxv.readBigUInt64BE(at))
        : le ? auxv.readUInt32LE(at) : auxv.readUInt32BE(at);
    for (let at = 0; at + 2 * word <= auxv.length; at += 2 * word) {
      const type = read(at);
      if (type === 0) break;
      if (type === 17 /* AT_CLKTCK */) {
        const hz = read(at + word);
        if (hz > 0) clockTicks = hz;
        break;
      }
    }
  } catch {
    // stays null: the caller asks `ps`
  }
  return clockTicks;
}

/** Boot time in seconds since the epoch (`btime` in /proc/stat), read fresh as `ps` does. */
function bootTime(): number | null {
  try {
    const m = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Start of `pid` in seconds since the epoch, with the clock-tick fraction. */
function startSeconds(pid: number): ProcAnswer<number> {
  const stat = readPid(pid, 'stat');
  if (stat === 'gone') return { value: null };
  if (stat === null) return null;
  const ticks = statStartTime(stat);
  const hz = ticksPerSecond();
  const boot = bootTime();
  if (ticks === null || hz === null || boot === null) return null;
  return { value: boot + Number(ticks) / hz };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/** `ctime(3)` without the newline, in local time: `ps -o lstart=`'s text. */
export function formatLstart(epochSeconds: number): string {
  const d = new Date(Math.floor(epochSeconds) * 1000);
  const day = String(d.getDate()).padStart(2, ' ');
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${day} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

/**
 * The start time of `pid` as `ps -o lstart=` prints it, byte for byte: procps
 * prints ctime(3), which follows TZ but not the locale.
 */
export function procLstart(pid: number): ProcAnswer<string> {
  if (!isLinux()) return null;
  const start = startSeconds(pid);
  if (start === null || start.value === null) return start as ProcAnswer<string>;
  // `ps` truncates the start to whole seconds after adding it to the boot time.
  return { value: formatLstart(start.value) };
}

/** The start time of `pid` in epoch ms. */
export function procStartMs(pid: number): ProcAnswer<number> {
  if (!isLinux()) return null;
  const start = startSeconds(pid);
  if (start === null || start.value === null) return start as ProcAnswer<number>;
  return { value: Math.floor(start.value * 1000) };
}

/** A command line as `ps -o args=` prints it: argv joined by spaces, control characters as `?`. */
export function argsFromCmdline(cmdline: string, comm: string, state: string): string {
  const argv = cmdline.replace(/\0+$/, '');
  if (argv === '') return state === 'Z' ? `[${comm}] <defunct>` : `[${comm}]`;
  // eslint-disable-next-line no-control-regex -- the characters `ps` replaces
  return argv.replace(/\0/g, ' ').replace(/[\x00-\x1f\x7f]/g, '?');
}

const TABLE_TIMEOUT_MS = 10_000;
let tableStuck = false;

async function readRow(pid: number): Promise<ProcRow | null> {
  try {
    const [stat, cmdline] = await Promise.all([
      fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'),
      fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8'),
    ]);
    const tail = statTail(stat);
    if (!tail) return null;
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    return { pid, ppid: Number(tail[1]), args: argsFromCmdline(cmdline, comm, tail[0]) };
  } catch {
    // A process that exits between the listing and the read is simply not in the table.
    return null;
  }
}

/**
 * Every process: pid, ppid and `ps -o args=`'s text; null when /proc cannot be
 * listed. The reads run off the event loop: reading a command line waits on
 * the process's memory map, which a process stuck in the kernel can hold. A
 * table that is not read within the `ps` path's 10 s is given up on, and from
 * then on the caller asks `ps`, which it can time out and kill.
 */
export async function procTable(): Promise<ProcRow[] | null> {
  if (!isLinux() || tableStuck) return null;
  let names: string[];
  try {
    names = await fs.promises.readdir('/proc');
  } catch {
    return null;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      tableStuck = true;
      resolve(null);
    }, TABLE_TIMEOUT_MS);
  });
  const rows = Promise.all(names.filter((n) => /^\d+$/.test(n)).map((n) => readRow(Number(n))));
  const result = await Promise.race([rows, timedOut]);
  clearTimeout(timer);
  return result === null ? null : result.filter((r): r is ProcRow => r !== null);
}
