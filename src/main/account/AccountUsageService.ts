// ─── M2 — Per-account usage service (opt-in) ─────────────────────────────────
//
// Displays 5h/7d Anthropic usage per REGISTERED claude account. Two automatic
// triggers: the `agent.stop` HookSignalRouter event for the pane's resolved
// account (exactly when the number just changed), and a 15-min refresh of
// every account, staggered so they don't all fire at once — so an account
// whose panes sit idle still shows current numbers.
//
// Cost contract: a probe is a read of the OAuth usage endpoint (no model
// request, no quota spent), but it is still network traffic on the user's
// behalf, so:
//   - Automatic probes (maybeProbe, driven by agent.stop and the refresh
//     timer) are gated on the opt-in `enabled` flag, a per-account cooldown,
//     an in-flight coalesce guard, a per-account 429 backoff, AND the
//     hidden-window skip. Feature OFF ⇒ ZERO traffic, no timer.
//   - Manual probes (refreshNow, the Settings ↻ button) are an EXPLICIT user
//     action, so they bypass enabled/cooldown/hidden — but still coalesce on
//     the in-flight guard so a double-click can't double-spend.
//
// wmux never stores the token: we read it for the account's config dir via
// `loadClaudeCredential(configDir)` and hand it straight to `fetchUsage`, which
// never logs it. Where no per-account credential can be read, the entry shows
// 'token-missing' / 'error' from that call's result.
//
// ASCII flow:
//
//   agent.stop (claude, pane bound to account B)
//        │  hooks.rpc → onClaudeTurnEnd(workspaceId)
//        ▼
//   getBinding(ws,'claude') → accountId B
//        ▼
//   maybeProbe(B): enabled? visible? not in cooldown? not in-flight?
//        │  yes → loadClaudeCredential(B.configDir) → fetchUsage(token)
//        ▼
//   cache[B] = { status:'ok', snapshot, fetchedAtMs }  → onChange → renderer

import { loadClaudeCredential, type LoadResult } from '../claude/claudeCredential';
import { fetchUsage, rateLimitBackoffMs, UsageApiException, type UsageSnapshot } from '../claude/UsageApi';
import { getAccountStore } from './accountStore';
import { mergeLive, type UsageUpdate } from '../claude/usageMerge';

export type AccountUsageStatus =
  /** Last probe succeeded — `snapshot` is fresh. */
  | 'ok'
  /** No credential in the account's config dir (not logged in). */
  | 'token-missing'
  /** Anthropic returned 401/403 for this account's token. */
  | 'unauthorized'
  /** Network / HTTP / local read error. Last-known snapshot (if any) is kept. */
  | 'error';

/** One account's usage state. IPC-friendly (plain values only). */
export interface AccountUsageEntry {
  accountId: string;
  status: AccountUsageStatus;
  /** Last successful snapshot; persists across transient failures so the UI can
   *  keep rendering the last-known value with a stale age. Null until first ok. */
  snapshot: UsageSnapshot | null;
  /** When this entry was last written (Unix ms). Null before the first probe. */
  fetchedAtMs: number | null;
  /** Human-readable last error; null when status is 'ok'. Never token-bearing. */
  lastError: string | null;
}

/** Default per-account cooldown between AUTOMATIC probes. 5 min mirrors
 *  claude-swap's anti-flip-flop cadence and keeps API traffic flat no matter how
 *  chatty an account's panes are. */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
/** Refresh-all cadence while the feature is on. */
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
/** With a fresh live sample, HTTP still runs every this-many refresh intervals. */
const LIVE_HTTP_EVERY_PASSES = 3;
/** Gap between consecutive accounts within one refresh-all pass. */
const DEFAULT_STAGGER_MS = 10 * 1000;

export interface AccountUsageDeps {
  now?: () => number;
  cooldownMs?: number;
  /** Refresh-all interval. Default 15 min. */
  refreshIntervalMs?: number;
  /** Delay between accounts within one refresh-all pass. Default 10 s. */
  staggerMs?: number;
  fetchImpl?: typeof fetch;
  loadCredential?: (configDir: string) => Promise<LoadResult>;
  /** Resolve an accountId → its claude config dir, or null if it's not a
   *  registered claude account. Injected for tests; default reads the store. */
  getConfigDir?: (accountId: string) => string | null;
  /** Set of currently-registered account ids, used to prune stale cache entries
   *  (test 12: no leak over a long daemon lifetime). Default reads the store. */
  listKnownIds?: () => Set<string>;
}

