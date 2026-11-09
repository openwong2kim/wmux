/**
 * What the daemon's main thread was doing when it stopped answering.
 *
 * Main force-respawns a daemon that misses five health pings and shows no CPU
 * time (DaemonRespawnController), and every pane loses its session. A daemon
 * that is stuck cannot say why, so a Worker watches a heartbeat ticked from the
 * event loop. When it stops, the Worker asks V8 to pause the main thread through
 * inspector.Session.connectToMainThread(), copies the frames, resumes it and
 * writes one file to the log folder. A dump takes two forms:
 *  - stuck in JavaScript (a loop, Atomics.wait): function names and file:line;
 *  - stuck below it (a native call, a blocking system call): V8 only pauses at
 *    a JavaScript interrupt check, which never comes, so the file says that and
 *    how much CPU the process used while waiting. It names no function, unless
 *    the call returns inside the time box: the pause then lands right after it,
 *    the frames name its caller, and the detail line shows how long that took.
 *
 * Timing, against main's defaults (10 s ping interval, 5 s ping timeout, a
 * verdict at the 5th failure, so 45-55 s after the stall): the stall is seen 8-10 s
 * in, past the 5 s a ping may take on a healthy daemon, and a dump ends within 3 s
 * of that. The Worker's own CPU time counts as the daemon's when main samples it
 * (#3077: no rise for 30 s from the first failure means stalled), so it has to be
 * over before main's second failed ping, 15 s after the stall at the earliest: a
 * rise seen by then is 30 s behind the 5th, or a hair under it by main's timing,
 * which costs one more ping (10 s). After that the thread uses no CPU.
 *
 * Off with WMUX_HANG_EVIDENCE=0.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { pruneHangDumps } from './hangEvidence';
import { HANG_WATCHDOG_WORKER_SOURCE } from './hangWatchdogWorkerSource';

export const HANG_EVIDENCE_ENV = 'WMUX_HANG_EVIDENCE';

const BEAT = 0;
const NAP = 1;

export interface HangWatchdogOptions {
  logsDir: string;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  version?: string;
  env?: NodeJS.ProcessEnv;
  /** How often the main thread beats. */
  tickMs?: number;
  /** How often the Worker wakes to read the beat. */
  pollMs?: number;
  /** Reads in a row with no new beat that make a stall. */
  staleReads?: number;
  /** How long a dump waits for a paused main thread. */
  timeboxMs?: number;
  /** Between two dumps; a stall inside this leaves none. */
  minGapMs?: number;
  /** Dumps of one run that stay; the oldest of them goes first. */
  keptPerRun?: number;
}

/** Starts the watchdog; a failure here leaves the daemon as it would have been without it. */
export function startHangWatchdog(opts: HangWatchdogOptions): void {
  const env = opts.env ?? process.env;
  if (env[HANG_EVIDENCE_ENV] === '0') {
    opts.log('info', `[hang] watchdog off (${HANG_EVIDENCE_ENV}=0)`);
    return;
  }
  try {
    pruneHangDumps(opts.logsDir);
    const cells = new SharedArrayBuffer(8);
    const shared = new Int32Array(cells);
    const worker = new Worker(HANG_WATCHDOG_WORKER_SOURCE, {
      eval: true,
      // The daemon's environment holds whatever credentials it inherited.
      env: {},
      workerData: {
        cells,
        BEAT,
        NAP,
        pollMs: opts.pollMs ?? 2_000,
        staleReads: opts.staleReads ?? 4,
        timeboxMs: opts.timeboxMs ?? 3_000,
        minGapMs: opts.minGapMs ?? 5 * 60_000,
        keptPerRun: opts.keptPerRun ?? 3,
        logsDir: opts.logsDir,
        pid: process.pid,
        version: opts.version ?? 'unknown',
        // A script's url has symlinks resolved; the home folder may not.
        homes: [os.homedir(), fs.realpathSync(os.homedir())],
      },
      // A heap limit that a runaway here hits ends this thread, not the process.
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 },
      // Nothing is written to these; they keep anything Node prints off the daemon's stdio.
      stdout: true,
      stderr: true,
    });
    worker.unref();
    worker.on('error', (err) => {
      opts.log('warn', `[hang] watchdog stopped: ${err instanceof Error ? err.name : 'error'}`);
    });
    // Notifying a cell nobody waits on is one lock and a list check.
    setInterval(() => {
      Atomics.add(shared, BEAT, 1);
      Atomics.notify(shared, BEAT);
    }, opts.tickMs ?? 1_000).unref();
    opts.log('info', `[hang] watchdog on; a stuck main thread writes to ${path.resolve(opts.logsDir)}`);
  } catch (err) {
    opts.log('warn', `[hang] watchdog did not start: ${err instanceof Error ? err.message : String(err)}`);
  }
}
