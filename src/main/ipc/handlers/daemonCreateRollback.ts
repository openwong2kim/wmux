/**
 * PTY_CREATE (daemon) rollback. main mints the session id, then runs
 * createSession → attachSession → connectSessionPipe. If any step after the id
 * exists throws, the daemon may already hold the session: an attached one is
 * never reaped and never shows as detached, so it would leak for the daemon's
 * life. The id never reached the renderer, so destroying it here is safe.
 *
 * The destroy is best-effort and never masks the original error. The daemon's
 * RPC limiter is a fixed 1s window, so a rate-limited destroy (likely when the
 * create itself failed on the limiter) is retried once after the window clears.
 */
export const ROLLBACK_RATE_LIMIT_RETRY_MS = 1100;

export interface DaemonCreateRollbackDeps {
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Undo main-side state registered inside `run`. */
  undoLocal: () => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function withDaemonCreateRollback<T>(
  sessionId: string,
  deps: DaemonCreateRollbackDeps,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await deps.rpc('daemon.destroySession', { id: sessionId });
        break;
      } catch (destroyErr) {
        const msg = destroyErr instanceof Error ? destroyErr.message : String(destroyErr);
        if (attempt === 0 && msg.includes('rate limited')) {
          await sleep(ROLLBACK_RATE_LIMIT_RETRY_MS);
          continue;
        }
        console.warn(`[pty:create] rollback destroy of ${sessionId} failed: ${msg}`);
        break;
      }
    }
    try {
      deps.undoLocal();
    } catch {
      /* best-effort: never mask the create error */
    }
    throw err;
  }
}
