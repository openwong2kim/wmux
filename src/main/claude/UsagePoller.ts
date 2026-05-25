// Anthropic 5h/7d usage poller. Wraps loadClaudeCredential + fetchUsage
// behind a lifecycle the main process can start/stop/refresh on demand.
//
// Cadence: 1 hour default (matches `openwong2kim/claude-token-check`).
// Configurable via constructor injection so tests can run on millisecond
// scales. The poller is opt-in — the user must flip the Settings toggle
// before `start()` is called. While off, this module does ZERO disk
// reads and ZERO network requests.
//
// Failure handling:
//   - Credential not found (Claude Code not logged in) → emit
//     'token-missing' status, do not retry until `refreshNow()` is
//     called or the credential file is observed to appear (future
//     follow-up — for now manual refresh is the recovery).
//   - 401/403 (token expired or revoked) → emit 'unauthorized' status
//     and STOP the interval. User must re-login and toggle Settings
//     off/on (or click manual refresh).
//   - Network / 5xx → emit 'network-error' / 'http-error' with the
//     last error. The interval KEEPS RUNNING; next tick is the retry.
//     Avoids the failure mode where a transient outage permanently
//     darkens the StatusBar widget.
//
// Window visibility: `setWindowVisible(isVisible)` lets main hook the
// BrowserWindow `'show'` / `'hide'` events. When the window has been
// hidden ≥ 30 minutes, we skip the next poll tick to avoid burning the
// user's API quota for a UI nobody is looking at. The next `show`
// triggers an immediate catch-up fetch.

import { loadClaudeCredential, type LoadResult } from './claudeCredential';
import { fetchUsage, UsageApiException, type UsageSnapshot } from './UsageApi';

export type PollerStatus =
  /** Toggle is off; nothing happening. */
  | 'idle'
  /** Last fetch succeeded — `snapshot` is non-null. */
  | 'ok'
  /** Claude Code is not logged in / credential file missing. */
  | 'token-missing'
  /** Anthropic returned 401/403. Poller paused. */
  | 'unauthorized'
  /** Non-auth HTTP failure. Poller keeps running, retrying. */
  | 'http-error'
  /** Network failure. Poller keeps running, retrying. */
  | 'network-error'
  /** Local read error (credential file unreadable for non-ENOENT reason). */
  | 'read-error';

export interface PollerState {
  status: PollerStatus;
  /** Last successful snapshot. Persists across transient failures so the
   *  UI can keep rendering the last known good value with a stale
   *  indicator. Null until the first successful fetch in this session. */
  snapshot: UsageSnapshot | null;
  /** Last error message in human-readable form. Null when status is
   *  'idle' or 'ok'. We deliberately do NOT include the access token
   *  or any Bearer-shaped header in this string. */
  lastError: string | null;
  /** Subscription tier from `.credentials.json`. Surfaces to UI even
   *  when status is 'unauthorized' so the user remembers what plan they
   *  were on. */
  subscriptionType: string | null;
}

export interface PollerOptions {
  /** Interval between polls in ms. Default 1h. */
  intervalMs?: number;
  /** Skip a tick if the window has been hidden longer than this. Default 30 min. */
  hiddenSkipThresholdMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  loadCredential?: () => Promise<LoadResult>;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const THIRTY_MIN_MS = 30 * 60 * 1000;

/**
 * Owns a single in-process interval. The poller is created once and
 * started/stopped by the toggle. Multiple start() calls without stop()
 * are no-ops (idempotent). Disposal is final — call dispose() during
 * before-quit so the interval doesn't fire during shutdown.
 */
export class UsagePoller {
  private readonly intervalMs: number;
  private readonly hiddenSkipThresholdMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly loadCredential: () => Promise<LoadResult>;

