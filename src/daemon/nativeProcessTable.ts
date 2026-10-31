/**
 * Windows process table from the native core: one Toolhelp snapshot, plus
 * creation time and command line per row on request. Replaces the
 * tasklist.exe liveness sweep and the PowerShell CIM enumeration, each of
 * which spawned a process (and woke WMI) every time.
 *
 * Independent of the terminal engine: the module is loaded on first use
 * whenever it is packaged with `process-table-v1`, so node-engine users get
 * it too. A missing module or capability, or any failed call, latches the
 * native path off for the daemon's life; callers then keep their spawn path.
 * `WMUX_NATIVE_PROCESS_TABLE=off` forces the spawn path.
 */
import { loadNativeTerminalCore, reportNativeFallback } from '../shared/nativeTerminalCore';

export interface NativeProcessRow {
  pid: number;
  ppid: number;
  /** Image file name, as tasklist and CIM report it. */
  name: string;
  /** Epoch ms; absent when the process could not be opened. */
  created?: number | null;
  /** Absent when unreadable (protected, exited mid-walk) or empty. */
  cmdline?: string | null;
}

type ProcessTable = (withCommandLines: boolean) => Promise<NativeProcessRow[]>;

let failed = false;

function markFailed(): void {
  failed = true;
  reportNativeFallback('process-table');
}

/** The native reader, or undefined when it is not usable here. */
export function nativeProcessTable(): ProcessTable | undefined {
  if (process.platform !== 'win32' || failed || process.env.WMUX_NATIVE_PROCESS_TABLE === 'off') return undefined;
  try {
    const table = loadNativeTerminalCore('process-table-v1').processTable;
    if (typeof table !== 'function') throw new Error('Native terminal core lacks processTable');
    return table;
  } catch {
    markFailed();
    return undefined;
  }
}

/** One snapshot, or undefined when the native path is (or just went) unavailable. */
export async function readNativeProcessTable(withCommandLines: boolean): Promise<NativeProcessRow[] | undefined> {
  const table = nativeProcessTable();
  if (!table) return undefined;
  try {
    return await table(withCommandLines);
  } catch {
    markFailed();
    return undefined;
  }
}
