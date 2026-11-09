/**
 * The files a stuck daemon leaves: where they are, what they are called, and how
 * many stay. No dependency beyond fs and path, so main (the pointer it logs when
 * it forces a respawn) and the CLI (`wmux doctor`) can read them without taking
 * in the watchdog.
 */
import fs from 'node:fs';
import path from 'node:path';

/** `daemon-hang-<pid>-<epoch ms>.txt`. The same shape is spelled in the Worker source. */
const DUMP_FILE = /^daemon-hang-(\d+)-(\d+)\.txt$/;

/** Kept across runs; a running daemon adds at most a few more (keptPerRun in hangWatchdog.ts). */
const DUMPS_KEPT = 5;

/**
 * A dump this old is not about the hang being reported: main gives up within
 * DAEMON_PROGRESS_DEFAULTS.maxUnansweredMs (15 minutes) of the stall that wrote it.
 */
const POINTER_MAX_AGE_MS = 30 * 60_000;

export interface HangDump {
  path: string;
  pid: number;
  writtenAt: number;
}

function listDumps(logsDir: string): HangDump[] {
  let names: string[];
  try {
    names = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  const dumps: HangDump[] = [];
  for (const name of names) {
    const m = DUMP_FILE.exec(name);
    if (m) dumps.push({ path: path.join(logsDir, name), pid: Number(m[1]), writtenAt: Number(m[2]) });
  }
  return dumps.sort((a, b) => b.writtenAt - a.writtenAt);
}

/** The newest dump in the folder, or null. */
export function newestHangDump(logsDir: string): HangDump | null {
  return listDumps(logsDir)[0] ?? null;
}

/** The dump this daemon wrote during the hang main is giving up on, or null. */
export function hangDumpForPid(logsDir: string, pid: number, now: number = Date.now()): string | null {
  const dump = listDumps(logsDir).find((d) => d.pid === pid);
  return dump && now - dump.writtenAt <= POINTER_MAX_AGE_MS ? dump.path : null;
}

/** Called at daemon start: the bound on dump files, so a stuck daemon's Worker never has to walk the folder. */
export function pruneHangDumps(logsDir: string): void {
  for (const dump of listDumps(logsDir).slice(DUMPS_KEPT)) {
    try {
      fs.unlinkSync(dump.path);
    } catch {
      // The next start tries again.
    }
  }
}
