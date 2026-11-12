/**
 * The refusal the daemon gives an app-only call (see `isAppOnlyDaemonMethod`)
 * from a connection that has not identified as the app
 * (DaemonPipeServer.dispatch). DaemonClient identifies again and retries once
 * when a call fails with it.
 */
export const NOT_FIRST_PARTY = 'not_first_party';

/**
 * Daemon methods that act for whichever workspace or pane the call names, so
 * the daemon answers them only on the app's own connection: A2A tasks,
 * channels, principals and remote links, and fan-out task missions. The
 * exceptions are listed in DaemonPipeServer: the channel calls a pane's own
 * tools make, and the pairing calls of `wmux remote` on a host the app does
 * not use.
 */
export function isAppOnlyDaemonMethod(method: string): boolean {
  return method.startsWith('a2a.') || method.startsWith('task.mission.');
}
