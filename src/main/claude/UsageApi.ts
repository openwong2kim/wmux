// Anthropic OAuth usage reader.
//
// Strategy: GET `/api/oauth/usage` with the Claude Code OAuth token. The
// endpoint returns the account's current 5h / 7d utilization (and any
// per-model weekly caps) as JSON — a read, so checking usage no longer
// spends a model request against the quota it is measuring. On 401/403
// throw Unauthorized — the caller (UsagePoller) interprets that as
// "Claude Code logged out, surface the error in the UI". On 429 throw
// RateLimited carrying Retry-After so the caller can back off.
//
// Token policy:
//   - The token is passed in by the caller. We never read it from disk
//     here, never write it anywhere, never log it. Error messages strip
//     anything that could carry a secret (see UsageApiError below).
//   - The endpoint is hardcoded to Anthropic's public API. No env-var
//     override, no proxy, no telemetry sink.

/** Snapshot returned to the caller. All fields plain numbers so the
 *  shape stays IPC-friendly. */
export interface UsageSnapshot {
  /** 5h window utilization, 0–100 (integer percent, rounded). */
  sessionPct: number;
  /** 5h window reset time, Unix epoch SECONDS. 0 means "field missing
   *  / unparseable" — caller can render as "unknown" rather than 0. */
  sessionResetEpochSec: number;
  /** 7d window utilization, 0–100. */
  weeklyPct: number;
  /** 7d window reset time, Unix epoch SECONDS. */
  weeklyResetEpochSec: number;
  /** When we fetched. Unix epoch ms. */
  fetchedAtMs: number;
  /** Per-model / per-scope weekly limits (e.g. an Opus-only weekly cap).
   *  Absent when the source did not report any. */
  scoped?: UsageScopedLimit[];
}

/** One scoped weekly limit. `pct` is 0–100; `resetEpochSec` is null when
 *  the source did not say when it resets; `scope` names what it applies to
 *  (null when unspecified). */
export interface UsageScopedLimit {
  kind: string;
  group: string;
  pct: number;
  resetEpochSec: number | null;
  scope: string | null;
}

/** Discriminated error union. The UI maps these to copy strings. */
export type UsageApiError =
  | { kind: 'unauthorized' }
  /** HTTP 429. `retryAfterMs` is the server's Retry-After, null if absent
   *  or unparseable (caller falls back to its own backoff). */
  | { kind: 'rate-limited'; retryAfterMs: number | null }
  | { kind: 'http'; status: number; statusText: string }
  | { kind: 'network'; message: string }
  | { kind: 'malformed'; message: string };

export class UsageApiException extends Error {
  readonly detail: UsageApiError;
  constructor(detail: UsageApiError, message: string) {
    super(message);
    this.name = 'UsageApiException';
    this.detail = detail;
  }
}

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA = 'oauth-2025-04-20';

// Honest client identity. main/index.ts sets the real app version at
// startup; tests and other callers get a neutral placeholder.
let clientVersion = 'dev';

/** Set the version reported in the `user-agent: wmux/<version>` header. */
export function setUsageClientVersion(version: string): void {
  if (version) clientVersion = version;
}

/**
 * Read the account's usage. Resolves with a snapshot on 2xx with a
 * recognisable body; throws UsageApiException for everything else.
 *
 * `fetchImpl` defaults to global fetch (Electron main process has it).
 * Tests inject a stub.
 */
export async function fetchUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<UsageSnapshot> {
  // The budget exists so a hung TCP connection / TLS handshake can't
  // wedge the caller's in-flight guard forever.
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  const toNetworkError = (err: unknown): UsageApiException => {
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      (err instanceof DOMException && err.name === 'AbortError');
    const message = aborted
      ? `timed out after ${timeoutMs}ms`
      : (err instanceof Error ? err.message : 'fetch failed');
    return new UsageApiException({ kind: 'network', message }, message);
  };
  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'GET',
      headers: {
        'anthropic-beta': ANTHROPIC_BETA,
        'user-agent': `wmux/${clientVersion}`,
        authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(abortTimer);
    throw toNetworkError(err);
  }

  // The status decides the outcome on its own for every non-2xx answer, so a
  // body that fails or stalls cannot turn a 401/429 into a network error.
  // Those bodies are drained in the background only to free the socket and
  // are never kept (they can echo request details).
  if (!response.ok) {
    clearTimeout(abortTimer);
    void response.text().catch(() => { /* ignore */ });
    if (response.status === 401 || response.status === 403) {
      throw new UsageApiException({ kind: 'unauthorized' }, `HTTP ${response.status}`);
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
      throw new UsageApiException({ kind: 'rate-limited', retryAfterMs }, 'HTTP 429 rate limited');
    }
    const statusText = response.statusText || `status ${response.status}`;
    throw new UsageApiException(
      { kind: 'http', status: response.status, statusText },
      `HTTP ${response.status} ${statusText}`,
    );
  }

  // 2xx: read the body under the same timeout — a stalled body is as much a
  // hang as a stalled connect.
  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    throw toNetworkError(err);
  } finally {
    clearTimeout(abortTimer);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new UsageApiException({ kind: 'malformed', message: 'response is not JSON' }, 'malformed usage response: not JSON');
  }
  const snapshot = parseUsageBody(json, Date.now());
  if (!snapshot) {
    throw new UsageApiException(
      { kind: 'malformed', message: 'no usage windows in response' },
      'malformed usage response: no usage windows',
    );
  }
  return snapshot;
}

