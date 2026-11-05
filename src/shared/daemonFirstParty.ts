/**
 * The refusal the daemon gives an A2A call from a connection that has not
 * identified as the app (DaemonPipeServer.dispatch). DaemonClient identifies
 * again and retries once when a call fails with it.
 */
export const NOT_FIRST_PARTY = 'not_first_party';
