/**
 * The daemon's idle clock has more than one source of "somebody was here".
 *
 * Historically there was exactly one — `DaemonPipeServer.getLastDisconnectAt()`,
 * the moment the last desktop client let go of the control pipe — and Watchdog
 * measured the idle window from it directly. #1316 added a second: an
 * authenticated request on the phone's HTTP surface, which never touches the
 * pipe at all. Two independent clocks would have meant whichever one the check
 * happened to read could shut the daemon down while the other said "in use", so
 * they are folded into one anchor here instead.
 *
 * `null` means "this source has never seen anybody" and is NOT a timestamp of
 * zero — Watchdog falls back to the daemon's own `startTime` when every source
 * answers null, so a daemon that booted and was never touched still counts its
 * idle window from boot rather than from 1970.
 */
export function newerTimestamp(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
