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
 * sends that read to the spawn path); callers then keep their spawn path.
 * `WMUX_NATIVE_PROCESS_TABLE=off` forces the spawn path. The same latch
 * (nativeRead) serves PortWatcher's macOS and Linux snapshot.
 */
import { loadNativeTerminalCore, reportNativeFallback, type NativeTerminalCore } from '../shared/nativeTerminalCore';

export interface NativeProcessRow {
  pid: number;
  ppid: number;
  /** Image file name, as tasklist and CIM report it. */
  name: string;
  /** Epoch ms; absent when it could not be read. */
  created?: number | null;
  /** Absent when unreadable (protected, exited mid-walk) or empty. */
  cmdline?: string | null;
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
    } catch {
      fail();
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
