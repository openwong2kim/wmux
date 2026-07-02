/**
 * Shutdown-kill classification for PTY exits.
 *
 * RCA 2026-07-02 (reboot-reattach): during an OS shutdown/reboot Windows
 * terminates the daemon's PTY children BEFORE the daemon process itself.
 * The daemon then observes each `pty-exit` and — unable to tell a system
 * teardown from a user typing `exit` — marked those sessions 'dead' and
 * persisted the tombstones. Post-reboot recovery skips 'dead', so exactly
 * the sessions that were being USED (attached, in the renderer layout) got
 * purged, while unobserved ghosts survived. The renderer's saved ptyIds then
 * matched nothing → self-create → "terminal reset after reboot".
 *
 * Classification signals:
 *  - exitCode 0x40010004 (DBG_TERMINATE_PROCESS): what conhost/ConPTY children
 *    report when Windows tears the console session down at shutdown/logoff.
 *    Observed on all 11 purged sessions in the 2026-07-02 incident log. A
 *    voluntary shell exit reports the shell's own code (0, 1, ...), never this.
 *  - `shuttingDown`: the daemon's own graceful-shutdown flag. Covers the posix
 *    path (SIGTERM fans out to children concurrently with our suspend loop)
 *    and any pty that dies while the graceful suspend is in flight.
 *
 * A session classified as a shutdown-kill is SUSPENDED (buffer dumped, state
 * persisted) instead of marked dead, so recovery replays it under the SAME id
 * and the renderer's persisted binding reconnects. Misclassification (e.g. a
 * cancelled shutdown, or someone force-killing a lone conhost) is corrected by
 * a reclassification timer in daemon/index.ts: if the daemon is still alive
 * after the window, the standard death flow runs.
 */

/** DBG_TERMINATE_PROCESS — Windows console teardown at shutdown/logoff. */
export const SHUTDOWN_KILL_EXIT_CODE = 0x40010004;

/**
 * How long the daemon must survive a shutdown-kill-classified exit before
 * concluding the OS did NOT go down (cancelled shutdown / isolated conhost
 * kill) and running the normal death flow. During a real shutdown the daemon
 * is killed within seconds, so the timer never fires and the suspended state
 * persisted at classification time is what recovery sees after reboot.
 */
export const SHUTDOWN_KILL_RECLASSIFY_MS = 15_000;

/**
 * Pure decision: should this PTY exit suspend the session (recovery replays
 * it) instead of killing it (recovery purges it)?
 */
export function isShutdownKillExit(
  exitCode: number | null,
  opts: { platform: NodeJS.Platform; shuttingDown: boolean },
): boolean {
  if (opts.shuttingDown) return true;
  return opts.platform === 'win32' && exitCode === SHUTDOWN_KILL_EXIT_CODE;
}
