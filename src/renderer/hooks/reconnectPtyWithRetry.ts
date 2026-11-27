import type { DeadPaneRecovery } from '../../shared/ptyRecovery';
import type { ResumeBinding } from '../../shared/agentResume';

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
 * We retry transient failures with short backoff. Only a permanent answer
 * clears; exhausted retries keep the id unconfirmed (#2398). `isCurrent()`
 * lets the caller bail the moment the terminal unmounts so we never mutate
 * state for a torn-down view.
 */

export interface ReconnectResult {
  success: boolean;
  /**
   * #2398 — this reconnect started the session (promoted a suspended one),
   * also on a failed attach after the promote: the retry then attaches a
   * session that runs, and must still report that this attempt started it.
   */
  promoted?: boolean;
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
  /**
   * #2398 — asked without promote (the pane is hidden) and the session is
   * suspended: it stays suspended and the id is kept until the pane is shown.
   */
  deferred?: boolean;
  /** With `deferred`: the suspended session's agent resume binding, if it has one. */
  resumeAgent?: string;
  resumeBinding?: ResumeBinding;
  /** The session's stored PTY geometry, reported on success. */
  cols?: number;
  rows?: number;
  /** #3443 — on success: the folder the daemon could not recover the session in (gone), so it started in home. */
  lostCwd?: string;
}

/** Why an attempt settled without a session pipe; absent once it attached (except `promoted`). */
export interface ReconnectSettleInfo {
  /**
   * #2398 — this attempt started the session (it was suspended): attached, or
   * given up on after the start (rate limited, unconfirmed).
   */
  promoted?: boolean;
  cwdMissing?: boolean;
  rateLimited?: boolean;
  /** Retries ran out; the id is kept unconfirmed (#2398). */
  unconfirmed?: boolean;
  /** The daemon no longer has the id; a reconcile decides rebind or clear (#2398). */
  awaitingReconcile?: boolean;
  /** Suspended and not promoted while the pane is hidden (#2398); first show promotes. */
  deferred?: boolean;
  /** With `deferred`: what the session would resume (resume-on-start, #2398 §6-4). */
  resume?: { resumeAgent?: string; resumeBinding?: ResumeBinding };
}

export interface ReconnectDeps {
  /** Invoke the pty.reconnect RPC. */
  reconnect: (id: string) => Promise<ReconnectResult>;
  onRecoveryError?: (message: string | null, info?: ReconnectSettleInfo) => void;
  /** Clear the surface's ptyId so the next mount self-creates. */
  clearPtyId: (id: string, recovery?: DeadPaneRecovery) => void;
  /**
   * #2398 — record whether the binding is confirmed: true when the attempts
   * ran out without an answer (the id is kept), false once it attached.
   */
  setUnconfirmed?: (id: string, unconfirmed: boolean) => void;
  /**
   * #2398 — whether this binding is one kept unconfirmed (see setUnconfirmed)
   * that a reconcile can settle. The reconcile walks workspace surfaces only,
   * so a binding held elsewhere (the floating pane) must answer false, or it
   * would wait on passes that never look at it.
   */
  isUnconfirmed?: (id: string) => boolean;
  /**
   * #2398 — ask for a reconcile pass. Returns false when none can run (no
   * requester registered), and the caller then clears as before.
   */
  requestReconcile?: (reason: string) => boolean;
  /** #2398 — record whether the bound session was left suspended (deferred). */
  setDeferred?: (id: string, deferred: boolean) => void;
  /** #3443 — tell the pane once that its folder was gone and it started in home. */
  onLostCwd?: (id: string, folder: string) => void;
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
  // #2398 — any iteration of this attempt started the session.
  let started = false;
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
    if (result?.promoted) started = true;
    if (result?.success) {
      // A reconnect that settles after its terminal was replaced reports
      // nothing: its geometry must not resize the terminal current now.
      if (!isCurrent()) return null;
      deps.setUnconfirmed?.(ptyId, false);
      deps.setDeferred?.(ptyId, false);
      if (result.lostCwd) deps.onLostCwd?.(ptyId, result.lostCwd);
      if (started) deps.onRecoveryError?.(null, { promoted: true });
      else deps.onRecoveryError?.(null);
      return result.cols && result.rows ? { cols: result.cols, rows: result.rows } : null;
    }
    if (result?.recoveryPending) {
      if (isCurrent()) {
        deps.onRecoveryError?.(
          result.error || 'WSL recovery failed. Check the target and retry.',
          { cwdMissing: result.cwdMissing === true, ...(started ? { promoted: true } : {}) },
        );
      }
      return null; // Keep the original id, binding and scrollback. Retry is explicit.
    }
    if (result?.deferred) {
      // #2398 — a hidden pane's suspended session, left suspended on purpose:
      // an answer, not a failure. Keep the id, never enter the back-off, and
      // let the pane's first show reattach with promote.
      if (isCurrent()) {
        // The daemon holds it, so a binding kept unconfirmed is confirmed.
        deps.setUnconfirmed?.(ptyId, false);
        deps.setDeferred?.(ptyId, true);
        const resume = result.resumeAgent || result.resumeBinding
          ? { resume: { resumeAgent: result.resumeAgent, resumeBinding: result.resumeBinding } }
          : {};
        deps.onRecoveryError?.(null, { deferred: true, ...resume });
      }
      return null;
    }
    lastErr = result?.error ?? '<no error>';
    // #2398 — an unconfirmed binding was kept through a failed startup
    // reconcile, so no reconcile has looked at it yet. Its id may be gone while
    // the surface's session lives on under another id (a reboot recovery, a
    // reconnect after a respawn), which only the reconcile can rebind: it
    // matches the session's surface id, re-lists twice, and stages a dead
    // session's recovery. Clearing here instead self-created a second shell
    // for the surface — and, after a long daemon stall, a burst of them.
    // Hand the binding to the reconcile and keep it until that pass answers.
    if (result?.transient === false && deps.isUnconfirmed?.(ptyId)
      && deps.requestReconcile?.(`unconfirmed binding ${ptyId} reported gone`)) {
      log('warn', `[useTerminal] pty.reconnect ${ptyId} reports the session gone (${lastErr}) — unconfirmed binding, deferring to the reconcile`);
      if (isCurrent()) deps.onRecoveryError?.(null, { awaitingReconcile: true });
      return null;
    }
    // Permanent failure (daemon says the session is dead): clear now, no retry.
    if (result?.transient === false) {
      log('warn', `[useTerminal] pty.reconnect ${ptyId} permanent failure (${lastErr}) — clearing ptyId for self-create`);
      if (isCurrent()) {
        deps.setDeferred?.(ptyId, false);
        deps.clearPtyId(ptyId, result.recovery);
      }
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
    if (isCurrent()) {
      deps.setUnconfirmed?.(ptyId, true);
      deps.onRecoveryError?.('wmux is busy and could not reattach this terminal yet.', { rateLimited: true, ...(started ? { promoted: true } : {}) });
    }
    return null;
  }
  // #2398 — exhausted all retries on transient failures. None of them said the
  // session is gone, so keep the id, binding and scrollback (unconfirmed,
  // behind the Retry banner) exactly as the rate-limited branch does. Clearing
  // here self-created a fresh shell beside a session that was still alive.
  log('error', `[useTerminal] pty.reconnect ${ptyId} still failing after ${RECONNECT_BACKOFFS_MS.length} retries (${lastErr}) — keeping ptyId unconfirmed`);
  if (isCurrent()) {
    deps.setUnconfirmed?.(ptyId, true);
    deps.onRecoveryError?.('wmux could not reattach this terminal yet.', { unconfirmed: true, ...(started ? { promoted: true } : {}) });
  }
  return null;
}
