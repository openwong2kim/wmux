/**
 * RCA A1 — reconnect a live daemon session with retry, distinguishing
 * transient from permanent failure.
 *
 * Extracted from useTerminal so the policy can be unit-tested in isolation
 * (no xterm / zustand / electron import needed). Dependencies are injected.
 *
 * The pre-fix code called `pty.reconnect(ptyId)` once and, on ANY failure,
 * immediately cleared the surface's ptyId — making Terminal self-create a
 * fresh empty session. That conflated two very different situations:
 *
 *   - permanent (transient:false): the daemon reports the session genuinely
 *     dead → clearing is correct (the next mount self-creates).
 *   - transient (transient:true / unknown): the session is alive but the
 *     freshly-attached pipe is not writable yet, or the RPC threw during a
 *     main-side handler-swap window → clearing here DESTROYS a live session.
 *     This is the reported "daemon reset, session replaced" bug.
 *
 * We retry transient failures with short backoff and only clear as a last
 * resort after retries are exhausted. `isCurrent()` lets the caller bail the
 * moment the terminal unmounts so we never mutate state for a torn-down view.
 */

export interface ReconnectResult {
  success: boolean;
  error?: string;
  transient?: boolean;
}

export interface ReconnectDeps {
  /** Invoke the pty.reconnect RPC. */
  reconnect: (id: string) => Promise<ReconnectResult>;
  /** Clear the surface's ptyId so the next mount self-creates. */
  clearPtyId: (id: string) => void;
  /** Sleep between retries. Injectable so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional structured logger. Defaults to console. */
  log?: (level: 'warn' | 'error', message: string) => void;
}

/** Backoff schedule for transient retries. ~2.8s cumulative ceiling. */
export const RECONNECT_BACKOFFS_MS = [400, 900, 1500];

export async function reconnectPtyWithRetry(
  ptyId: string,
  isCurrent: () => boolean,
  deps: ReconnectDeps,
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((level, message) => {
    // eslint-disable-next-line no-console
    console[level](message);
  });

  let lastErr = '<no error>';
  for (let attempt = 0; attempt <= RECONNECT_BACKOFFS_MS.length; attempt++) {
    if (!isCurrent()) return; // terminal unmounted mid-retry — stop, mutate nothing
    let result: ReconnectResult | undefined;
    try {
      result = await deps.reconnect(ptyId);
    } catch (err) {
      // A thrown RPC is a transient infrastructure failure, not proof of death.
      lastErr = err instanceof Error ? err.message : String(err);
      result = { success: false, transient: true, error: lastErr };
    }
    if (result?.success) return;
    lastErr = result?.error ?? '<no error>';
    // Permanent failure (daemon says the session is dead): clear now, no retry.
    if (result?.transient === false) {
      log('warn', `[useTerminal] pty.reconnect ${ptyId} permanent failure (${lastErr}) — clearing ptyId for self-create`);
      if (isCurrent()) deps.clearPtyId(ptyId);
      return;
    }
    // Transient (or unknown): back off and retry unless attempts are exhausted.
    if (attempt < RECONNECT_BACKOFFS_MS.length) {
      log('warn', `[useTerminal] pty.reconnect ${ptyId} transient failure (${lastErr}) — retry ${attempt + 1}/${RECONNECT_BACKOFFS_MS.length} after ${RECONNECT_BACKOFFS_MS[attempt]}ms`);
      await sleep(RECONNECT_BACKOFFS_MS[attempt]);
    }
  }
  // Exhausted all retries on transient failures. Clear as a last resort so the
  // surface doesn't keep a stale ptyId that silently never forwards input.
  log('error', `[useTerminal] pty.reconnect ${ptyId} still failing after ${RECONNECT_BACKOFFS_MS.length} retries (${lastErr}) — clearing ptyId`);
  if (isCurrent()) deps.clearPtyId(ptyId);
}
