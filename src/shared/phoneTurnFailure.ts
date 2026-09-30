/**
 * Typed agent turn failure for the phone contract (docs/phone-client-contract.md,
 * "Proposed: contract v-next", item 1). CONTRACT ONLY: nothing serves these
 * fields yet.
 *
 * The rule is "known facts only". `reason` is a coarse, closed union derived
 * from the provider's own structured error code; `providerCode` carries that
 * code verbatim so a client can refine without a daemon release. Nothing here
 * parses prose: neither Claude Code's StopFailure hook nor Codex's `TurnError`
 * carries a structured retry-after or reset time, so `retryAfterMs` / `resetAt`
 * are defined for forward compatibility and are never populated today.
 */

export type TurnFailureReason = 'rate-limited' | 'auth' | 'quota' | 'network' | 'unknown';
export type TurnFailureProvider = 'claude' | 'codex';

/** Upper bound for `message`, in UTF-16 code units (the unit iOS counts in). */
export const TURN_FAILURE_MESSAGE_MAX_UNITS = 280;

export interface TurnFailure {
  reason: TurnFailureReason;
  provider: TurnFailureProvider;
  /** The provider's own code, verbatim (`rate_limit`, `usageLimitExceeded`, …). Open set. */
  providerCode?: string;
  /** Codex only, when `codexErrorInfo` names an HTTP status. */
  httpStatus?: number;
  /**
   * Provider-authored, user-facing text, clipped and control-stripped. Only on
   * surfaces gated by `--allow-transcript`. Render as plain text.
   */
  message?: string;
  /** Reserved. Never set today: no source carries a structured value. */
  retryAfterMs?: number;
  /** Reserved (epoch ms). Never set today: no source carries a structured value. */
  resetAt?: number;
  /** Epoch ms the daemon saw the failure. */
  at: number;
  /** The `chat.turn.id` (`t1:`) of the turn that failed, when the daemon knows it. */
  turnId?: string;
}

const PROVIDER_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Claude Code `StopFailure.error` → reason. Values verified against the hook
 * input schema of Claude Code 2.1.285 (`error` is required; `error_details`
 * and `last_assistant_message` are optional). Claude reports a subscription
 * usage cap as `rate_limit` too, so Claude never yields `quota` for it; only
 * `billing_error` (credits/billing) does. Claude has no connection-failure
 * code, so it never yields `network`.
 */
const CLAUDE_REASONS: Readonly<Record<string, TurnFailureReason>> = {
  rate_limit: 'rate-limited',
  billing_error: 'quota',
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  cloud_credential_error: 'auth',
  account_on_hold: 'auth',
  verification_required: 'auth',
};

/**
 * Codex app-server `CodexErrorInfo` string variants → reason. Verified against
 * `codex app-server generate-ts --experimental` from codex-cli 0.157.1.
 */
const CODEX_REASONS: Readonly<Record<string, TurnFailureReason>> = {
  rateLimitExceeded: 'rate-limited',
  usageLimitExceeded: 'quota',
  sessionBudgetExceeded: 'quota',
  unauthorized: 'auth',
};

/** Codex object variants that describe a transport failure and may carry an HTTP status. */
const CODEX_TRANSPORT = new Set(['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected']);

/** Strip control characters, collapse whitespace, clip to the unit budget. */
export function clipProviderMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  if (flat.length <= TURN_FAILURE_MESSAGE_MAX_UNITS) return flat;
  let cut = TURN_FAILURE_MESSAGE_MAX_UNITS - 1;
  // Never leave a lone high surrogate at the cut.
  const last = flat.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${flat.slice(0, cut)}…`;
}

function reasonFromHttpStatus(status: number | undefined): TurnFailureReason | undefined {
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'auth';
  return undefined;
}

/**
 * Classify a Claude Code `StopFailure` hook payload (the `AgentSignal.payload`
 * the bridge forwards verbatim). `message` comes from `last_assistant_message`
 * (what Claude showed the user), never from `error_details` (raw API text,
 * marked internal by Claude Code).
 */
export function classifyClaudeStopFailure(payload: Record<string, unknown>, at: number): TurnFailure {
  const code = typeof payload.error === 'string' && PROVIDER_CODE.test(payload.error) ? payload.error : undefined;
  const message = clipProviderMessage(payload.last_assistant_message);
  return {
    reason: (code && CLAUDE_REASONS[code]) || 'unknown',
    provider: 'claude',
    ...(code ? { providerCode: code } : {}),
    ...(message ? { message } : {}),
    at,
  };
}

/**
 * Classify a Codex `TurnError` from a `turn/completed` notification whose
 * `turn.status` is `failed`. Returns undefined for any other status: an
 * `error` notification with `willRetry: true` is not a failure, and an
 * interrupted turn is a cancel, not a failure.
 */
export function classifyCodexTurnCompleted(turn: unknown, at: number): TurnFailure | undefined {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return undefined;
  const t = turn as Record<string, unknown>;
  if (t.status !== 'failed') return undefined;
  const error = t.error && typeof t.error === 'object' && !Array.isArray(t.error) ? t.error as Record<string, unknown> : {};
  const info = error.codexErrorInfo;
  let code: string | undefined;
  let httpStatus: number | undefined;
  if (typeof info === 'string') {
    code = info;
  } else if (info && typeof info === 'object' && !Array.isArray(info)) {
    const keys = Object.keys(info);
    if (keys.length === 1) {
      code = keys[0];
      const inner = (info as Record<string, unknown>)[code];
      const status = inner && typeof inner === 'object' ? (inner as Record<string, unknown>).httpStatusCode : undefined;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) httpStatus = status;
    }
  }
  if (code !== undefined && !PROVIDER_CODE.test(code)) { code = undefined; httpStatus = undefined; }
  let reason: TurnFailureReason = (code && CODEX_REASONS[code]) || 'unknown';
  if (reason === 'unknown' && code && (CODEX_TRANSPORT.has(code) || code === 'responseTooManyFailedAttempts')) {
    reason = reasonFromHttpStatus(httpStatus) ?? (CODEX_TRANSPORT.has(code) ? 'network' : 'unknown');
  }
  const message = clipProviderMessage(error.message);
  // `turnId` stays unset: the native Codex turn id is not the phone's `t1:`
  // id, and the serving code maps one to the other.
  return {
    reason,
    provider: 'codex',
    ...(code ? { providerCode: code } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(message ? { message } : {}),
    at,
  };
}

/** The same failure with `message` removed, for surfaces without `--allow-transcript`. */
export function withoutMessage(failure: TurnFailure): TurnFailure {
  const rest = { ...failure };
  delete rest.message;
  return rest;
}
