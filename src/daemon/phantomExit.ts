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
 * Boot-time counterpart of the guard: should this persisted tombstone be
 * reconciled — i.e. does a `dead` record still have a live process behind it?
 *
 * Pulled out of `recoverSessions` for the same reason as
 * `selectRecoverableSessions`: the eligibility policy is the part worth
 * unit-testing, and it must not require a daemon boot to exercise.
 *
 * The `rebooted` gate is the load-bearing safety check. After a reboot the
 * OS recycles pids freely, so a persisted pid that answers `kill(pid, 0)`
 * says nothing about OUR shell — it is probably some unrelated process, and
 * killing its tree would be catastrophic. Only when the bootId is unchanged
 * (same boot, no pid reuse possible for a pid we recorded this boot) is a
 * live pid behind a `dead` record provably our own orphan.
 *
 * Old state files predating pid persistence, or records written before the
 * pid was known, simply have no pid — those are skipped, not guessed at.
 */
export function shouldReconcileTombstone(
  session: { state: string; pid?: number },
  opts: { rebooted: boolean; alive: (pid: number) => boolean },
): boolean {
  if (opts.rebooted) return false;
  if (session.state !== 'dead') return false;
  const pid = session.pid;
  if (pid === undefined || pid === null) return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return opts.alive(pid);
}
