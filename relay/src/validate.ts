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
// ActivityKit tokens are longer than device tokens (160 hex characters
// observed for a push-to-start token) and Apple documents no fixed length, so
// the Live Activity route gets real headroom rather than the device-token cap.
const LIVE_ACTIVITY_TOKEN_PATTERN = /^[0-9a-fA-F]{64,512}$/;

/** Canonical base64 (RFC 4648 §4) with padding — what pushEnvelope emits. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Apple allows up to 64 bytes; keep the charset boring so it survives a header. */
const COLLAPSE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The only two priorities APNs accepts. */
export const ALLOWED_PRIORITIES = [5, 10] as const;
export type PushPriority = (typeof ALLOWED_PRIORITIES)[number];

/**
 * The two APNs stages. A token minted by one is rejected by the other, and the
 * token itself does not say which — so the daemon has to, per device.
 */
export const ALLOWED_APNS_ENVIRONMENTS = ['development', 'production'] as const;
export type ApnsEnvironment = (typeof ALLOWED_APNS_ENVIRONMENTS)[number];

export interface PushRequest {
  apnsDeviceToken: string;
  /** Opaque. Never decoded by the relay. */
  ciphertext: string;
  priority: PushPriority;
  collapseId?: string;
  /**
   * Which Apple host this token belongs to. Absent means "use whatever this
   * relay was configured with" (`APNS_ENV`), which is what every daemon that
   * predates the field says and what the deployment did for all of them.
   *
   * An ALLOWLIST OF TWO LITERALS, never a host or a URL. The value picks
   * between two compiled-in constants; nothing a caller sends reaches `fetch`.
   */
  apnsEnvironment?: ApnsEnvironment;
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

  let apnsEnvironment: ApnsEnvironment | undefined;
  if (raw.apnsEnvironment !== undefined) {
    if (!ALLOWED_APNS_ENVIRONMENTS.includes(raw.apnsEnvironment as ApnsEnvironment)) {
      return fail(400, 'bad-apns-environment');
    }
    apnsEnvironment = raw.apnsEnvironment as ApnsEnvironment;
  }