export class AccountUsageService {
  private enabled = false;
  private windowVisible = true;
  private readonly cache = new Map<string, AccountUsageEntry>();
  /** Accounts with a probe in flight — coalesces a burst of agent.stop across
   *  panes sharing one account into a single request. */
  private readonly inflight = new Set<string>();
  /** The promise of each in-flight probe, so a launch can wait on it. */
  private readonly inflightProbes = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(entry: AccountUsageEntry) => void>();
  /** Per-account 429 backoff: automatic probes before `untilMs` are skipped. */
  private readonly rateLimited = new Map<string, { untilMs: number; count: number }>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly staggerTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Per-account time of the last accepted live statusline sample. While
   *  younger than the refresh interval, automatic probes slow down. */
  private readonly liveAtMs = new Map<string, number>();
  /** Per-account time of the last probe (credential read + HTTP request);
   *  drives the cooldown. Even with a fresh live
   *  sample, one goes out every LIVE_HTTP_EVERY_PASSES refresh intervals so
   *  scoped limits and the credential status stay current. */
  private readonly httpAtMs = new Map<string, number>();

  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly refreshIntervalMs: number;
  private readonly staggerMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly loadCredential: (configDir: string) => Promise<LoadResult>;
  private readonly getConfigDir: (accountId: string) => string | null;
  private readonly listKnownIds: () => Set<string>;

  constructor(deps: AccountUsageDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.refreshIntervalMs = deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.staggerMs = deps.staggerMs ?? DEFAULT_STAGGER_MS;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.loadCredential = deps.loadCredential ?? loadClaudeCredential;
    this.getConfigDir = deps.getConfigDir ?? ((accountId) => {
      const acc = getAccountStore().getAccount(accountId);
      // Codex has no public usage API — only claude accounts probe.
      return acc && acc.vendor === 'claude' ? acc.configDir : null;
    });
    this.listKnownIds = deps.listKnownIds ?? (() =>
      new Set(getAccountStore().listAccounts().map((a) => a.id)));
  }

  /** Opt-in toggle. Turning ON starts the refresh-all timer with an immediate
   *  staggered pass. Turning OFF keeps the cache (so the last-known values still
   *  render) but stops the timer and all AUTOMATIC probing — the "zero traffic
   *  while off" contract. Manual refreshNow still works (explicit user action). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.startRefreshTimer();
    else this.stopRefreshTimer();
  }

  /** Stop all timers. Called on app quit. */
  dispose(): void {
    this.enabled = false;
    this.stopRefreshTimer();
    this.listeners.clear();
  }

