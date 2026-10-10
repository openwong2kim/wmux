import type { DeadPaneRecovery } from '../../shared/ptyRecovery';

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
  recoveryPending?: boolean;
  /**
   * #1305 — the pane stayed pending because its WSL directory is gone, not
   * because the distro was busy or unreachable. Retry cannot clear it, so the
   * banner offers a fresh start in the home directory alongside Retry.
   */
  cwdMissing?: boolean;
  recovery?: DeadPaneRecovery;
  /** The session's stored PTY geometry, reported on success. */
  cols?: number;
  rows?: number;
}

export interface ReconnectDeps {
  /** Invoke the pty.reconnect RPC. */
  reconnect: (id: string) => Promise<ReconnectResult>;
  /** Clear the surface's ptyId so the next mount self-creates. */
  onRecoveryError?: (message: string | null, info?: { cwdMissing?: boolean; rateLimited?: boolean }) => void;
  clearPtyId: (id: string, recovery?: DeadPaneRecovery) => void;
  /** Sleep between retries. Injectable so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional structured logger. Defaults to console. */
  log?: (level: 'warn' | 'error', message: string) => void;
  /** Uniform [0, 1) source for backoff jitter. Injectable for tests. */
  random?: () => number;
}

/** Backoff schedule for transient retries. ~2.8s cumulative ceiling (±jitter). */
export const RECONNECT_BACKOFFS_MS = [400, 900, 1500];

/**
 * Extra slots used only once the daemon has answered "rate limited" (its
 * global/per-socket RPC cap). That is load, not a dead session, so the
 * reconnect keeps waiting — ~10s in all — and never discards the live PTY.
 */
export const RATE_LIMIT_EXTRA_BACKOFFS_MS = [1500, 2000, 2500];

/** Each backoff slot is scaled by a factor in [1 - JITTER, 1 + JITTER), so
 *  many panes reconnecting at once do not retry in lockstep. */
export const RECONNECT_JITTER = 0.25;

export function isRateLimitedError(message: string | undefined): boolean {
  return typeof message === 'string' && /rate limit/i.test(message);
}

export async function reconnectPtyWithRetry(
  ptyId: string,
  isCurrent: () => boolean,
  deps: ReconnectDeps,
): Promise<{ cols: number; rows: number } | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((level, message) => {
    // eslint-disable-next-line no-console
    console[level](message);
  });

  const random = deps.random ?? Math.random;
  const schedule = [...RECONNECT_BACKOFFS_MS, ...RATE_LIMIT_EXTRA_BACKOFFS_MS];
  let lastErr = '<no error>';
  let rateLimited = false;
  for (let attempt = 0; ; attempt++) {
    if (!isCurrent()) return null; // terminal unmounted mid-retry — stop, mutate nothing
    let result: ReconnectResult | undefined;
    try {
      result = await deps.reconnect(ptyId);
    } catch (err) {
      // A thrown RPC is a transient infrastructure failure, not proof of death.
      lastErr = err instanceof Error ? err.message : String(err);
      result = { success: false, transient: true, error: lastErr };
    }
    if (result?.success) {
      // A reconnect that settles after its terminal was replaced reports
      // nothing: its geometry must not resize the terminal current now.
      if (!isCurrent()) return null;
      deps.onRecoveryError?.(null);
      return result.cols && result.rows ? { cols: result.cols, rows: result.rows } : null;
    }
    if (result?.recoveryPending) {
      if (isCurrent()) {
        deps.onRecoveryError?.(
          result.error || 'WSL recovery failed. Check the target and retry.',
          { cwdMissing: result.cwdMissing === true },
        );
      }
      return null; // Keep the original id, binding and scrollback. Retry is explicit.
    }
    lastErr = result?.error ?? '<no error>';
    // Permanent failure (daemon says the session is dead): clear now, no retry.
    if (result?.transient === false) {
      log('warn', `[useTerminal] pty.reconnect ${ptyId} permanent failure (${lastErr}) — clearing ptyId for self-create`);
      if (isCurrent()) deps.clearPtyId(ptyId, result.recovery);
      return null;
    }
    if (isRateLimitedError(lastErr)) rateLimited = true;
    // Transient (or unknown): back off and retry unless attempts are exhausted.
    // A rate-limited run earns the longer schedule.
    const budget = rateLimited ? schedule.length : RECONNECT_BACKOFFS_MS.length;
    if (attempt >= budget) break;
    const delay = Math.round(schedule[attempt] * (1 + RECONNECT_JITTER * (2 * random() - 1)));
    log('warn', `[useTerminal] pty.reconnect ${ptyId} transient failure (${lastErr}) — retry ${attempt + 1}/${budget} after ${delay}ms`);
    await sleep(delay);
  }
  if (rateLimited) {
    // The daemon was shedding load, which says nothing about this session's
    // health. Keep the id, binding and scrollback (the pane stays attach-pending
    // behind the Retry banner, and the next daemon:connected reattaches) rather
    // than self-creating a fresh session over a live one.
    log('error', `[useTerminal] pty.reconnect ${ptyId} still rate limited after ${schedule.length} retries (${lastErr}) — keeping ptyId`);
    if (isCurrent()) deps.onRecoveryError?.('wmux is busy and could not reattach this terminal yet.', { rateLimited: true });
    return null;
  }
  // Exhausted all retries on transient failures. Clear as a last resort so the
  // surface doesn't keep a stale ptyId that silently never forwards input.
  log('error', `[useTerminal] pty.reconnect ${ptyId} still failing after ${RECONNECT_BACKOFFS_MS.length} retries (${lastErr}) — clearing ptyId`);
  if (isCurrent()) deps.clearPtyId(ptyId);
  return null;
}