  private state: PollerState = {
    status: 'idle',
    snapshot: null,
    lastError: null,
    subscriptionType: null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private immediateTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private windowVisible = true;
  private windowHiddenAtMs = 0;
  private disposed = false;

  private readonly listeners = new Set<(state: PollerState) => void>();

  constructor(opts: PollerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? ONE_HOUR_MS;
    this.hiddenSkipThresholdMs = opts.hiddenSkipThresholdMs ?? THIRTY_MIN_MS;
    this.now = opts.now ?? (() => Date.now());
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.loadCredential = opts.loadCredential ?? loadClaudeCredential;
  }

  /** Idempotent. Starts the interval AND triggers an immediate fetch
   *  so the first snapshot doesn't sit blank for an hour. */
  start(): void {
    if (this.disposed) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Immediate first fetch (deliberate: don't make the user wait for
    // the interval). `setTimeout(fn, 0)` rather than queueMicrotask so
    // tests can drive it via `vi.advanceTimersByTimeAsync(0)`. The
    // 0-delay also keeps it strictly asynchronous so a synchronous
    // start()-then-stop() pair still cancels cleanly via the timer
    // cleared above.
    this.immediateTimer = setTimeout(() => {
      this.immediateTimer = null;
      void this.tick();
    }, 0);
  }

  /** Stop the interval. State is preserved so the last snapshot keeps
   *  rendering until the next start() (or until the UI is told to
   *  hide). Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.immediateTimer) {
      clearTimeout(this.immediateTimer);
      this.immediateTimer = null;
    }
    if (this.state.status !== 'idle') {
      this.setState({ status: 'idle' });
    }
  }

  /** Manual refresh — the StatusBar widget's "refresh now" button. The
   *  caller is responsible for the 5-minute cooldown (kept in UI state).
   *  Returns the snapshot for callers that want to await the result. */
  async refreshNow(): Promise<PollerState> {
    if (this.disposed) return this.state;
    await this.tick();
    return this.state;
  }

  /** Hook window show/hide so we don't burn API calls while the user
   *  is away. Called from main/index.ts on BrowserWindow events. */
  setWindowVisible(isVisible: boolean): void {
    if (isVisible === this.windowVisible) return;
    this.windowVisible = isVisible;
    if (!isVisible) {
      this.windowHiddenAtMs = this.now();
    } else {
      this.windowHiddenAtMs = 0;
      // Window came back — kick a fresh fetch so the user doesn't wait
      // up to an hour for the next tick.
      if (this.timer && !this.disposed) {
        void this.tick();
      }
    }
  }

  /** Subscribe to state changes (StatusBar + Settings card). Multiple
   *  subscribers OK. Returns idempotent unsubscribe. */
  onStateChange(cb: (state: PollerState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getState(): PollerState {
    return this.state;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  /** Single poll iteration. Guarded against re-entry so a 1h interval
   *  tick can't overlap a slow in-flight fetch. */
  private async tick(): Promise<void> {
    if (this.disposed) return;
    if (this.inflight) return;
    // Hidden-window skip — only applies to interval-driven ticks, NOT
    // explicit refreshNow() or window-show kicks. Caller-driven probes
    // are always honored.
    if (!this.windowVisible && this.windowHiddenAtMs > 0) {
      const hiddenForMs = this.now() - this.windowHiddenAtMs;
      if (hiddenForMs >= this.hiddenSkipThresholdMs) {
        // Skip this tick; state unchanged.
        return;
      }
    }
    this.inflight = true;
    try {
      const credResult = await this.loadCredential();
      if (!credResult.ok) {
        if (credResult.reason === 'not-found') {
          this.setState({
            status: 'token-missing',
            lastError: null,
            subscriptionType: null,
          });
          return;
        }
        this.setState({
          status: 'read-error',
          lastError: credResult.detail ?? credResult.reason,
        });
        return;
      }
      const { credential } = credResult;
      try {
        const snapshot = await fetchUsage(credential.accessToken, this.fetchImpl);
        this.setState({
          status: 'ok',
          snapshot,
          lastError: null,
          subscriptionType: credential.subscriptionType,
        });
      } catch (err) {
        if (err instanceof UsageApiException) {
          if (err.detail.kind === 'unauthorized') {
            // STOP the interval — the credential is bad and pummeling
            // Anthropic with 401s helps nobody. User must re-login then
            // re-toggle.
            this.stop();
            this.setState({
              status: 'unauthorized',
              lastError: 'HTTP 401/403',
              subscriptionType: credential.subscriptionType,
            });
            return;
          }
          if (err.detail.kind === 'http') {
            this.setState({
              status: 'http-error',
              lastError: `HTTP ${err.detail.status} ${err.detail.statusText}`,
              subscriptionType: credential.subscriptionType,
            });
            return;
          }
          if (err.detail.kind === 'network') {
            this.setState({
              status: 'network-error',
              lastError: err.detail.message,
              subscriptionType: credential.subscriptionType,
            });
            return;
          }
          this.setState({
            status: 'http-error',
            lastError: err.message,
            subscriptionType: credential.subscriptionType,
          });
          return;
        }
        // Unknown error class — treat as network for retry semantics.
        const msg = err instanceof Error ? err.message : 'unknown';
        this.setState({
          status: 'network-error',
          lastError: msg,
          subscriptionType: credential.subscriptionType,
        });
      }
    } finally {
      this.inflight = false;
    }
  }

  private setState(patch: Partial<PollerState>): void {
    const next: PollerState = {
      ...this.state,
      ...patch,
    };
    // No-op when nothing observable changed (status + snapshot + error
    // are the dimensions the UI listens on; ignore deep equality on
    // snapshot since it's an immutable object replacement).
    if (
      next.status === this.state.status &&
      next.snapshot === this.state.snapshot &&
      next.lastError === this.state.lastError &&
      next.subscriptionType === this.state.subscriptionType
    ) {
      return;
    }
    this.state = next;
    for (const cb of this.listeners) {
      try {
        cb(next);
      } catch {
        // Swallow; one bad subscriber must not block siblings or the
        // poller's own state advance.
      }
    }
  }
}
