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
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const path = await import('node:path');
    const execFileAsync = promisify(execFile);
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const wmic = path.join(systemRoot, 'System32', 'wbem', 'wmic.exe');
      const { stdout } = await execFileAsync(
        wmic,
        ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
        { encoding: 'utf-8', timeout: 3000, windowsHide: true },
      );
      // "CreationDate=20260727142800.123456+540"
      const match = String(stdout).match(/CreationDate=(\S+)/i);
      const value = match?.[1]?.trim();
      return value ? value : null;
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const value = String(stdout).trim();
    return value ? value : null;
  } catch {
    return null;
  }
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