  private startRefreshTimer(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => this.scheduleRefreshAll(), this.refreshIntervalMs);
    this.scheduleRefreshAll();
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const t of this.staggerTimers) clearTimeout(t);
    this.staggerTimers.clear();
  }

  /** One refresh-all pass: every registered claude account gets an automatic
   *  (gated) probe, `staggerMs` apart so the requests don't burst. A pass still
   *  staggering when the next begins is replaced, never stacked. */
  private scheduleRefreshAll(): void {
    for (const t of this.staggerTimers) clearTimeout(t);
    this.staggerTimers.clear();
    const ids = [...this.listKnownIds()].filter((id) => this.getConfigDir(id) !== null);
    ids.forEach((id, i) => {
      const t = setTimeout(() => {
        this.staggerTimers.delete(t);
        void this.maybeProbe(id);
      }, (i + 1) * this.staggerMs);
      this.staggerTimers.add(t);
    });
  }

  /** Hooked to BrowserWindow show/hide so automatic probes don't burn quota for
   *  a dashboard nobody is looking at. Manual refresh is unaffected. */
  setWindowVisible(visible: boolean): void {
    const cameBack = visible && !this.windowVisible;
    this.windowVisible = visible;
    // Hidden → visible while on: one catch-up pass, so numbers that aged while
    // nobody looked refresh now instead of at the next interval. The usual
    // cooldown / backoff gates still apply per account.
    if (cameBack && this.enabled && this.refreshTimer) this.scheduleRefreshAll();
  }

  onChange(cb: (entry: AccountUsageEntry) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Snapshot for the Settings panel's initial pull. Prunes entries whose
   *  account is no longer registered so a long-lived daemon can't leak them. */
  getAll(): AccountUsageEntry[] {
    const known = this.listKnownIds();
    for (const id of [...this.cache.keys()]) {
      if (!known.has(id)) this.cache.delete(id);
    }
    return [...this.cache.values()];
  }

  /** Drop one account's cached usage (called when an account is unregistered). */
  drop(accountId: string): void {
    this.cache.delete(accountId);
    this.rateLimited.delete(accountId);
    this.liveAtMs.delete(accountId);
    this.httpAtMs.delete(accountId);
  }

  /**
   * Live `rate_limits` from a Claude Code statusline running on this account
   * (`usage.rateLimits`, account resolved from the pane's CLAUDE_CONFIG_DIR).
   * Merged by reset time, so a stale sample never overwrites a newer window.
   * Stored even while the feature is off; listeners hear about it only while
   * it is on (the Settings list still pulls it via getAll()).
   */
  ingestLive(accountId: string, update: UsageUpdate): boolean {
    const prev = this.cache.get(accountId);
    const merged = mergeLive(prev?.snapshot ?? null, update, this.now());
    if (!merged) return false;
    this.liveAtMs.set(accountId, this.now());
    if (merged === prev?.snapshot) return true;
    // A credential verdict (token missing / refused) is HTTP's to clear; the
    // live numbers still show underneath it.
    const keepStatus = prev?.status === 'unauthorized' || prev?.status === 'token-missing';
    this.set(accountId, {
      status: keepStatus && prev ? prev.status : 'ok',
      snapshot: merged,
      lastError: keepStatus && prev ? prev.lastError : null,
    }, this.enabled);
    return true;
  }

  /**
   * AUTOMATIC probe from the agent.stop path. No-ops unless the feature is on,
   * the window is visible, the account isn't in cooldown, and no probe is
   * already in flight for it. This is the whole cost-control story.
   */
  async maybeProbe(accountId: string): Promise<void> {
    if (!this.enabled) return;                 // opt-in: zero traffic while off
    if (!this.windowVisible) return;           // hidden-window skip
    if (this.inflight.has(accountId)) return;  // coalesce a burst → one probe
    const backoff = this.rateLimited.get(accountId);
    if (backoff && this.now() < backoff.untilMs) return; // 429 backoff
    // Keyed on the last probe, not the entry's fetchedAtMs: a live sample
    // stamps the entry too, and must not hold HTTP off indefinitely.
    const lastProbe = this.httpAtMs.get(accountId);
    if (lastProbe !== undefined && this.now() - lastProbe < this.cooldownMs) {
      return;                                  // still fresh — don't re-spend
    }
    const liveAt = this.liveAtMs.get(accountId);
    if (
      liveAt !== undefined && this.now() - liveAt < this.refreshIntervalMs
      && this.now() - (this.httpAtMs.get(accountId) ?? 0) < LIVE_HTTP_EVERY_PASSES * this.refreshIntervalMs
    ) {
      return;                                  // a live statusline is feeding it
    }
    await this.startProbe(accountId, true);
  }

  /**
   * MANUAL probe from the Settings ↻ button. An explicit user action, so it
   * bypasses the enabled/cooldown/hidden gates — but still coalesces on the
   * in-flight guard so a double-click can't fire two requests.
   */
  async refreshNow(accountId: string): Promise<void> {
    if (this.inflight.has(accountId)) return;
    await this.startProbe(accountId, false);
  }

  /**
   * Refresh ahead of a quota-rotated launch. Waits for a probe already in
   * flight instead of returning before it lands, and leaves an account in 429
   * backoff or inside the probe cooldown alone (its cached entry stands).
   */
  async refreshForLaunch(accountId: string): Promise<void> {
    const running = this.inflightProbes.get(accountId);
    if (running) return running;
    const backoff = this.rateLimited.get(accountId);
    if (backoff && this.now() < backoff.untilMs) return;
    const lastProbe = this.httpAtMs.get(accountId);
    if (lastProbe !== undefined && this.now() - lastProbe < this.cooldownMs) return;
    await this.startProbe(accountId, false);
  }

  private startProbe(accountId: string, automatic: boolean): Promise<void> {
    const p = this.probe(accountId, automatic).finally(() => {
      if (this.inflightProbes.get(accountId) === p) this.inflightProbes.delete(accountId);
    });
    this.inflightProbes.set(accountId, p);
    return p;
  }

  /** The actual read-token → fetch-usage → update-cache work. Shared by
   *  maybeProbe (gated, `automatic`) and refreshNow (ungated). Never throws. */
  private async probe(accountId: string, automatic: boolean): Promise<void> {
    const configDir = this.getConfigDir(accountId);
    if (!configDir) return; // unknown / non-claude account — nothing to probe
    this.inflight.add(accountId);
    try {
      const cred = await this.loadCredential(configDir);
      // The toggle may have gone off while the credential was being read.
      if (automatic && !this.enabled) return;
      // A platform that can't read per-account credentials is not an account
      // fault: an automatic pass leaves the entry as it was instead of
      // painting it red. A manual refresh still surfaces the reason.
      if (automatic && !cred.ok && cred.reason === 'unsupported-platform') return;
      this.httpAtMs.set(accountId, this.now());
      if (!cred.ok) {
        this.set(accountId, {
          status: cred.reason === 'not-found' ? 'token-missing' : 'error',
          snapshot: this.currentSnapshot(accountId),
          lastError: cred.reason === 'not-found' ? null : (cred.detail ?? cred.reason),
        });
        return;
      }
      try {
        // HTTP is authoritative: it replaces whatever live samples built up.
        const snapshot = await fetchUsage(cred.credential.accessToken, this.fetchImpl);
        this.rateLimited.delete(accountId);
        this.set(accountId, { status: 'ok', snapshot, lastError: null });
      } catch (err) {
        if (err instanceof UsageApiException && err.detail.kind === 'unauthorized') {
          // Bad/expired token. Surface it, keep the last-known snapshot, and do
          // NOT retry-storm: the cooldown + inflight guard already bound retries,
          // and automatic probes won't re-fire until the next agent.stop or
          // refresh pass past the cooldown.
          this.set(accountId, {
            status: 'unauthorized',
            snapshot: this.currentSnapshot(accountId),
            lastError: 'HTTP 401/403',
          });
        } else if (err instanceof UsageApiException && err.detail.kind === 'rate-limited') {
          const count = (this.rateLimited.get(accountId)?.count ?? 0) + 1;
          this.rateLimited.set(accountId, {
            count,
            untilMs: this.now() + rateLimitBackoffMs(count, err.detail.retryAfterMs),
          });
          this.set(accountId, {
            status: 'error',
            snapshot: this.currentSnapshot(accountId),
            lastError: 'HTTP 429 rate limited',
          });
        } else {
          const msg = err instanceof Error ? err.message : 'unknown';
          this.set(accountId, {
            status: 'error',
            snapshot: this.currentSnapshot(accountId),
            lastError: msg,
          });
        }
      }
    } finally {
      this.inflight.delete(accountId);
    }
  }

  /** The cached snapshot as of NOW. Failure paths use this rather than the
   *  entry read before the awaits: a live sample may have landed meanwhile. */
  private currentSnapshot(accountId: string): UsageSnapshot | null {
    return this.cache.get(accountId)?.snapshot ?? null;
  }

  private set(
    accountId: string,
    patch: Omit<AccountUsageEntry, 'accountId' | 'fetchedAtMs'>,
    notify = true,
  ): void {
    const entry: AccountUsageEntry = { accountId, fetchedAtMs: this.now(), ...patch };
    this.cache.set(accountId, entry);
    if (!notify) return;
    for (const cb of this.listeners) {
      try { cb(entry); } catch { /* one bad subscriber must not block siblings */ }
    }
  }
}
