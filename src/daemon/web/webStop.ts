/**
 * Stop both forms of the web server without ever acknowledging a half-stop.
 *
 * Persist first: if the process dies afterward, process death stops the live
 * listener and the next daemon sees disabled state. A persistence failure is
 * captured rather than thrown immediately so the live listener is still
 * stopped; only then is the durable failure surfaced to the operator.
 */
export async function stopWebServerDurably<T>(
  revokePersistedState: () => void,
  stopLiveServer: () => Promise<T>,
): Promise<T> {
  let persistenceFailed = false;
  let persistenceError: unknown;
  try {
    revokePersistedState();
  } catch (error) {
    persistenceFailed = true;
    persistenceError = error;
  }

  let result: T;
  try {
    result = await stopLiveServer();
  } catch (liveError) {
    if (!persistenceFailed) throw liveError;

    const persistenceReason =
      persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
    const liveReason = liveError instanceof Error ? liveError.message : String(liveError);
    throw new Error(
      `The web server could not be stopped now (${liveReason}), and persisted state ` +
        `could not be revoked (${persistenceReason}); the listener may still be running ` +
        'and may return after a daemon restart.',
    );
  }

  if (persistenceFailed) {
    const reason =
      persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
    throw new Error(
      'The web server is stopped now, but persisted state could not be revoked; ' +
        `it may return after a daemon restart: ${reason}`,
    );
  }
  return result;
}
