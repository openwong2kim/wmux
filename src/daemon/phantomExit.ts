/**
 * Phantom-exit detection for PTY exits (issue #646).
 *
 * RCA 2026-07-27 (Windows, ConPTY): node-pty's Windows backend emits `exit`
 * from TWO distinct paths. One is the real process exit (the shell's own
 * code). The other fires when the conout socket closes — the agent's
 * `_$onProcessExit` runs with `_agent.exitCode === undefined`, which reaches
 * us as an exitCode of `null` with no signal, while `powershell.exe` (and
 * whatever agent it is hosting) is STILL RUNNING.
 *
 * The classifier in shutdownKill.ts only treats 0x40010004 / our own
 * `shuttingDown` flag as involuntary, so a null exitCode fell through to the
 * VOLUNTARY path and the session was tombstoned `dead`. Three damages
 * followed, all from the same false tombstone:
 *  1. the live shell + agent were orphaned — RAM and API quota kept burning,
 *     and nothing ever reaped them (a reporter found shells outliving their
 *     daemon by 11–12 days);
 *  2. sessions.json persisted a `dead` record holding a LIVE pid, which
 *     survived daemon restarts and hid the orphan from every census;
 *  3. the renderer, seeing its binding die, self-created a replacement pane
 *     in the wrong cwd.
 *
 * The guard is cheap and one-sided: before believing a null exitCode, ask the
 * OS whether the pid is still there. If it is, this was not a death — it was
 * the socket closing. The daemon then REAPS the orphaned tree itself and runs
 * the normal death flow with a `phantom-exit` reason, so the session ends up
 * `dead` with no live process behind it. Deliberately NOT reclassified as
 * `suspended`: that path respawns the session and would abandon the very
 * shell we are trying not to orphan.
 *
 * Stream reattachment to the still-live ConPTY is out of scope — node-pty's
 * Node-side `_outSocket` is already destroyed by the time we see the exit, so
 * the realistic win here is prevention plus reaping, not resurrection.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Is this pid still present? `signal 0` performs the permission/existence
 * check without delivering anything.
 *
 * EPERM means the process EXISTS but belongs to another user — alive for our
 * purposes (the point is "is this pid still occupied", and treating EPERM as
 * dead would let a genuine orphan through). ESRCH is the only real "gone".
 *
 * Known Windows caveat: `kill(pid, 0)` can succeed for a pid whose process has
 * already exited, so this probe leans towards "alive". Both callers are built
 * for that. At exit time a false positive costs nothing — the session still
 * ends up dead, just via the reap path, and the reap of an absent pid is a
 * no-op. At boot the reconciliation pass additionally confirms the pid really
 * is our shell before killing anything.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

/**
 * Pure decision: is this PTY `exit` a phantom — i.e. the transport died but
 * the process did not?
 *
 * True only when ALL of:
 *  - no exit code (null/undefined). A real exit always records one.
 *  - no signal. A killed process reports the signal that killed it, and that
 *    IS a death; only the code-less AND signal-less shape is anomalous.
 *  - a known pid, still alive per `alive`.
 *
 * Platform-agnostic on purpose. The observed incidents are all Windows
 * ConPTY, but on posix a genuine exit likewise always carries either a code
 * or a signal, so code-less + signal-less + still-running is just as much a
 * lie there — and gating on win32 would only hide the same bug elsewhere.
 *
 * `alive` is injected so the decision is testable without real processes;
 * production passes `isPidAlive`.
 */
export function isPhantomExit(
  exitCode: number | null | undefined,
  signal: number | undefined,
  pid: number | undefined,
  alive: (pid: number) => boolean,
): boolean {
  if (exitCode !== null && exitCode !== undefined) return false;
  if (signal !== undefined && signal !== null) return false;
  if (pid === undefined || pid === null) return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return alive(pid);
}

