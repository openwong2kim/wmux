/**
 * Read-only Codex account status for the phone (docs/phone-client-contract.md,
 * "Proposed: contract v-next", item 2). CONTRACT ONLY: no route serves it yet.
 *
 * Source: two requests on a short-lived connection to the pane's Codex account
 * server, `getAuthStatus {includeToken:false, refreshToken:false}` and
 * `account/rateLimits/read {excludeResetCreditDetails:true}`. The projections
 * below are allowlists: the auth token, e-mail, credit balance, backend banner
 * and account id never leave the daemon.
 */

export type CodexAuthState = 'signed-in' | 'signed-out' | 'unknown';
export type CodexAuthMethod = 'chatgpt' | 'apikey' | 'other';

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  /** Epoch ms (converted from the server's seconds), or null. */
  resetsAt: number | null;
}

export interface CodexRateLimitBucket {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  /** Server's `rateLimitReachedType`, verbatim (open set), or null. */
  reachedType: string | null;
}

export interface CodexAccountStatus {
  auth: { state: CodexAuthState; method?: CodexAuthMethod };
  /** null when the rate-limit read failed or the account has none (API key). */
  rateLimits: null | {
    /** Server's own verdict; null = unavailable. Never infer it from percentages. */
    ordinaryUsageAllowed: boolean | null;
    planType: string | null;
    buckets: CodexRateLimitBucket[];
  };
  /** Epoch ms of the upstream read this answer came from. */
  fetchedAt: number;
  /** True when served from the per-account cache. */
  cached: boolean;
}

/** Per-account cache lifetime for upstream reads. */
export const CODEX_ACCOUNT_STATUS_TTL_MS = 60_000;
const MAX_BUCKETS = 8;
const SHORT = /^[A-Za-z0-9_.:-]{1,64}$/;

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const short = (v: unknown): string | null => typeof v === 'string' && SHORT.test(v) ? v : null;

/** `getAuthStatus` result → auth. `authToken` is never read. */
export function projectCodexAuth(result: unknown): CodexAccountStatus['auth'] {
  const r = obj(result);
  if (!r) return { state: 'unknown' };
  const mode = r.authMethod;
  if (mode === null) return { state: 'signed-out' };
  if (typeof mode !== 'string') return { state: 'unknown' };
  const method: CodexAuthMethod = mode === 'chatgpt' || mode === 'chatgptAuthTokens' ? 'chatgpt'
    : mode === 'apikey' ? 'apikey' : 'other';
  return { state: 'signed-in', method };
}

function projectWindow(value: unknown): CodexRateLimitWindow | null {
  const w = obj(value);
  if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  const minutes = typeof w.windowDurationMins === 'number' && Number.isSafeInteger(w.windowDurationMins) && w.windowDurationMins > 0
    ? w.windowDurationMins : null;
  const resets = typeof w.resetsAt === 'number' && Number.isSafeInteger(w.resetsAt) && w.resetsAt > 0
    ? w.resetsAt * 1000 : null;
  return { usedPercent: Math.min(Math.max(w.usedPercent, 0), 100), windowMinutes: minutes, resetsAt: resets };
}

function projectBucket(value: unknown): CodexRateLimitBucket | null {
  const s = obj(value);
  if (!s) return null;
  return {
    limitId: short(s.limitId),
    limitName: typeof s.limitName === 'string' ? s.limitName.slice(0, 64) : null,
    primary: projectWindow(s.primary),
    secondary: projectWindow(s.secondary),
    reachedType: short(s.rateLimitReachedType),
  };
}

/** `account/rateLimits/read` result → rateLimits. Prefers the multi-bucket view. */
export function projectCodexRateLimits(result: unknown): CodexAccountStatus['rateLimits'] {
  const r = obj(result);
  if (!r) return null;
  const single = obj(r.rateLimits);
  const byId = obj(r.rateLimitsByLimitId);
  const sources = byId ? Object.values(byId) : single ? [single] : [];
  const buckets = sources.slice(0, MAX_BUCKETS).map(projectBucket).filter((b): b is CodexRateLimitBucket => b !== null);
  const allowed = r.ordinaryUsageAllowed;
  return {
    ordinaryUsageAllowed: typeof allowed === 'boolean' ? allowed : null,
    planType: short(single?.planType),
    buckets,
  };
}
