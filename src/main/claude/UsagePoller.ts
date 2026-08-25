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
//     and remember the token that was rejected. The interval KEEPS
//     RUNNING, on a shorter cadence, but a tick that reads back that
//     same rejected token returns before the network call — so we
//     never re-send a credential we already know is bad, and the
//     status clears by itself as soon as Claude Code writes a new one
//     (a re-login, or its own token refresh). That skip also expires
//     after `intervalMs`, so a 401 that was never about the token at
//     all still gets one retry per poll period — the same traffic a
//     healthy poller spends, and never more. Stopping the interval
//     outright was the old behaviour, and it left the widget reading
//     "Token expired" forever after a successful re-login (#1012).
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
  /** Anthropic returned 401/403. The poller keeps running, but it will
   *  not re-send the token that was refused until the credential on
   *  disk changes (or a whole poll interval has passed). */
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
  /** While a refusal is still fresh, re-read the credential this often
   *  instead of waiting out `intervalMs`. A recheck costs one
   *  credential read and sends nothing unless the token changed (or a
   *  whole `intervalMs` has passed since the refusal), so it can be
   *  far shorter than the poll interval. Clamped to `intervalMs`,
   *  since a recheck slower than the poll it stands in for would only
   *  lengthen the wrong-status window. Default 5 min.
   *
   *  "Fresh" is the pin's age, not anything about the displayed
   *  status: a credential that reads as missing for one tick during a
   *  re-login moves the status to 'token-missing' without giving up
   *  either the fast cadence or the skip, because that tick is
   *  precisely when recovery is landing. */
  unauthorizedRecheckMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  loadCredential?: () => Promise<LoadResult>;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const THIRTY_MIN_MS = 30 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

/**
 * Owns a single in-process interval. The poller is created once and
 * started/stopped by the toggle. Multiple start() calls without stop()
 * are no-ops (idempotent). Disposal is final — call dispose() during
 * before-quit so the interval doesn't fire during shutdown.
 */
export class UsagePoller {
  private readonly intervalMs: number;
  private readonly hiddenSkipThresholdMs: number;
  private readonly unauthorizedRecheckMs: number;
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
  /** Period the live interval was armed with, so `arm()` can tell a
   *  cadence change from a no-op re-arm. Null exactly when `timer` is. */
  private timerPeriodMs: number | null = null;
  private immediateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The access token Anthropic answered 401/403 for. A tick that reads
   *  this same token back off disk returns without spending a request.
   *  It deliberately outlives the 'unauthorized' chip: a credential read
   *  that fails mid-relogin moves the status on without making the token
   *  underneath any more sendable. Cleared by start(), by stop(), and by
   *  any tick that gets past the skip — never by a status change. */
  private rejectedAccessToken: string | null = null;
  /** When that answer came back. The skip above expires after
   *  `intervalMs`, so a 401 that was never about the token (an auth
   *  outage, an org policy since reverted) still gets one retry per
   *  normal poll period — never more traffic than a healthy poller. */
  private rejectedAtMs = 0;
  private inflight = false;
  /** The run currently in flight, so a tick that must not be dropped
   *  can wait the slot out instead of returning. */
  private inflightRun: Promise<void> | null = null;
  /** The generation that run belongs to. A tick only stands down for a
   *  pass from its own session; one left behind by a stopped session is
   *  going to abandon its result anyway. */
  private inflightGeneration = -1;
  /** Bumped by every start(), stop() and dispose(). A tick captures it
   *  on entry and abandons its result if the session it belonged to
   *  ended while it was awaiting. Without it a fetch can outlive its
   *  own poller: repainting a status the toggle already turned off, or
   *  sending a credential the recheck deliberately withholds. */
  private generation = 0;
  private windowVisible = true;
  private windowHiddenAtMs = 0;
  private disposed = false;

  private readonly listeners = new Set<(state: PollerState) => void>();

  constructor(opts: PollerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? ONE_HOUR_MS;
    this.hiddenSkipThresholdMs = opts.hiddenSkipThresholdMs ?? THIRTY_MIN_MS;
    // Never slower than the poll it replaces: the recheck exists to
    // shorten the time a wrong "Token expired" stays on screen, and a
    // caller with a sub-5-minute interval would otherwise have that
    // window stretched by hitting an unauthorized state.
    this.unauthorizedRecheckMs = Math.min(
      this.intervalMs,
      opts.unauthorizedRecheckMs ?? FIVE_MIN_MS,
    );
    this.now = opts.now ?? (() => Date.now());
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.loadCredential = opts.loadCredential ?? loadClaudeCredential;
  }

