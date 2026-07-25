/**
 * Request validation for the push relay. Pure functions, no crypto, no network:
 * everything here runs BEFORE a JWT is signed so a malformed or oversized
 * request costs the relay nothing.
 *
 * Nothing in this file inspects the meaning of `ciphertext`. It is length- and
 * charset-checked as an opaque base64 string and never decoded, parsed, or
 * logged — that is the property the relay's blindness claim rests on.
 */

/** Hard cap on the raw request body. Larger requests are refused unread. */
export const MAX_BODY_BYTES = 8192;

/**
 * Cap on the opaque ciphertext blob. Anything larger cannot fit in an APNs
 * payload anyway (4096 bytes total), so rejecting here turns a guaranteed
 * Apple-side 413 into a fast local 400.
 */
export const MAX_CIPHERTEXT_CHARS = 4000;

/** APNs device tokens are 32 bytes of hex today; Apple reserves the right to grow them. */
const DEVICE_TOKEN_PATTERN = /^[0-9a-fA-F]{64,200}$/;

/** Canonical base64 (RFC 4648 §4) with padding — what pushEnvelope emits. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Apple allows up to 64 bytes; keep the charset boring so it survives a header. */
const COLLAPSE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The only two priorities APNs accepts. */
export const ALLOWED_PRIORITIES = [5, 10] as const;
export type PushPriority = (typeof ALLOWED_PRIORITIES)[number];

export interface PushRequest {
  apnsDeviceToken: string;
  /** Opaque. Never decoded by the relay. */
  ciphertext: string;
  priority: PushPriority;
  collapseId?: string;
}

export type ValidationFailure = {
  status: number;
  /**
   * Short machine-readable reason. Deliberately generic: it describes the
   * FIELD that was wrong, never its value, so nothing from a request body can
   * reach a log line through an error message.
   */
  reason: string;
};

export type ValidationResult =
  | { ok: true; value: PushRequest }
  | { ok: false; error: ValidationFailure };

function fail(status: number, reason: string): ValidationResult {
  return { ok: false, error: { status, reason } };
}

/**
 * Validate the decoded JSON body of `POST /push`.
 *
 * Ordering matters: cheap structural checks first, so an attacker cannot make
 * the relay do work by sending well-formed junk.
 */
export function validatePushRequest(body: unknown): ValidationResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'body-not-object');
  }
  const raw = body as Record<string, unknown>;

  const token = raw.apnsDeviceToken;
  if (typeof token !== 'string' || !DEVICE_TOKEN_PATTERN.test(token)) {
    return fail(400, 'bad-device-token');
  }

  const ciphertext = raw.ciphertext;
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    return fail(400, 'bad-ciphertext');
  }
  if (ciphertext.length > MAX_CIPHERTEXT_CHARS) {
    return fail(413, 'ciphertext-too-large');
  }
  if (!BASE64_PATTERN.test(ciphertext)) {
    // A charset check, not a read: it proves the string is transportable
    // inside a JSON payload without revealing anything about its contents.
    return fail(400, 'bad-ciphertext');
  }

  let priority: PushPriority = 10;
  if (raw.priority !== undefined) {
    if (!ALLOWED_PRIORITIES.includes(raw.priority as PushPriority)) {
      return fail(400, 'bad-priority');
    }
    priority = raw.priority as PushPriority;
  }

  let collapseId: string | undefined;
  if (raw.collapseId !== undefined) {
    if (typeof raw.collapseId !== 'string' || !COLLAPSE_ID_PATTERN.test(raw.collapseId)) {
      return fail(400, 'bad-collapse-id');
    }
    collapseId = raw.collapseId;
  }

  return { ok: true, value: { apnsDeviceToken: token, ciphertext, priority, collapseId } };
}

/**
 * Decide whether to read the body at all, from the declared Content-Length.
 * A missing/unparseable header is allowed through — the byte-level cap in the
 * handler is the real enforcement; this only avoids buffering an obvious flood.
 */
export function exceedsDeclaredBodyLimit(contentLength: string | null): boolean {
  if (contentLength === null) return false;
  const n = Number(contentLength);
  return Number.isFinite(n) && n > MAX_BODY_BYTES;
}