/**
 * The OS-reported creation time of a pid, or null if it cannot be read.
 *
 * A pid on its own is not an identity — Windows recycles pids aggressively and
 * a tombstone can outlive its shell by `deadTtlHours`, so "pid 20516 is alive"
 * says nothing about WHICH process is alive. (pid, startTime) is effectively
 * unique: the OS cannot hand the same pid to a second process at the same
 * instant. Recording it at spawn and comparing it before a kill is what stops
 * reconciliation from taskkill-ing an innocent shell that inherited the pid.
 *
 * Null on ANY failure — probe error, timeout, unparseable output, process
 * already gone. Callers must treat null as "identity unknown", never as a
 * match, since the whole point is to withhold the kill when unsure.
 */
export async function getProcessStartTime(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    return (await probeWin32Process(pid))?.creationDate ?? null;
  }
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const value = String(stdout).trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

// === Windows probes (#1493) ===
//
// These used to shell out to wmic.exe, which is disabled on Windows 11 24H2
// and absent on later builds. Every probe then threw, so the boot ID fell back
// to `uptime-<sec>` (a "reboot" on every daemon start) and every start-time /
// executable read came back empty — all reaping was withheld. CIM through
// Windows PowerShell 5.1 replaces it, the route daemonLauncherCore's
// getProcessArgv already takes.
//
// Dates are printed with ManagementDateTimeConverter.ToDmtfDateTime, which
// yields exactly wmic's `/value` format (`20260915084549.500977+540`), so the
// boot IDs and pidStartTime values persisted by wmic-era builds still compare
// equal against new reads. Only a state file holding the old `uptime-N`
// fallback reads as "rebooted" once after upgrading, which fails closed.

/** Windows PowerShell 5.1 ships with every supported Windows; pwsh may not. */
function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * PowerShell cold start is ~0.5-1 s, so wmic's 3 s budget is too tight: a
 * timeout would quietly bring back the "identity unknown" state. 5 s matches
 * daemonLauncherCore. UTF-8 output keeps a non-ASCII executable path from
 * being mangled by the OEM code page.
 */
const WIN32_PROBE_TIMEOUT_MS = 5000;
const WIN32_UTF8_OUTPUT = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';

/** wmic-style CIM_DATETIME, e.g. `20260915084549.500977+540`. */
const DMTF_DATETIME_RE = /^\d{14}\.\d{6}[+-]\d{3}$/;

const WIN32_BOOT_ID_SCRIPT =
  `${WIN32_UTF8_OUTPUT} 'LastBootUpTime=' + ` +
  '[System.Management.ManagementDateTimeConverter]::ToDmtfDateTime(' +
  '(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime)';

function win32PowerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

/** The boot time in the probe output, or null when it is not a DMTF date. */
export function parseWin32BootId(stdout: string): string | null {
  const value = String(stdout).match(/LastBootUpTime=(\S+)/)?.[1];
  return value && DMTF_DATETIME_RE.test(value) ? value : null;
}

/**
 * The boot ID cannot change while this process lives, and startup asks for it
 * up to three times (stale-lock check, initBootId, recovery). Memoizing the
 * first good read keeps that at one PowerShell spawn.
 */
let win32BootIdCache: string | null = null;

/** Windows boot ID (CIM LastBootUpTime). Throws when it cannot be read. */
export async function getWin32BootId(): Promise<string> {
  if (win32BootIdCache) return win32BootIdCache;
  const { stdout } = await promisify(execFile)(
    windowsPowerShellPath(),
    win32PowerShellArgs(WIN32_BOOT_ID_SCRIPT),
    { encoding: 'utf-8', timeout: WIN32_PROBE_TIMEOUT_MS, windowsHide: true },
  );
  const bootId = parseWin32BootId(String(stdout));
  if (!bootId) throw new Error('LastBootUpTime missing from CIM output');
  win32BootIdCache = bootId;
  return bootId;
}

/**
 * Synchronous twin for the process 'exit' handler. Normally a cache hit,
 * since main() awaits the async read before any state is built.
 */
