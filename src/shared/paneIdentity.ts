/**
 * Caller-to-pane identity verification: the shared vocabulary between main
 * (which checks a caller's process ancestry), the CLI and the MCP server.
 *
 * `a2a.resolve.identity { callerPid }` answers with `resolvedStatus`:
 *   - 'hit'         the caller runs under a live pane's shell;
 *   - 'miss'        a process table was read and no pane shell is among the
 *                   caller's ancestors;
 *   - 'unavailable' the process table could not be read (after one retry), so
 *                   nothing was verified either way.
 * A main that omits the field predates the check.
 */

export type PaneAncestryStatus = 'hit' | 'miss' | 'unavailable';

export const PANE_IDENTITY_MISS_MESSAGE =
  "this command is running outside its pane's process tree (for example under a shared Codex app-server, " +
  'or under tmux, screen, nohup or setsid), so wmux cannot tell which pane it belongs to. ' +
  'Relaunch Codex with `codex --no-daemon`, or run the command from the pane\'s own shell.';

export const PANE_IDENTITY_UNAVAILABLE_MESSAGE =
  'could not verify which pane this command runs in; retry.';

export const PANE_IDENTITY_UNVERIFIED_WRITE_MESSAGE =
  'could not verify which pane this command runs in (the wmux app is not reachable, or is older than this ' +
  'client), so writes are refused. Retry with wmux running.';

export function isPaneAncestryStatus(v: unknown): v is PaneAncestryStatus {
  return v === 'hit' || v === 'miss' || v === 'unavailable';
}

/** A usable caller pid, or null (absent, non-integer, non-positive). */
export function normalizeCallerPid(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}
