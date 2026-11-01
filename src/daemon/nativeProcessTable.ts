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
 * `WMUX_NATIVE_PROCESS_TABLE=off` forces the spawn path.
 */
import { loadNativeTerminalCore, reportNativeFallback } from '../shared/nativeTerminalCore';

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
let table: ProcessTable | null | undefined;
let failures = 0;

function latchOff(): void {
  table = null;
  reportNativeFallback('process-table');
}

/** The native reader, or undefined when it is not usable here. Resolved once. */
export function nativeProcessTable(): ProcessTable | undefined {
  if (table === undefined) {
    if (process.platform !== 'win32' || process.env.WMUX_NATIVE_PROCESS_TABLE === 'off') {
      table = null;
    } else {
      try {
        const read = loadNativeTerminalCore('process-table-v1').processTable;
        if (typeof read !== 'function') throw new Error('Native terminal core lacks processTable');
        table = read;
      } catch {
        latchOff();
      }
    }
  }
  return table ?? undefined;
}

/** One snapshot, or undefined when the native path is unavailable or this read failed. */
export async function readNativeProcessTable(withCommandLines: boolean): Promise<NativeProcessRow[] | undefined> {
  const read = nativeProcessTable();
  if (!read) return undefined;
  try {
    const rows = await read(withCommandLines);
    failures = 0;
    return rows;
  } catch {
    if (++failures >= MAX_FAILURES && table) latchOff();
    return undefined;
  }
}