export function getWin32BootIdSync(): string {
  if (win32BootIdCache) return win32BootIdCache;
  const stdout = execFileSync(
    windowsPowerShellPath(),
    win32PowerShellArgs(WIN32_BOOT_ID_SCRIPT),
    { encoding: 'utf-8', timeout: WIN32_PROBE_TIMEOUT_MS, windowsHide: true },
  );
  const bootId = parseWin32BootId(String(stdout));
  if (!bootId) throw new Error('LastBootUpTime missing from CIM output');
  win32BootIdCache = bootId;
  return bootId;
}

/** Test seam: forget the memoized boot ID. */
export function resetWin32BootIdCache(): void {
  win32BootIdCache = null;
}

export interface Win32ProcessInfo {
  /** Null when CIM withholds it (e.g. a protected process). */
  executablePath: string | null;
  /** DMTF creation time — the same string wmic printed. */
  creationDate: string | null;
}

function win32ProcessScript(pid: number): string {
  return (
    `${WIN32_UTF8_OUTPUT} $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop;` +
    " if ($p) { 'ExecutablePath=' + $p.ExecutablePath;" +
    " if ($p.CreationDate) { 'CreationDate=' + " +
    '[System.Management.ManagementDateTimeConverter]::ToDmtfDateTime($p.CreationDate) } }'
  );
}

/** Parse the process probe output; null when the process was not found. */
export function parseWin32ProcessInfo(stdout: string): Win32ProcessInfo | null {
  const text = String(stdout);
  const exe = text.match(/^ExecutablePath=(.*)$/m);
  if (!exe) return null;
  const date = text.match(/^CreationDate=(\S+)/m)?.[1];
  return {
    executablePath: exe[1].trim() || null,
    creationDate: date && DMTF_DATETIME_RE.test(date) ? date : null,
  };
}

/**
 * Recovery can create dozens of panes at once and each stamps its start time.
 * A PowerShell per pane, all at once, is a real memory spike, so probes queue
 * behind a small cap. Concurrent asks for the same pid share one spawn —
 * reapIfIdentityConfirmed reads the start time and the executable in parallel.
 */
const WIN32_PROBE_CONCURRENCY = 4;
let win32ProbesRunning = 0;
const win32ProbeWaiters: Array<() => void> = [];
const win32ProbesInFlight = new Map<number, Promise<Win32ProcessInfo | null>>();

async function withWin32ProbeSlot<T>(run: () => Promise<T>): Promise<T> {
  while (win32ProbesRunning >= WIN32_PROBE_CONCURRENCY) {
    await new Promise<void>((resolve) => win32ProbeWaiters.push(resolve));
  }
  win32ProbesRunning++;
  try {
    return await run();
  } finally {
    win32ProbesRunning--;
    win32ProbeWaiters.shift()?.();
  }
}

/**
 * Executable path and creation time of a Windows pid, or null on ANY failure
 * (probe error, timeout, process gone). Callers treat null as "identity
 * unknown" and withhold the kill.
 */
export function probeWin32Process(pid: number): Promise<Win32ProcessInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  const inFlight = win32ProbesInFlight.get(pid);
  if (inFlight) return inFlight;
  const probe = withWin32ProbeSlot(async () => {
    try {
      const { stdout } = await promisify(execFile)(
        windowsPowerShellPath(),
        win32PowerShellArgs(win32ProcessScript(pid)),
        { encoding: 'utf-8', timeout: WIN32_PROBE_TIMEOUT_MS, windowsHide: true },
      );
      return parseWin32ProcessInfo(String(stdout));
    } catch {
      return null;
    }
  }).finally(() => win32ProbesInFlight.delete(pid));
  win32ProbesInFlight.set(pid, probe);
  return probe;
}

/**
 * Is the Windows pid running the shell executable we spawned? Matches the
 * basename or the full path, as the wmic-era check did. False when unsure.
 */