  /** Idempotent. Starts the interval AND triggers an immediate fetch
   *  so the first snapshot doesn't sit blank for an hour. */
  start(): void {
    if (this.disposed) return;
    if (this.timer) return;
    // A fresh session re-verifies from scratch. A refreshNow() taken
    // while the toggle was off can leave a verdict behind that stop()
    // never saw, and it must not silence the first tick of the next
    // session.
    this.generation += 1;
    this.clearRejection();
    this.arm(this.intervalMs);
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
      this.timerPeriodMs = null;
    }
    if (this.immediateTimer) {
      clearTimeout(this.immediateTimer);
      this.immediateTimer = null;
    }
    // The toggle went off, so nothing is left to withhold a token from.
    // The bump makes that true even against a tick still awaiting: its
    // result is abandoned rather than landing after this line, and a
    // waiter queued on it stands down instead of taking the slot.
    this.generation += 1;
    this.clearRejection();
    if (this.state.status !== 'idle') {
      this.setState({ status: 'idle' });
    }
  }

  /** Single owner of the interval, so the cadence can change (normal
   *  poll ↔ unauthorized recheck) without leaking a timer. Re-arming
   *  at the period already running is a no-op, which keeps a tick from
   *  pushing its own next tick further away on every pass. */
  private arm(periodMs: number): void {
    if (this.disposed) return;
    if (this.timer && this.timerPeriodMs === periodMs) return;
    if (this.timer) clearInterval(this.timer);
    this.timerPeriodMs = periodMs;
    this.timer = setInterval(() => {
      void this.tick();
    }, periodMs);
  }

  /** Manual refresh — the StatusBar widget's "refresh now" button. The
   *  caller is responsible for the 5-minute cooldown (kept in UI state).
   *  Returns the snapshot for callers that want to await the result. */
  async refreshNow(): Promise<PollerState> {
    if (this.disposed) return this.state;
    // `force`: the user asked for this one by hand, so it outranks both
    // the hidden-window skip and the "same token already 401'd" skip.
    // Re-sending a known-bad token is wasteful on a timer and correct
    // on a button — the user may have just fixed something we cannot
    // see from the credential alone.
    await this.tick({ force: true });
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
  private async tick(opts: { force?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    // Captured before the wait below, never after it. A tick belongs to
    // the session that scheduled it; adopting whatever session happens
    // to be current when a slot finally opens is how a tick queued
    // before stop() ends up reading the credential and sending a
    // request after the meter was switched off, and painting a status
    // no live timer is left to correct.
    const generation = this.generation;
    if (this.inflight) {
      // Yield to a peer, never to a corpse. An ordinary interval tick
      // steps aside for a pass from its own session, because that pass
      // is about to produce the same answer. It must NOT step aside for
      // one left over from a session that has since been stopped: that
      // pass will abandon its own result at the first `isStale` check,
      // so yielding to it means a toggle off and back on during a slow
      // read costs the new session its opening fetch, and the widget
      // then waits out a whole poll interval with nothing in it.
      //
      // A forced tick never steps aside at all. The pass in flight may
      // have taken the unauthorized skip below and sent nothing, and
      // the button the user just pressed would then have done nothing.
      const peerIsCurrent = this.inflightGeneration === generation;
      if (!opts.force && peerIsCurrent) return;
      // Loop rather than return: several waiters can be queued on the
      // same run, and each forced one has to get its own pass instead
      // of the first waiter's arrival becoming the reason to drop the
      // rest.
      while (this.inflight) {
        const run = this.inflightRun;
        if (!run) break;
        try {
          await run;
        } catch {
          // That pass's failure is its own; we only waited for the slot.
        }
        if (this.isStale(generation)) return;
      }
      if (this.isStale(generation)) return;
      // Ordinary ticks coalesce. Only a stale peer sent one in here, and
      // if the slot has since been used by a pass belonging to this
      // session, that pass already produced the answer this tick was
      // going to ask for — several interval firings queued behind one
      // slow read must not turn into that many requests when it lands.
      // A forced tick is exempt: each click is its own question.
      if (!opts.force && this.inflightGeneration === generation) return;
    }
    // Hidden-window skip — only applies to interval-driven ticks, NOT
    // explicit refreshNow() or window-show kicks. Caller-driven probes
    // are always honored.
    if (!opts.force && !this.windowVisible && this.windowHiddenAtMs > 0) {
      const hiddenForMs = this.now() - this.windowHiddenAtMs;
      if (hiddenForMs >= this.hiddenSkipThresholdMs) {
        // Skip this tick; state unchanged. The cadence still ages,
        // though: without this the recheck period outlives the pin's
        // freshness window for as long as the window stays hidden,
        // because the finally below is the only other place that
        // re-arms and this return never reaches it.
        this.syncCadence(generation);
        return;
      }
    }
    this.inflight = true;
    this.inflightGeneration = generation;
    const run = this.runTick(opts, generation);
    this.inflightRun = run;
    try {
      await run;
    } finally {
      this.inflight = false;
      this.inflightRun = null;
      // One place decides the cadence, after the outcome is known and
      // only for a session that is still the current one.
      this.syncCadence(generation);
    }
  }

  /** The work of one tick. Split from `tick()` so the re-entry guard,
   *  the in-flight handle and the cadence update have a single owner. */
  private async runTick(opts: { force?: boolean }, generation: number): Promise<void> {
    const credResult = await this.loadCredential();
    if (this.isStale(generation)) return;
    if (!credResult.ok) {
      // Deliberately keeps any rejected-token pin. A credential that
      // reads as missing for one tick is exactly what a re-login looks
      // like mid-write, and dropping the pin here would drop the fast
      // recheck cadence with it — stranding the new token for a whole
      // poll interval at the precise moment recovery was arriving. It
      // would also release the skip below on the tick after that, since
      // the credential coming back unchanged is not a reason to re-send
      // it.
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
    if (
      !opts.force &&
      this.rejectedAccessToken === credential.accessToken &&
      this.now() - this.rejectedAtMs < this.intervalMs
    ) {
      // The same token Anthropic already refused, asked about less than
      // a normal poll period ago. Nothing on disk has changed, so the
      // answer would almost certainly be the same 401 — leave the state
      // as it is and spend no request. The next tick re-reads the
      // credential, which is the whole point of staying armed.
      //
      // Two bounds, because a 401 has two possible causes:
      //   - the token really is bad → the credential has to change
      //     before any request could succeed, and the recheck cadence
      //     notices that within minutes, for free;
      //   - the token was fine and the refusal was not about it (an
      //     auth-service blip, an org policy since reverted) → no
      //     credential will ever change, so the `intervalMs` bound is
      //     what eventually retries. One request per poll period is
      //     exactly what a healthy poller spends, so this can never
      //     cost more traffic than success does.
      //
      // Those two are the whole rule, deliberately: the pin plus its
      // age, and nothing about what the chip currently reads. Keying on
      // the displayed status as well looked safer and was not — a read
      // that fails once moves the status off 'unauthorized' while the
      // credential underneath is unchanged, and the skip would then
      // release early and re-send the token it exists to withhold.
      // Nor does the pin strand any other status: every one of them
      // recovers by way of a *different* credential, and a different
      // token fails this comparison on the first tick that reads it.
      return;
    }
    // Past the skip, so whatever the pin was pointing at is no longer
    // the operative credential.
    this.clearRejection();
    try {
      const snapshot = await fetchUsage(credential.accessToken, this.fetchImpl);
      if (this.isStale(generation)) return;
      this.setState({
        status: 'ok',
        snapshot,
        lastError: null,
        subscriptionType: credential.subscriptionType,
      });
    } catch (err) {
      if (this.isStale(generation)) return;
      if (err instanceof UsageApiException) {
        if (err.detail.kind === 'unauthorized') {
          // Do NOT stop the interval — that used to strand the widget
          // on "Token expired" until the user found the Settings
          // toggle (#1012). Instead pin the token that was refused;
          // `syncCadence` then switches to the recheck period, every
          // tick re-reads the credential, and the guard above keeps
          // this same bad token off the network. The moment Claude
          // Code writes a different token, the next tick fetches with
          // it and the status clears on its own.
          this.rejectedAccessToken = credential.accessToken;
          this.rejectedAtMs = this.now();
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
  }

  /** True when the session this tick belonged to has since been stopped,
   *  restarted or disposed. Every await in `runTick` is followed by this
   *  check, so a fetch that outlives its own poller can neither repaint a
   *  status the toggle already turned off nor pin a token for a session
   *  that no longer exists. */
  private isStale(generation: number): boolean {
    return this.disposed || this.generation !== generation;
  }

  /** Drop the "this token is bad" verdict. The cadence is not touched
   *  here — `syncCadence` derives it from the pin at the end of the
   *  tick, so there is only one place that can change the interval. */
  private clearRejection(): void {
    this.rejectedAccessToken = null;
    this.rejectedAtMs = 0;
  }

  /** The period the interval should be running at right now: fast while
   *  a refusal is fresh, the ordinary poll otherwise. The fast window is
   *  bounded by the same `intervalMs` that releases the skip, so it can
   *  never outlive the evidence for it — and if the retry that ends it
   *  is refused again, that re-pins and opens the next window. */
  private cadenceMs(): number {
    const pinned =
      this.rejectedAccessToken !== null &&
      this.now() - this.rejectedAtMs < this.intervalMs;
    return pinned ? this.unauthorizedRecheckMs : this.intervalMs;
  }

  /** Re-arm to the period the current state calls for. Skipped when the
   *  session that ran the tick is gone, so a late tick cannot resurrect
   *  a timer or override the cadence a fresh `start()` just chose. */
  private syncCadence(generation: number): void {
    if (this.isStale(generation)) return;
    if (!this.timer) return;
    this.arm(this.cadenceMs());
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
