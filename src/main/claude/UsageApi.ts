// Anthropic 1-token dummy POST + rate-limit header parser.
//
// Strategy (validated by `openwong2kim/claude-token-check`):
//   1. POST a Haiku 4.5 request with `max_tokens: 1` and a 1-token body.
//   2. Don't care about the response body. The interesting data is the
//      four `anthropic-ratelimit-unified-*` headers.
//   3. Return a UsageSnapshot. On 401/403, throw Unauthorized — the
//      caller (UsagePoller) interprets that as "Claude Code logged out,
//      pause the poller and surface the error in the UI".
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
  /** 5h window reset time, Unix epoch SECONDS. 0 means "header missing
   *  / clock skew" — caller can render as "unknown" rather than 0. */
  sessionResetEpochSec: number;
  /** 7d window utilization, 0–100. */
  weeklyPct: number;
  /** 7d window reset time, Unix epoch SECONDS. */
  weeklyResetEpochSec: number;
  /** When we fetched. Unix epoch ms. */
  fetchedAtMs: number;
}

/** Discriminated error union. The UI maps these to copy strings. */
export type UsageApiError =
  | { kind: 'unauthorized' }
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

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

// User-Agent that matches the validated token-check setup. The OAuth
// beta endpoint pairs with a Claude-Code-flavored UA in the reference
// impl. We don't try a wmux-branded UA yet — if Anthropic gates the
// rate-limit headers on UA, we'd be the ones to find out, and the
// failure mode is silent (no headers, no UI update). Re-evaluate after
// dogfood.
const USER_AGENT = 'claude-code/2.1.5';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const MODEL = 'claude-haiku-4-5-20251001';

const BODY = JSON.stringify({
  model: MODEL,
  max_tokens: 1,
  messages: [{ role: 'user', content: 'hi' }],
});

/**
 * Send the 1-token probe and parse the rate-limit headers. Resolves
 * with a snapshot on 2xx; throws UsageApiException for everything else.
 *
 * `fetchImpl` defaults to global fetch (Electron main process has it).
 * Tests inject a stub.
 */
export async function fetchUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<UsageSnapshot> {
  // 20s upper bound. Anthropic's typical p99 is well under this; the
  // budget exists so a hung TCP connection / TLS handshake can't wedge
  // UsagePoller's `inflight` flag forever (Codex review 2026-05-24 P2 #4).
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        authorization: `Bearer ${accessToken}`,
      },
      body: BODY,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      (err instanceof DOMException && err.name === 'AbortError');
    const message = aborted
      ? `timed out after ${timeoutMs}ms`
      : (err instanceof Error ? err.message : 'fetch failed');
    throw new UsageApiException({ kind: 'network', message }, message);
  } finally {
    clearTimeout(abortTimer);
  }

  if (response.status === 401 || response.status === 403) {
    // Drain body to free the socket; ignore the contents — they can
    // include token-bearing error envelopes we don't want to keep.
    try { await response.text(); } catch { /* ignore */ }
    throw new UsageApiException({ kind: 'unauthorized' }, `HTTP ${response.status}`);
  }
  if (!response.ok) {
    const statusText = response.statusText || `status ${response.status}`;
    try { await response.text(); } catch { /* ignore */ }
    throw new UsageApiException(
      { kind: 'http', status: response.status, statusText },
      `HTTP ${response.status} ${statusText}`,
    );
  }

  // Headers parse independently of the body. We don't await response
  // body parsing for happy path either — abort the body stream once we
  // have the headers to free the socket. (Some fetch impls buffer the
  // body anyway; we don't depend on it.)
  try { await response.text(); } catch { /* ignore */ }

  return parseSnapshot(response.headers, Date.now());
}

/**
 * Pure helper. Exported so tests can drive it with mocked Headers and
 * an injected `now`.
 */
export function parseSnapshot(headers: Headers, nowMs: number): UsageSnapshot {
  return {
    sessionPct: readPercent(headers, 'anthropic-ratelimit-unified-5h-utilization'),
    sessionResetEpochSec: readEpochSeconds(headers, 'anthropic-ratelimit-unified-5h-reset'),
    weeklyPct: readPercent(headers, 'anthropic-ratelimit-unified-7d-utilization'),
    weeklyResetEpochSec: readEpochSeconds(headers, 'anthropic-ratelimit-unified-7d-reset'),
    fetchedAtMs: nowMs,
  };
}

/** Utilization headers ship as a decimal 0.0–1.0. We convert to integer
 *  percent (rounded). Missing/non-numeric headers report 0 — caller
 *  combines with status to decide if 0% means "fresh" vs "no data". */
function readPercent(headers: Headers, key: string): number {
  const raw = headers.get(key);
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

/** Reset headers ship as Unix epoch seconds. */
function readEpochSeconds(headers: Headers, key: string): number {
  const raw = headers.get(key);
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}