export async function isWin32ShellProcess(pid: number, expectedCmd: string): Promise<boolean> {
  const actualExe = (await probeWin32Process(pid))?.executablePath?.toLowerCase();
  if (!actualExe) return false;
  const expectedExe = expectedCmd.toLowerCase();
  const expectedBase = expectedExe.split(/[\\/]/).pop() ?? expectedExe;
  return actualExe.endsWith(expectedBase) || actualExe === expectedExe;
}

/**
 * How confidently can we say the process behind `pid` is the one we spawned?
 *
 *  - `start-time`   — the recorded creation time matches what the OS reports
 *                     now. (pid, startTime) is unique, so this is proof.
 *  - `heuristic`    — no creation time was recorded (a tombstone written by a
 *                     build predating it), but the executable still looks like
 *                     our shell. Weaker: any `powershell.exe` passes. Accepted
 *                     only so pre-existing orphans can still be cleaned up.
 *  - `unconfirmed`  — a creation time was recorded and does NOT match (the pid
 *                     belongs to something else now), or nothing corroborates
 *                     the pid at all. Never kill on this.
 *
 * A recorded start time is authoritative when present: if it disagrees, the
 * executable-name heuristic must not be allowed to override it — that is
 * exactly the recycled-pid case (`powershell.exe` reborn under the same pid).
 */
export type ReapIdentity = 'start-time' | 'heuristic' | 'unconfirmed';

export function classifyReapIdentity(opts: {
  storedStartTime?: string | null;
  currentStartTime: string | null;
  looksLikeOurShell: boolean;
}): ReapIdentity {
  if (opts.storedStartTime) {
    return opts.currentStartTime !== null && opts.currentStartTime === opts.storedStartTime
      ? 'start-time'
      : 'unconfirmed';
  }
  return opts.looksLikeOurShell ? 'heuristic' : 'unconfirmed';
}

/** Is this identity level strong enough to authorize killing the tree? */
export function mayReap(identity: ReapIdentity): boolean {
  return identity !== 'unconfirmed';
}

/**
 * Can we PROVE the state file was written during the boot we are running in?
 *
 * Only a stored bootId that exists and matches counts. A missing stored bootId
 * (pre-bootId build, or a lost/rewritten state file) proves nothing and must
 * never be read as "no reboot happened" — that inversion is what would let
 * tombstone reconciliation kill a recycled pid across a real reboot.
 */
export function isSameBootProven(
  storedBootId: string | null | undefined,
  currentBootId: string | null | undefined,
): boolean {
  if (storedBootId == null || currentBootId == null) return false;
  return storedBootId === currentBootId;
}

/**
 * Boot-time counterpart of the guard: should this persisted tombstone be
 * reconciled — i.e. does a `dead` record still have a live process behind it?
 *
 * Pulled out of `recoverSessions` for the same reason as
 * `selectRecoverableSessions`: the eligibility policy is the part worth
 * unit-testing, and it must not require a daemon boot to exercise.
 *
 * `sameBootProven` is the load-bearing safety check, and it is deliberately
 * phrased as POSITIVE proof rather than "not rebooted". After a reboot the OS
 * recycles pids freely, so a persisted pid that answers `kill(pid, 0)` says
 * nothing about OUR shell — it is probably some unrelated process, and killing
 * its tree would be catastrophic. Absence of evidence is not proof: a state
 * file written before bootIds were recorded has no bootId at all, which the
 * old "rebooted" phrasing read as "no reboot happened" and would have
 * authorized a kill across an actual reboot. The caller must pass true only
 * when a stored bootId EXISTS and equals the current one.
 *
 * Old state files predating pid persistence, or records written before the
 * pid was known, simply have no pid — those are skipped, not guessed at.
 */
export function shouldReconcileTombstone(
  session: { state: string; pid?: number },
  opts: { sameBootProven: boolean; alive: (pid: number) => boolean },
): boolean {
  if (!opts.sameBootProven) return false;
  if (session.state !== 'dead') return false;
  const pid = session.pid;
  if (pid === undefined || pid === null) return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return opts.alive(pid);
}