  return {
    ok: true,
    value: { apnsDeviceToken: token, ciphertext, priority, collapseId, apnsEnvironment },
  };
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

/**
 * The Live Activity route, which is a DIFFERENT KIND OF REQUEST and gets its own
 * validator rather than a flag on the one above.
 *
 * `/push` forwards an opaque sealed blob. This one cannot: a Live Activity push
 * never runs the Notification Service Extension, so there is nowhere on-device
 * to decrypt an envelope, and the content-state travels in the clear. The
 * allowlist below is therefore the relay's promise about what it is willing to
 * carry in the clear — six integers, named, typed, and NOTHING ELSE. An unknown
 * key is a 400, not a passthrough: the moment this accepts a field it does not
 * understand, a daemon bug can put a pane name or a question on the wire.
 */
export const ALLOWED_LIVE_EVENTS = ['start', 'update', 'end'] as const;
export type LiveActivityEvent = (typeof ALLOWED_LIVE_EVENTS)[number];

/**
 * The two the app decodes with `decode`, not `decodeIfPresent`. A payload
 * missing either fails to decode on-device, and a Live Activity that cannot
 * decode its content-state freezes on the numbers it already had — a silent
 * failure with no signal anywhere.
 */
const REQUIRED_COUNTS = ['pendingApprovals', 'runningAgents'] as const;

/**
 * The only top-level keys this route carries. Same reasoning as the content-
 * state allowlist: what goes out on this route is UNSEALED, so "a field I do
 * not understand" must be a refusal rather than a passthrough. A daemon bug
 * that put a pane name in a new top-level key would otherwise reach Apple.
 */
const ALLOWED_LIVE_KEYS = new Set([
  'apnsToken',
  'apnsEnvironment',
  'event',
  'contentState',
  'attributes',
  'staleDate',
  'dismissalDate',
  'timestamp',
]);

/**
 * A count is a tally of things, and a negative tally is a daemon bug. The app
 * subtracts these from each other to lay out its rows, so a negative one does
 * not render as "odd", it renders as a broken widget with no way to tell why.
 */
function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
/** Present or absent; the app defaults them. */
const OPTIONAL_COUNTS = ['workingAgents', 'idleAgents', 'blockedPanes'] as const;
/** Optional AND nullable: null is "nothing is blocked", which is not zero. */
const NULLABLE_COUNTS = ['oldestBlockedMinutes'] as const;

export interface LiveActivityRequest {
  apnsToken: string;
  apnsEnvironment?: ApnsEnvironment;
  event: LiveActivityEvent;
  contentState: Record<string, number | null>;
  attributes?: { daemonName?: string };
  staleDate?: number;
  dismissalDate?: number;
  timestamp: number;
}

export type LiveValidationResult =
  | { ok: true; value: LiveActivityRequest }
  | { ok: false; error: ValidationFailure };

function isEpochSeconds(value: unknown): value is number {
  // Bounded as well as integral: an absurd date is a header APNs rejects, and
  // catching it here turns a remote 400 into a local one.
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1e11;
}

/** Validate the decoded JSON body of `POST /live`. */
export function validateLiveRequest(body: unknown): LiveValidationResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { status: 400, reason: 'body-not-object' } };
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    // `body-not-object` rather than a new reason: it is the same complaint —
    // this is not the body shape the route accepts — and the reason string is
    // deliberately about the SHAPE, never about the value that was wrong.
    if (!ALLOWED_LIVE_KEYS.has(key)) {
      return { ok: false, error: { status: 400, reason: 'body-not-object' } };
    }
  }

  const token = raw.apnsToken;
  if (typeof token !== 'string' || !LIVE_ACTIVITY_TOKEN_PATTERN.test(token)) {
    return { ok: false, error: { status: 400, reason: 'bad-device-token' } };
  }

  const event = raw.event;
  if (!ALLOWED_LIVE_EVENTS.includes(event as LiveActivityEvent)) {
    return { ok: false, error: { status: 400, reason: 'bad-event' } };
  }

  const state = raw.contentState;
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return { ok: false, error: { status: 400, reason: 'bad-content-state' } };
  }
  const contentState: Record<string, number | null> = {};
  const known = new Set<string>([...REQUIRED_COUNTS, ...OPTIONAL_COUNTS, ...NULLABLE_COUNTS]);
  for (const key of Object.keys(state as Record<string, unknown>)) {
    if (!known.has(key)) return { ok: false, error: { status: 400, reason: 'bad-content-state' } };
  }
  const counts = state as Record<string, unknown>;
  for (const key of REQUIRED_COUNTS) {
    if (!isCount(counts[key])) {
      return { ok: false, error: { status: 400, reason: 'bad-content-state' } };
    }
    contentState[key] = counts[key] as number;
  }
  for (const key of OPTIONAL_COUNTS) {
    if (counts[key] === undefined) continue;
    if (!isCount(counts[key])) {
      return { ok: false, error: { status: 400, reason: 'bad-content-state' } };
    }
    contentState[key] = counts[key] as number;
  }
  for (const key of NULLABLE_COUNTS) {
    if (counts[key] === undefined) continue;
    if (counts[key] !== null && !isCount(counts[key])) {
      return { ok: false, error: { status: 400, reason: 'bad-content-state' } };
    }
    contentState[key] = counts[key] as number | null;
  }

  let attributes: { daemonName?: string } | undefined;
  if (raw.attributes !== undefined) {
    const a = raw.attributes;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) {
      return { ok: false, error: { status: 400, reason: 'bad-attributes' } };
    }
    for (const key of Object.keys(a as Record<string, unknown>)) {
      if (key !== 'daemonName') {
        return { ok: false, error: { status: 400, reason: 'bad-attributes' } };
      }
    }
    const daemonName = (a as Record<string, unknown>).daemonName;
    if (daemonName !== undefined && (typeof daemonName !== 'string' || daemonName.length > 64)) {
      return { ok: false, error: { status: 400, reason: 'bad-attributes' } };
    }
    attributes = daemonName === undefined ? {} : { daemonName };
  }

  if (!isEpochSeconds(raw.timestamp)) {
    return { ok: false, error: { status: 400, reason: 'bad-timestamp' } };
  }
  if (raw.staleDate !== undefined && !isEpochSeconds(raw.staleDate)) {
    return { ok: false, error: { status: 400, reason: 'bad-stale-date' } };
  }
  if (raw.dismissalDate !== undefined && !isEpochSeconds(raw.dismissalDate)) {
    return { ok: false, error: { status: 400, reason: 'bad-dismissal-date' } };
  }

  let apnsEnvironment: ApnsEnvironment | undefined;
  if (raw.apnsEnvironment !== undefined) {
    if (!ALLOWED_APNS_ENVIRONMENTS.includes(raw.apnsEnvironment as ApnsEnvironment)) {
      return { ok: false, error: { status: 400, reason: 'bad-apns-environment' } };
    }
    apnsEnvironment = raw.apnsEnvironment as ApnsEnvironment;
  }

  return {
    ok: true,
    value: {
      apnsToken: token,
      event: event as LiveActivityEvent,
      contentState,
      timestamp: raw.timestamp,
      ...(attributes !== undefined ? { attributes } : {}),
      ...(raw.staleDate !== undefined ? { staleDate: raw.staleDate as number } : {}),
      ...(raw.dismissalDate !== undefined ? { dismissalDate: raw.dismissalDate as number } : {}),
      ...(apnsEnvironment !== undefined ? { apnsEnvironment } : {}),
    },
  };
}
