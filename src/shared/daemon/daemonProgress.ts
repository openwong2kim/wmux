// Whether a daemon that stopped answering pings is still running, read from
// outside it. A daemon starved of memory (the system swapping) misses every
// ping while it keeps working through its backlog; killing it then ends every
// PTY it holds. Its CPU time still goes up. A wedged daemon's does not.
//
// A connect to its pipe is no such signal: the kernel accepts a connection on
// a listening socket whether or not the process behind it ever runs again.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { tryProcessCpuMs } from '../../main/pty/winSnapshotNative';

/** One look at the daemon's process. */
export interface DaemonProcessSample {
  /** The process exists. */
  alive: boolean;
  /** Its CPU time so far (user + system), in ms; null when it could not be read. */
  cpuMs: number | null;
  /** The system is short of memory: the usual reason a live daemon gets this slow. */
  underPressure: boolean;
}

/**
 * - `progressing`: its CPU time went up within the budget; do not kill it.
 * - `stalled`: no CPU time for the whole budget, or past the overall cap.
 * - `gone`: the process is not there.
 * - `unknown`: its CPU time cannot be read and nothing was seen before; the
 *   caller decides as before. A read that fails after earlier ones counts
 *   from the last rise seen, like a sample that shows none.
 */
export type DaemonProgress = 'progressing' | 'stalled' | 'gone' | 'unknown';

export interface DaemonProgressConfig {
  /** No CPU time for this long: stalled. */
  noProgressMs: number;
  /** Under memory pressure the budget is this many times longer. */
  pressureFactor: number;
  /**
   * However it progresses, a daemon that has not answered for this long is
   * stalled: a loop that burns CPU without ever answering again looks like
   * progress.
   */
  maxUnansweredMs: number;
}

export const DAEMON_PROGRESS_DEFAULTS: DaemonProgressConfig = {
  noProgressMs: 30_000,
  pressureFactor: 4,
  maxUnansweredMs: 15 * 60_000,
};

/** Follows one daemon process across samples, from its first missed answer. */
export class DaemonProgressTracker {
  private pid: number | null = null;
  private lastCpuMs: number | null = null;
  private lastProgressAt = 0;
  private firstAt = 0;

  constructor(private readonly cfg: DaemonProgressConfig = DAEMON_PROGRESS_DEFAULTS) {}

  /** The daemon answered: forget what was seen. */
  reset(): void {
    this.pid = null;
    this.lastCpuMs = null;
  }

  observe(pid: number, sample: DaemonProcessSample, now: number): DaemonProgress {
    if (!sample.alive) return 'gone';
    const seen = this.pid === pid && this.lastCpuMs !== null;
    if (sample.cpuMs === null && !seen) return 'unknown';
    if (!seen) {
      // The first look gives the budget from now: it shows nothing yet.
      this.pid = pid;
      this.lastCpuMs = sample.cpuMs as number;
      this.lastProgressAt = now;
      this.firstAt = now;
      return 'progressing';
    }
    if (sample.cpuMs !== null && sample.cpuMs > (this.lastCpuMs ?? 0)) this.lastProgressAt = now;
    if (sample.cpuMs !== null) this.lastCpuMs = sample.cpuMs;
    if (now - this.firstAt >= this.cfg.maxUnansweredMs) return 'stalled';
    const budget = this.cfg.noProgressMs * (sample.underPressure ? this.cfg.pressureFactor : 1);
    return now - this.lastProgressAt >= budget ? 'stalled' : 'progressing';
  }
}

const run = (file: string, args: string[], timeoutMs: number): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });

/** `ps -o time=`: `[[dd-]hh:]mm:ss[.cc]`. */
export function parsePsCpuTime(raw: string): number | null {
  const text = raw.trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const [, days, hours, minutes, seconds, fraction] = m;
  const ms = (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
  return ms + (fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0);
}

/** `/proc/<pid>/stat`: utime and stime, in clock ticks (fields 14 and 15, after the parenthesised name). */
export function parseProcStatCpuMs(stat: string, ticksPerSecond = 100): number | null {
  const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const utime = Number(tail[11]);
  const stime = Number(tail[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? ((utime + stime) * 1000) / ticksPerSecond : null;
}

async function readCpuMs(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    try { return parseProcStatCpuMs(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return null; }
  }
  // GetProcessTimes: no process to spawn on a machine short of memory.
  if (process.platform === 'win32') return tryProcessCpuMs(pid);
  const out = await run('/bin/ps', ['-o', 'time=', '-p', String(pid)], 5_000);
  return out === null ? null : parsePsCpuTime(out);
}

/** Memory pressure as the OS reports it; false when it cannot tell. */
async function memoryPressure(): Promise<boolean> {
  if (process.platform === 'darwin') {
    // 1 normal, 2 warning, 4 critical.
    const out = await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], 3_000);
    return out !== null && Number(out.trim()) >= 2;
  }
  if (process.platform === 'linux') {
    try {
      const info = fs.readFileSync('/proc/meminfo', 'utf8');
      const total = Number(/MemTotal:\s+(\d+)/.exec(info)?.[1]);
      const available = Number(/MemAvailable:\s+(\d+)/.exec(info)?.[1]);
      return total > 0 && available / total < 0.1;
    } catch { return false; }
  }
  return os.totalmem() > 0 && os.freemem() / os.totalmem() < 0.1;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Samples a daemon process for DaemonProgressTracker. */
export async function sampleDaemonProcess(pid: number): Promise<DaemonProcessSample> {
  if (!isAlive(pid)) return { alive: false, cpuMs: null, underPressure: false };
  const [cpuMs, underPressure] = await Promise.all([readCpuMs(pid), memoryPressure()]);
  return { alive: true, cpuMs, underPressure };
}

/**
 * The launcher's wait before it kills a verified daemon that did not answer:
 * while its CPU time keeps rising it is pinged again every `intervalMs`, up
 * to `ceilingMs`. Only `answered` keeps it; any other outcome is the kill it
 * was headed for, now after a bounded wait instead of at once.
 */
export async function waitOutProgressingDaemon(deps: {
  pid: number;
  sample: (pid: number) => Promise<DaemonProcessSample>;
  ping: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  intervalMs: number;
  ceilingMs: number;
  progress: DaemonProgressConfig;
  onWaiting?: () => void;
}): Promise<'answered' | 'stalled' | 'gone' | 'unknown' | 'ceiling'> {
  const tracker = new DaemonProgressTracker(deps.progress);
  const start = deps.now();
  let told = false;
  for (;;) {
    const sample = await deps.sample(deps.pid).catch(() => null);
    const verdict = sample ? tracker.observe(deps.pid, sample, deps.now()) : 'unknown';
    if (verdict !== 'progressing') return verdict;
    if (deps.now() - start >= deps.ceilingMs) return 'ceiling';
    if (!told) { told = true; deps.onWaiting?.(); }
    await deps.sleep(deps.intervalMs);
    if (await deps.ping().catch(() => false)) return 'answered';
  }
}
