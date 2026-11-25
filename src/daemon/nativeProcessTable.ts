/**
 * Windows process table from the native core: one Toolhelp snapshot, plus
 * creation time and command line per row on request. Replaces the
 * tasklist.exe liveness sweep and the PowerShell CIM enumeration, each of
 * which spawned a process (and woke WMI) every time.
 *
 * Independent of the terminal engine: the module is loaded on first use
 * whenever it is packaged with `process-table-v1`, so node-engine users get
 * it too. A missing module or capability latches the native path off for the
 * daemon's life, as do MAX_FAILURES failed calls in a row (one failure only
 * sends that read to the spawn path); callers then keep their spawn path. A
 * refused native allocation (ALLOC_FAILED) fails only that read.
 * `WMUX_NATIVE_PROCESS_TABLE=off` forces the spawn path. The same latch
 * (nativeRead) serves PortWatcher's macOS and Linux snapshot, and the Linux
 * table (`process-table-linux-v1`, readLinuxProcessTable) in place of `ps`.
 */
import { isNativeAllocFailure, loadNativeTerminalCore, reportNativeFallback, type NativeTerminalCore } from '../shared/nativeTerminalCore';
import { argsFromCmdline, formatLstart } from './procfs';

export interface NativeProcessRow {
  pid: number;
  ppid: number;
  /** Image file name, as tasklist and CIM report it. */
  name: string;
  /** Epoch ms; absent when it could not be read. */
  created?: number | null;
  /** Absent when unreadable (protected, exited mid-walk) or empty. */
  cmdline?: string | null;
  /** Linux (`process-table-linux-v1`): the one-letter state and the process groups. */
  state?: string | null;
  pgid?: number | null;
  tpgid?: number | null;
}

type ProcessTable = (withCommandLines: boolean) => Promise<NativeProcessRow[]>;

const MAX_FAILURES = 3;

/**
 * One native read, shared by the process table here and PortWatcher's
 * snapshot (src/main/pty/portWatch.ts). `get()` resolves it once: it is
 * unavailable off `platforms`, under `WMUX_NATIVE_PROCESS_TABLE=off`, or when
 * the module or `capability` is missing (that last case is reported as a
 * fallback of `component`). `call()` runs one read: a rejection, or no answer
 * within `timeoutMs`, is a failure and resolves undefined, so the caller takes
 * its spawn path for that read; MAX_FAILURES in a row latch the read off for
 * the process's life (no retry after a backoff). A success resets the count.
 * A rejection with a refused native allocation (isNativeAllocFailure, #3440)
 * also resolves undefined, but is no failure: it is the daemon's memory at
 * that moment, not the read, so it neither counts toward MAX_FAILURES nor
 * resets the count, and the next call runs natively.
 * A timed read also keeps one call in flight at most: while one has not
 * settled (a timed-out call may still hold a libuv thread), `call()` answers
 * undefined at once without starting another. That skip is no failure while
 * the pending call is within its timeout; once the call has timed out and is
 * still pending, each skip is a failure, so a read hung for good latches too.
 */
export interface NativeRead<F> {
  get(): F | undefined;
  call<T>(run: (read: F) => Promise<T>, timeoutMs?: number): Promise<T | undefined>;
}

export function nativeRead<F>(opts: {
  platforms: readonly NodeJS.Platform[];
  capability: string;
  component: string;
  pick: (core: NativeTerminalCore) => F | undefined;
}): NativeRead<F> {
  let fn: F | null | undefined;
  let failures = 0;
  let inFlight = false;
  // The in-flight call has outlived its timeout and has not settled since.
  let hung = false;
  const latchOff = (): void => {
    fn = null;
    reportNativeFallback(opts.component);
  };
  const fail = (): void => {
    if (++failures >= MAX_FAILURES && fn) latchOff();
  };
  const get = (): F | undefined => {
    if (fn === undefined) {
      if (!opts.platforms.includes(process.platform) || process.env.WMUX_NATIVE_PROCESS_TABLE === 'off') {
        fn = null;
      } else {
        try {
          const read = opts.pick(loadNativeTerminalCore(opts.capability));
          if (read === undefined) throw new Error(`Native terminal core lacks ${opts.capability}`);
          fn = read;
        } catch {
          latchOff();
        }
      }
    }
    return fn ?? undefined;
  };
  const call = async <T>(run: (read: F) => Promise<T>, timeoutMs?: number): Promise<T | undefined> => {
    const read = get();
    if (!read) return undefined;
    if (timeoutMs !== undefined && inFlight) {
      if (hung) fail();
      return undefined;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const pending = run(read);
      if (timeoutMs !== undefined) {
        inFlight = true;
        const settle = (): void => { inFlight = false; hung = false; };
        pending.then(settle, settle);
      }
      const result = await (timeoutMs === undefined ? pending : Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            hung = true;
            reject(new Error('Native read timed out'));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]));
      failures = 0;
      return result;
    } catch (error) {
      if (!isNativeAllocFailure(error)) fail();
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return { get, call };
}

