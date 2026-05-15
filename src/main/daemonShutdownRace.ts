// Side-effect-free helper for racing daemon.shutdown against a budget.
//
// Phase A — A3 (before-quit) and A5 (session-end / WM_ENDSESSION) both need
// to send daemon.shutdown via the control RPC, wait up to a bounded time for
// the daemon to dump RingBuffers atomically, then fall back to the existing
// detach-only path if the daemon does not finish in time.
//
// The default timeout is calibrated by the T5 dynamic test (Task #15);
// callers pass a measured value. Until that measurement lands, callers pass
// the documented placeholder of 4 s for before-quit and 1 s for session-end.

export interface DaemonShutdownRaceResult {
  ok: boolean;
  /** Reason for the failure, if any. Useful for log breadcrumbs. */
  error?: string;
}

// Minimal client shape used here. Decouples this helper from DaemonClient so
// tests can pass a tiny stub instead of bootstrapping a real net pipe.
export interface DaemonShutdownClient {
  rpc: (
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ) => Promise<unknown>;
}

export async function raceDaemonShutdown(
  client: DaemonShutdownClient,
  timeoutMs: number,
): Promise<DaemonShutdownRaceResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      client.rpc('daemon.shutdown', {}, { timeoutMs }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`daemon.shutdown race timeout (${timeoutMs}ms)`)),
          timeoutMs,
        );
      }),
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
