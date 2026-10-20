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
import { tryProcessIdentity } from '../main/pty/winSnapshotNative';

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
 * Windows reports the FILETIME as a decimal string (see
 * {@link getProcessCreatedAtFt}); posix reports `ps -o lstart=`.
 *
 * Null on ANY failure — probe error, timeout, unparseable output, process
 * already gone. Callers must treat null as "identity unknown", never as a
 * match, since the whole point is to withhold the kill when unsure.
 */
export async function getProcessStartTime(pid: number): Promise<string | null> {
  if (process.platform === 'win32') {
    return getProcessCreatedAtFt(pid)?.toString() ?? null;
  }
  return (await readPosixStartTime(pid)).value;
}

/**
 * One start-time reading. `gone` is set when the OS answered that the pid does
 * not exist — an answer, unlike a failed read, which leaves both empty.
 */
export interface ProcessStartRead<T> {
  value: T | null;
  gone: boolean;
}

/**
 * `ps -o lstart= -p <pid>` (posix). `ps` exits 1 with no output when no
 * process matched the pid, which is the one failure that means gone; a
 * timeout, a missing `ps` or anything it printed is a failed read.
 */
export async function readPosixStartTime(pid: number): Promise<ProcessStartRead<string>> {
  if (!Number.isInteger(pid) || pid <= 0) return { value: null, gone: false };
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const value = String(stdout).trim();
    return { value: value ? value : null, gone: false };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
    const silent = !String(e.stdout ?? '').trim() && !String(e.stderr ?? '').trim();
    return { value: null, gone: e.code === 1 && silent };
  }
}