/**
 * Pure parser for the `/api/oauth/usage` body. `five_hour` / `seven_day`
 * are primary (utilization is already 0–100); `limits[]` entries of kind
 * `session` / `weekly_all` fill in when those are null. Every
 * `weekly_scoped` limit maps into `scoped`. Unknown or missing fields never
 * throw. Returns null unless BOTH the 5h and the 7d window are found (from
 * either source), so the caller reports an error instead of a silent 0%.
 */
export function parseUsageBody(body: unknown, nowMs: number): UsageSnapshot | null {
  if (!isRecord(body)) return null;
  const limits = Array.isArray(body.limits) ? body.limits.filter(isRecord) : [];
  const findLimit = (kind: string) => limits.find((l) => l.kind === kind);

  const session = readWindow(body.five_hour) ?? readLimit(findLimit('session'));
  const weekly = readWindow(body.seven_day) ?? readLimit(findLimit('weekly_all'));
  if (!session || !weekly) return null;

  const scoped: UsageScopedLimit[] = [];
  for (const l of limits) {
    if (l.kind !== 'weekly_scoped') continue;
    const pct = toPct(l.percent);
    if (pct === null) continue;
    scoped.push({
      kind: 'weekly_scoped',
      group: typeof l.group === 'string' ? l.group : 'weekly',
      pct,
      resetEpochSec: toEpochSec(l.resets_at),
      scope: scopeLabel(l.scope),
    });
  }

  const snapshot: UsageSnapshot = {
    sessionPct: session.pct,
    sessionResetEpochSec: session.resetEpochSec,
    weeklyPct: weekly.pct,
    weeklyResetEpochSec: weekly.resetEpochSec,
    fetchedAtMs: nowMs,
  };
  if (scoped.length > 0) snapshot.scoped = scoped;
  return snapshot;
}

/** First 429 backoff step without a Retry-After; doubles per repeat. */
const RATE_LIMIT_BASE_BACKOFF_MS = 5 * 60 * 1000;
/** Upper bound for any 429 backoff, Retry-After included. */
const RATE_LIMIT_MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Backoff after the `consecutive`-th 429 in a row (1-based). Honors a
 *  positive Retry-After; a missing, zero or already-past one falls back to
 *  the exponential step, so the backoff is never 0 ms. Both cap at 60 min. */
export function rateLimitBackoffMs(consecutive: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null && retryAfterMs > 0) return Math.min(retryAfterMs, RATE_LIMIT_MAX_BACKOFF_MS);
  const exp = RATE_LIMIT_BASE_BACKOFF_MS * 2 ** Math.max(0, consecutive - 1);
  return Math.min(exp, RATE_LIMIT_MAX_BACKOFF_MS);
}

/** Retry-After is either delta-seconds or an HTTP date. Null when absent
 *  or unparseable. */
export function parseRetryAfter(raw: string | null, nowMs: number): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

interface WindowReading { pct: number; resetEpochSec: number }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `{ utilization, resets_at }` object → reading; null if absent/unusable. */
function readWindow(v: unknown): WindowReading | null {
  if (!isRecord(v)) return null;
  const pct = toPct(v.utilization);
  if (pct === null) return null;
  return { pct, resetEpochSec: toEpochSec(v.resets_at) ?? 0 };
}

/** `limits[]` entry `{ percent, resets_at }` → reading. */
function readLimit(v: Record<string, unknown> | undefined): WindowReading | null {
  if (!v) return null;
  const pct = toPct(v.percent);
  if (pct === null) return null;
  return { pct, resetEpochSec: toEpochSec(v.resets_at) ?? 0 };
}

/** 0–100 number → clamped integer percent; null if not a finite number. */
function toPct(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** ISO-8601 timestamp → Unix epoch seconds; null if absent/unparseable. */
function toEpochSec(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null;
}

/** The endpoint reports scope as an object (`{ model: { display_name, id },
 *  surface }`) or a string. Reduce it to one human-readable label. */
function scopeLabel(v: unknown): string | null {
  if (typeof v === 'string') return v || null;
  if (!isRecord(v)) return null;
  const parts: string[] = [];
  for (const key of ['model', 'surface']) {
    const part = v[key];
    if (typeof part === 'string' && part) parts.push(part);
    else if (isRecord(part)) {
      const name = part.display_name ?? part.id;
      if (typeof name === 'string' && name) parts.push(name);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
