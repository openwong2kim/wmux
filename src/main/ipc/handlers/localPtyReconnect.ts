/**
 * #2398 — pty:reconnect while main runs local ptys (no daemon client).
 *
 * A pane bound to an id this process does not own asks after either a local
 * pty that exited or a daemon session. While a daemon may still come back
 * (first launch in flight, respawn pending) the id may be a living daemon
 * session, so the answer is transient: the renderer keeps the binding and
 * retries. Once the fallback is final (the respawn budget ran out; a failed
 * first launch enters the respawn loop too) nothing will ever own that id
 * again in this run, and the answer is the authoritative `session-dead` that
 * lets the renderer clear the binding (or hand an unconfirmed one to the reconcile) and create a local
 * shell. Answering without `transient` kept such a pane on the dead id
 * forever: every retry, and every Retry press, read as transient.
 */

export type LocalReconnectAnswer =
  | { success: true; id: string; shell: string }
  | { success: false; error: string; code: 'daemon-reconnecting' | 'session-dead'; transient: boolean };

export function localReconnectAnswer(
  instance: { id: string; shell: string } | undefined,
  daemonMayReturn: boolean,
): LocalReconnectAnswer {
  if (instance) return { success: true, id: instance.id, shell: instance.shell };
  return daemonMayReturn
    ? { success: false, error: 'PTY not found', code: 'daemon-reconnecting', transient: true }
    : { success: false, error: 'PTY not found', code: 'session-dead', transient: false };
}
