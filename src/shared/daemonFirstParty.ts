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
 * channels, principals and remote links, and fan-out task missions.
 */
export function isAppOnlyDaemonMethod(method: string): boolean {
  return method.startsWith('a2a.') || method.startsWith('task.mission.');
}