// === Windows probes (#1493, #2398) ===
//
// These used to shell out to wmic.exe, which is disabled on Windows 11 24H2
// and absent on later builds. Every probe then threw, so the boot ID fell back
// to `uptime-<sec>` (a "reboot" on every daemon start) and every start-time /
// executable read came back empty — all reaping was withheld. CIM through
// Windows PowerShell 5.1 replaced it, the route daemonLauncherCore's
// getProcessArgv already takes.
//
// The boot ID still takes that route: it is read once and memoized. The
// per-process reads (start time, executable) are native since #2398 — one
// PowerShell per create and per reap meant dozens of them during a cold-start
// burst, and the ones that timed out left the reaper unable to confirm a pid.
//
// Boot dates are printed with ManagementDateTimeConverter.ToDmtfDateTime,
// which yields exactly wmic's `/value` format (`20260915084549.500977+540`),
// so the boot IDs persisted by wmic-era builds still compare equal against new
// reads. Only a state file holding the old `uptime-N` fallback reads as
// "rebooted" once after upgrading, which fails closed. pidStartTime values in
// that format are compared through {@link dmtfToUtcMicros}.

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
 * macOS boot ID from `sysctl -n kern.bootsessionuuid`, or null when the output
 * is not a UUID. Not `kern.boottime`: XNU shifts that by the delta of every
 * calendar clock step (an NTP sync), so a same-boot restart read as a reboot
 * and skipped leftover-shell cleanup (#2497).
 */
export function parseDarwinBootId(stdout: string): string | null {
  const value = String(stdout).trim();
  return /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(value)
    ? `darwin-${value.toUpperCase()}`
    : null;
}

/**
 * The stored boot ID as recovery may compare it. Builds before #2497 saved
 * `darwin-<boottime seconds>`, which can never equal a UUID ID, so it proves
 * neither a reboot nor the same boot: read it like a state file with no boot
 * ID (#646), which still lets the identity-checked leftover reap run.
 */
export function comparableStoredBootId(stored: string | null | undefined): string | null | undefined {
  return stored && /^darwin-\d+$/.test(stored) ? null : stored;
}

/**
 * May recovery's leftover reap try this record? Without a proven same boot the
 * pid may have been recycled, and a same-named shell would pass the name
 * heuristic, so only a recorded start time can confirm it (#2497).
 */
export function leftoverReapEligible(
  record: { pidStartTime?: string; pidCreatedAtFt?: string },
  sameBootProven: boolean,
): boolean {
  return sameBootProven || !!record.pidCreatedAtFt || !!record.pidStartTime;
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

/**
 * A failed native read on a live pid is logged at most once a minute, with a
 * count of the failures in between: during a burst every reap can fail the
 * same way, and one line says that as well as a hundred. index.ts routes this
 * to the daemon log, which this module cannot reach on its own.
 */
const NATIVE_READ_WARN_INTERVAL_MS = 60_000;
let nativeReadWarn: (message: string) => void = (message) => console.warn(message);
let nativeReadWarnedAt = -Infinity;
let nativeReadFailuresSinceWarn = 0;

export function setNativeProcessReadWarn(warn: (message: string) => void): void {
  nativeReadWarn = warn;
}

/** Test seam: forget when the last warning was written. */
export function resetNativeProcessReadWarn(): void {
  nativeReadWarnedAt = -Infinity;
  nativeReadFailuresSinceWarn = 0;
}

function readWin32Process(pid: number): { createdAt: bigint; imagePath: string | null } | 'gone' | null {
  const read = tryProcessIdentity(pid);
  if (!('failure' in read)) return read;
  // A pid that is gone is an answer, not a failed read.
  if (read.gone) return 'gone';
  nativeReadFailuresSinceWarn++;
  const now = Date.now();
  if (now - nativeReadWarnedAt >= NATIVE_READ_WARN_INTERVAL_MS) {
    const others = nativeReadFailuresSinceWarn - 1;
    nativeReadWarn(
      `[phantomExit] native process read failed for pid ${pid}: ${read.failure}` +
        (others > 0 ? ` (${others} more since the last warning)` : ''),
    );
    nativeReadWarnedAt = now;
    nativeReadFailuresSinceWarn = 0;
  }
  return null;
}

/**
 * The creation time of a Windows pid as a FILETIME (100 ns units since 1601),
 * or null when it cannot be read or this is not Windows. Synchronous and
 * cheap (one OpenProcess), so the spawn path stamps it inline.
 */
export function getProcessCreatedAtFt(pid: number): bigint | null {
  return readProcessCreatedAtFt(pid).value;
}

/** {@link getProcessCreatedAtFt}, also saying whether the pid is gone. */
export function readProcessCreatedAtFt(pid: number): ProcessStartRead<bigint> {
  if (process.platform !== 'win32') return { value: null, gone: false };
  const read = readWin32Process(pid);
  if (read === 'gone') return { value: null, gone: true };
  return { value: read?.createdAt ?? null, gone: false };
}

/**
 * Is `imagePath` the shell executable we spawned? Matches the basename or the
 * full path, as the wmic-era check did. False when the path is unknown.
 */
export function isShellExecutable(imagePath: string | null, expectedCmd: string): boolean {
  const actualExe = imagePath?.toLowerCase();
  if (!actualExe) return false;
  const expectedExe = expectedCmd.toLowerCase();
  const expectedBase = expectedExe.split(/[\\/]/).pop() ?? expectedExe;
  return actualExe.endsWith(expectedBase) || actualExe === expectedExe;
}

/**
 * Everything {@link classifyReapIdentity} needs about a Windows pid now, from
 * ONE native read. Two reads (one for the creation time, one for the
 * executable) could disagree: the first failing and the second succeeding
 * left no creation time but an executable match, which the heuristic would
 * accept for a record with no stored time — a recycled pid running the same
 * shell would have been killed. A failed read yields no evidence at all.
 */
export function readWin32ReapIdentity(pid: number, expectedCmd: string): {
  currentCreatedAtFt: bigint | null;
  currentGone: boolean;
  looksLikeOurShell: boolean;
} {
  const read = readWin32Process(pid);
  if (read === 'gone') return { currentCreatedAtFt: null, currentGone: true, looksLikeOurShell: false };
  if (read === null) return { currentCreatedAtFt: null, currentGone: false, looksLikeOurShell: false };
  return {
    currentCreatedAtFt: read.createdAt,
    currentGone: false,
    looksLikeOurShell: isShellExecutable(read.imagePath, expectedCmd),
  };
}

/**
 * How confidently can we say the process behind `pid` is the one we spawned?
 *
 *  - `start-time`   — the recorded creation time matches what the OS reports
 *                     now. (pid, startTime) is unique, so this is proof.
 *  - `heuristic`    — no creation time was recorded (a tombstone written by a
 *                     build predating it), but the executable still looks like
 *                     our shell. Weaker: any `powershell.exe` passes. Accepted
 *                     only so pre-existing orphans can still be cleaned up,
 *                     and only when the creation time could be read now too:
 *                     an unreadable process is unknown, and unknown never
 *                     authorizes a kill.
 *  - `unconfirmed`  — a creation time was recorded and does NOT match (the pid
 *                     belongs to something else now), or nothing corroborates
 *                     the pid at all. Never kill on this.
 *  - `gone`         — the OS answered that the pid no longer exists, so there
 *                     is nothing to kill. Not a refusal: the old probe read an
 *                     exited pid as "unknown", and those exits were logged as
 *                     unconfirmed identities.
 *
 * A recorded start time is authoritative when present: if it disagrees, the
 * executable-name heuristic must not be allowed to override it — that is
 * exactly the recycled-pid case (`powershell.exe` reborn under the same pid).
 *
 * What may have been recorded, strongest first:
 *  - `storedCreatedAtFt`: the Windows FILETIME (#2398), compared exactly
 *    with `currentCreatedAtFt`.
 *  - `storedStartTime` on Windows: a DMTF string written before #2398. It
 *    holds only microseconds and a local-time offset, so both sides are
 *    reduced to UTC microseconds first; a time-zone or DST change since the
 *    record was written does not matter.
 *  - `storedStartTime` on posix: `ps -o lstart=`, compared as a string with
 *    `currentStartTime`.
 */
export type ReapIdentity = 'start-time' | 'heuristic' | 'unconfirmed' | 'gone';

export function classifyReapIdentity(opts: {
  storedCreatedAtFt?: string | null;
  storedStartTime?: string | null;
  /** Windows: the FILETIME read now. */
  currentCreatedAtFt?: bigint | null;
  /** Posix: `ps -o lstart=` read now. */
  currentStartTime?: string | null;
  /** The current read found no process with this pid. */
  currentGone?: boolean;
  looksLikeOurShell: boolean;
}): ReapIdentity {
  if (opts.currentGone) return 'gone';
  const currentFt = opts.currentCreatedAtFt ?? null;
  if (opts.storedCreatedAtFt) {
    return currentFt !== null && currentFt.toString() === opts.storedCreatedAtFt ? 'start-time' : 'unconfirmed';
  }
  if (opts.storedStartTime) {
    if (currentFt !== null) {
      const stored = dmtfToUtcMicros(opts.storedStartTime);
      return stored !== null && stored === fileTimeToUtcMicros(currentFt) ? 'start-time' : 'unconfirmed';
    }
    const current = opts.currentStartTime ?? null;
    return current !== null && current === opts.storedStartTime ? 'start-time' : 'unconfirmed';
  }
  const readNow = currentFt !== null || (opts.currentStartTime ?? null) !== null;
  return readNow && opts.looksLikeOurShell ? 'heuristic' : 'unconfirmed';
}

/**
 * Do two {@link getProcessStartTime} readings name the same process? Equal
 * strings do. So does a DMTF string stored before #2398 against the FILETIME
 * Windows reports now, compared in UTC microseconds. Anything else does not.
 */
export function sameProcessStartTime(stored: string, current: string | null): boolean {
  if (current === null) return false;
  if (current === stored) return true;
  const storedMicros = dmtfToUtcMicros(stored);
  if (storedMicros === null || !/^\d+$/.test(current)) return false;
  return storedMicros === fileTimeToUtcMicros(BigInt(current));
}

/** The Unix epoch as a FILETIME: 100 ns intervals from 1601-01-01 to 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

/** A FILETIME as whole microseconds since the Unix epoch (UTC), truncated. */
export function fileTimeToUtcMicros(fileTime: bigint): bigint {
  return (fileTime - FILETIME_UNIX_EPOCH) / 10n;
}

const DMTF_PARTS_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/;

/**
 * A DMTF datetime (`yyyymmddHHMMSS.ffffff±UUU`: local time, then its offset
 * from UTC in minutes) as microseconds since the Unix epoch (UTC), or null
 * when it is not one. ToDmtfDateTime truncates to microseconds, which is why
 * the FILETIME it is compared with is truncated too.
 */
export function dmtfToUtcMicros(value: string): bigint | null {
  const m = DMTF_PARTS_RE.exec(value);
  if (!m) return null;
  const [, year, month, day, hour, minute, second, micros, sign, offset] = m;
  const localMs = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const offsetMicros = BigInt(offset) * 60_000_000n;
  return BigInt(localMs) * 1000n + BigInt(micros) - (sign === '+' ? offsetMicros : -offsetMicros);
}

/** Is this identity level strong enough to authorize killing the tree? */
export function mayReap(identity: ReapIdentity): boolean {
  return identity === 'start-time' || identity === 'heuristic';
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
