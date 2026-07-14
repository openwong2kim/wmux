// ─── M2 — Per-account usage service (hook-gated, opt-in) ─────────────────────
//
// Displays 5h/7d Anthropic usage per REGISTERED claude account. Decided in
// eng-review 2026-07-14: the probe is HOOK-GATED, not a timer. It fires on the
// `agent.stop` HookSignalRouter event for the pane's resolved account — exactly
// when the number just changed — instead of polling idle panes on a clock.
//
// Cost contract (plan §3): each probe is a real 1-token request against that
// account's quota, so:
//   - Automatic probes (maybeProbe, driven by agent.stop) are gated on the
//     opt-in `enabled` flag, a per-account cooldown, an in-flight coalesce
//     guard, AND the hidden-window skip. Feature OFF ⇒ ZERO traffic.
//   - Manual probes (refreshNow, the Settings ↻ button) are an EXPLICIT user
//     action, so they bypass enabled/cooldown/hidden — but still coalesce on
//     the in-flight guard so a double-click can't double-spend.
//
// wmux never stores the token: we read it from the account's config dir via
// `loadClaudeCredential(configDir)` (Win/Linux only; macOS keychain can't
// partition per dir) and hand it straight to `fetchUsage`, which never logs it.
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
import { fetchUsage, UsageApiException, type UsageSnapshot } from '../claude/UsageApi';
import { getAccountStore } from './accountStore';

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

export interface AccountUsageDeps {
  now?: () => number;
  cooldownMs?: number;
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
  private readonly listeners = new Set<(entry: AccountUsageEntry) => void>();

  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly loadCredential: (configDir: string) => Promise<LoadResult>;
  private readonly getConfigDir: (accountId: string) => string | null;
  private readonly listKnownIds: () => Set<string>;

  constructor(deps: AccountUsageDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
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

  /** Opt-in toggle. Turning OFF keeps the cache (so the last-known values still
   *  render) but stops all AUTOMATIC probing — the "zero traffic while off"
   *  contract. Manual refreshNow still works (explicit user action). */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Hooked to BrowserWindow show/hide so automatic probes don't burn quota for
   *  a dashboard nobody is looking at. Manual refresh is unaffected. */
  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible;
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
    const prev = this.cache.get(accountId);
    if (prev?.fetchedAtMs != null && this.now() - prev.fetchedAtMs < this.cooldownMs) {
      return;                                  // still fresh — don't re-spend
    }
    await this.probe(accountId);
  }

  /**
   * MANUAL probe from the Settings ↻ button. An explicit user action, so it
   * bypasses the enabled/cooldown/hidden gates — but still coalesces on the
   * in-flight guard so a double-click can't fire two requests.
   */
  async refreshNow(accountId: string): Promise<void> {
    if (this.inflight.has(accountId)) return;
    await this.probe(accountId);
  }

  /** The actual read-token → fetch-usage → update-cache work. Shared by
   *  maybeProbe (gated) and refreshNow (ungated). Never throws. */
  private async probe(accountId: string): Promise<void> {
    const configDir = this.getConfigDir(accountId);
    if (!configDir) return; // unknown / non-claude account — nothing to probe
    const prev = this.cache.get(accountId);
    this.inflight.add(accountId);
    try {
      const cred = await this.loadCredential(configDir);
      if (!cred.ok) {
        this.set(accountId, {
          status: cred.reason === 'not-found' ? 'token-missing' : 'error',
          snapshot: prev?.snapshot ?? null,
          lastError: cred.reason === 'not-found' ? null : (cred.detail ?? cred.reason),
        });
        return;
      }
      try {
        const snapshot = await fetchUsage(cred.credential.accessToken, this.fetchImpl);
        this.set(accountId, { status: 'ok', snapshot, lastError: null });
      } catch (err) {
        if (err instanceof UsageApiException && err.detail.kind === 'unauthorized') {
          // Bad/expired token. Surface it, keep the last-known snapshot, and do
          // NOT retry-storm: the cooldown + inflight guard already bound retries,
          // and automatic probes won't re-fire until the next agent.stop past
          // the cooldown.
          this.set(accountId, {
            status: 'unauthorized',
            snapshot: prev?.snapshot ?? null,
            lastError: 'HTTP 401/403',
          });
        } else {
          const msg = err instanceof Error ? err.message : 'unknown';
          this.set(accountId, {
            status: 'error',
            snapshot: prev?.snapshot ?? null,
            lastError: msg,
          });
        }
      }
    } finally {
      this.inflight.delete(accountId);
    }
  }

  private set(accountId: string, patch: Omit<AccountUsageEntry, 'accountId' | 'fetchedAtMs'>): void {
    const entry: AccountUsageEntry = { accountId, fetchedAtMs: this.now(), ...patch };
    this.cache.set(accountId, entry);
    for (const cb of this.listeners) {
      try { cb(entry); } catch { /* one bad subscriber must not block siblings */ }
    }
  }
}