const table = nativeRead<ProcessTable>({
  platforms: ['win32'],
  capability: 'process-table-v1',
  component: 'process-table',
  pick: (core) => (typeof core.processTable === 'function' ? core.processTable : undefined),
});

/** The native reader, or undefined when it is not usable here. Resolved once. */
export function nativeProcessTable(): ProcessTable | undefined {
  return table.get();
}

/** One snapshot, or undefined when the native path is unavailable or this read failed. */
export async function readNativeProcessTable(withCommandLines: boolean): Promise<NativeProcessRow[] | undefined> {
  return table.call((read) => read(withCommandLines));
}

/** One Linux process in the columns `ps` prints for it. */
export interface LinuxProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  /** The one-letter state: the first letter of `ps -o stat`. */
  state: string;
  /** `ps -o comm`. */
  comm: string;
  /** Start in epoch ms (lstartOf); absent when the boot time could not be read. */
  created?: number;
  /** `ps -o args` in a UTF-8 locale; only when read with args. */
  args?: string;
}

/** `ps -o lstart` for a row, byte for byte (ctime(3) in local time): created's whole seconds are btime + floor(ticks / hz), the second `ps` prints. */
export function lstartOf(row: LinuxProcessRow): string | undefined {
  return row.created === undefined ? undefined : formatLstart(Math.floor(row.created / 1000));
}

const pickTable = (core: NativeTerminalCore): ProcessTable | undefined =>
  (typeof core.processTable === 'function' ? core.processTable : undefined);
// Two latches: a read with args can hang on one command line (and be in
// flight for its whole 10 s), and that must neither turn reads without args
// away nor latch them off.
const linuxTable = nativeRead<ProcessTable>({ platforms: ['linux'], capability: 'process-table-linux-v1', component: 'process-table-linux', pick: pickTable });
const linuxArgsTable = nativeRead<ProcessTable>({ platforms: ['linux'], capability: 'process-table-linux-v1', component: 'process-table-linux', pick: pickTable });

/** Without args: one stat line per process, so the 2 s the `ps` callers allow. With args, procfs.procTable's 10 s. */
const LINUX_TABLE_TIMEOUT_MS = 2_000;
const LINUX_ARGS_TIMEOUT_MS = 10_000;

/** Native Linux rows in `ps` columns. A row without its stat details fails the read. */
export function linuxRows(rows: readonly NativeProcessRow[], withArgs: boolean): LinuxProcessRow[] {
  return rows.map((r) => {
    if (typeof r.state !== 'string' || typeof r.pgid !== 'number' || typeof r.tpgid !== 'number') {
      throw new Error(`Native process row ${r.pid} lacks its stat details`);
    }
    const row: LinuxProcessRow = { pid: r.pid, ppid: r.ppid, pgid: r.pgid, tpgid: r.tpgid, state: r.state, comm: r.name };
    if (typeof r.created === 'number') row.created = r.created;
    if (withArgs) row.args = argsFromCmdline(r.cmdline ?? '', r.name, r.state);
    return row;
  });
}

/**
 * The Linux process table from one native walk, or undefined when the native
 * path is unavailable or this read failed (the caller then spawns `ps`).
 * `withArgs` also reads every command line.
 */
export async function readLinuxProcessTable(withArgs: boolean): Promise<LinuxProcessRow[] | undefined> {
  return (withArgs ? linuxArgsTable : linuxTable).call(
    async (read) => linuxRows(await read(withArgs), withArgs),
    withArgs ? LINUX_ARGS_TIMEOUT_MS : LINUX_TABLE_TIMEOUT_MS,
  );
}

/** Whether the native read with args is usable here (not off, missing or latched off). */
export function linuxArgsTableUsable(): boolean {
  return linuxArgsTable.get() !== undefined;
}

/** Identity rows' start text for every row, or undefined when any row lacks its start. */
export function lstartsOf(rows: readonly LinuxProcessRow[]): string[] | undefined {
  const out: string[] = [];
  for (const r of rows) {
    const text = lstartOf(r);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}
