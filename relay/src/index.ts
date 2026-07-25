/**
 * wmux push relay — a stateless, blind forwarder from user daemons to APNs.
 *
 * WHY IT EXISTS
 * APNs requires the app's .p8 provider key. That key cannot ship inside user
 * daemons (anyone holding it could push to every wmux user), so a relay the
 * project operates sits between them. This is a release-track component: every
 * user's daemon is a client of this one deployment.
 *
 * THE BLINDNESS CLAIM — verifiable by reading this file
 * The operator of this relay cannot read anyone's notification contents:
 *   1. `ciphertext` arrives already sealed by the daemon (AES-256-GCM, key
 *      derived from a per-device pairing secret the relay never sees — see
 *      src/shared/push/pushEnvelope.ts). The relay has no key material for it.
 *   2. It is treated as an opaque string: validated for length and base64
 *      charset in validate.ts, then copied verbatim into the APNs payload.
 *      There is no `atob`, no `JSON.parse`, no substring of it anywhere in this
 *      file.
 *   3. `logEvent` accepts a closed set of fields — none of which can hold the
 *      ciphertext or the device token — and it is the only logging path.
 * The visible alert the relay sends is a fixed placeholder; the iOS Notification
 * Service Extension decrypts and rewrites it on-device.
 *
 * STATE
 * One cached APNs provider JWT per isolate (apnsJwt.ts). No KV, no D1, no
 * database, no accounts, no queue.
 */

import { createApnsTokenProvider, type ApnsTokenProvider } from './apnsJwt';
import { exceedsDeclaredBodyLimit, MAX_BODY_BYTES, validatePushRequest } from './validate';

export interface RelayEnv {
  /** Contents of the AuthKey_XXXXXXXXXX.p8 file (secret). */
  APNS_KEY_P8: string;
  /** 10-character Key ID matching the .p8 (secret). */
  APNS_KEY_ID: string;
  /** 10-character Apple Developer Team ID (secret). */
  APNS_TEAM_ID: string;
  /** The iOS app's bundle identifier — APNs calls this the topic (secret). */
  APNS_TOPIC: string;
  /**
   * The shared secret every wmux daemon presents as `Authorization: Bearer …`.
   *
   * This is NOT an account, and it does not reintroduce the user database the
   * "no storage" rule exists to avoid: it is ONE value for the whole
   * deployment, set with `wrangler secret put` and shipped in the daemon's
   * config. Without it `/push` is an open proxy to Apple holding the project's
   * provider key — a stranger cannot read anyone's notification, but they can
   * spend our APNs quota and hand Apple a stream of bad-token traffic from our
   * Team ID, and Apple answers that by throttling and revoking keys. Every
   * user's push rides on this one deployment, so that is everyone's outage.
   *
   * Required, deliberately: an unconfigured relay refuses rather than serving
   * openly (see `missingConfig`).
   */
  RELAY_SHARED_SECRET: string;
  /** 'sandbox' routes to Apple's sandbox host. Anything else means production. */
  APNS_ENV?: string;
}

const APNS_HOST_PRODUCTION = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';

/** Give up on Apple rather than hold a daemon's socket open indefinitely. */
const APNS_TIMEOUT_MS = 10_000;

/**
 * Matches PUSH_MAX_AGE_MS in pushEnvelope.ts: a notification delivered after the
 * envelope goes stale cannot be decrypted, so asking Apple to keep retrying past
 * that point only produces an alert the extension will refuse.
 */
const APNS_EXPIRATION_SECONDS = 300;

/**
 * What the lock screen shows if the Notification Service Extension does not run
 * (low memory, extension crash, older build). The relay cannot do better — it
 * cannot read the real title.
 */
const PLACEHOLDER_ALERT = { title: 'wmux', body: 'New activity' } as const;

/** APNs reasons that mean "your provider token is no good, sign a fresh one". */
const TOKEN_RETRY_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

/**
 * The only logging path in the relay. The parameter type is deliberately closed:
 * there is no field here that could carry a ciphertext, a device token, or any
 * part of a notification, so "the relay never logs payloads" is enforced by the
 * type rather than by reviewer vigilance.
 */
function logEvent(fields: {
  event: 'push' | 'reject' | 'error';
  status: number;
  apnsStatus?: number;
  reason?: string;
  ms?: number;
}): void {
  console.log(JSON.stringify(fields));
}

let provider: ApnsTokenProvider | null = null;
let providerKeyId: string | null = null;

function getProvider(env: RelayEnv): ApnsTokenProvider {
  if (provider === null || providerKeyId !== env.APNS_KEY_ID) {
    provider = createApnsTokenProvider({
      keyP8: env.APNS_KEY_P8,
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
    });
    providerKeyId = env.APNS_KEY_ID;
  }
  return provider;
}

/** Exported for tests only. The deployed Worker never calls this. */
export function resetRelayStateForTests(): void {
  provider = null;
  providerKeyId = null;
}

function json(status: number, body: Record<string, unknown>, stage: 'relay' | 'apns'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Lets the daemon tell "Apple said no" from "the relay said no" without
      // guessing from the status code.
      'x-wmux-relay-stage': stage,
      'cache-control': 'no-store',
    },
  });
}

/**
 * Length-independent comparison of two short ASCII secrets.
 *
 * Workers has no `crypto.timingSafeEqual`, and `===` on a secret leaks its
 * prefix through response timing. Comparing the SHA-256 of each side keeps the
 * loop fixed-length whatever the caller sends, so a wrong length costs the same
 * as a wrong byte.
 */
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  if (expected.length === 0) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function bearer(req: Request): string {
  const header = req.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

/**
 * Read the body with the cap enforced AS IT ARRIVES.
 *
 * `arrayBuffer()` buffers everything first and only then lets the caller check
 * the size, so a request with no `Content-Length` (or a chunked one) walked
 * straight past the declared-length guard and made the isolate hold a
 * platform-sized body before the 8 KiB rule ever ran. Returns null once the cap
 * is passed, without waiting for the rest.
 */
async function readBoundedBody(req: Request, limit: number): Promise<Uint8Array | null> {
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function missingConfig(env: RelayEnv): string | null {
  for (const key of ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC', 'RELAY_SHARED_SECRET'] as const) {
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0) return key;
  }
  return null;
}

/** APNs error bodies are `{"reason":"BadDeviceToken"}` — a closed Apple enum, safe to surface. */
function extractApnsReason(bodyText: string): string | undefined {
  if (bodyText.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed !== null && typeof parsed === 'object') {
      const reason = (parsed as Record<string, unknown>).reason;
      if (typeof reason === 'string' && /^[A-Za-z]{1,64}$/.test(reason)) return reason;
    }
  } catch {
    // Non-JSON body from an intermediary; nothing worth reporting.
  }
  return undefined;
}

async function forwardToApns(
  env: RelayEnv,
  token: string,
  request: { apnsDeviceToken: string; ciphertext: string; priority: number; collapseId?: string },
  nowMs: number,
): Promise<{ status: number; reason?: string; apnsId?: string }> {
  const host = env.APNS_ENV === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PRODUCTION;
  const headers: Record<string, string> = {
    authorization: `bearer ${token}`,
    'apns-topic': env.APNS_TOPIC,
    'apns-push-type': 'alert',
    'apns-priority': String(request.priority),
    'apns-expiration': String(Math.floor(nowMs / 1000) + APNS_EXPIRATION_SECONDS),
    'content-type': 'application/json',
  };
  if (request.collapseId !== undefined) headers['apns-collapse-id'] = request.collapseId;

  const body = JSON.stringify({
    aps: {
      alert: PLACEHOLDER_ALERT,
      // Required for the Notification Service Extension to run and rewrite the
      // alert with the decrypted content.
      'mutable-content': 1,
      sound: 'default',
    },
    // The sealed envelope, verbatim. The extension reads userInfo["wmux"].
    wmux: request.ciphertext,
  });

  const res = await fetch(`${host}/3/device/${request.apnsDeviceToken}`, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(APNS_TIMEOUT_MS),
  });

  const text = await res.text();
  return {
    status: res.status,
    reason: extractApnsReason(text),
    apnsId: res.headers.get('apns-id') ?? undefined,
  };
}

async function handlePush(req: Request, env: RelayEnv, startedAt: number): Promise<Response> {
  if (exceedsDeclaredBodyLimit(req.headers.get('content-length'))) {
    logEvent({ event: 'reject', status: 413, reason: 'body-too-large' });
    return json(413, { ok: false, reason: 'body-too-large' }, 'relay');
  }

  // Configuration is checked BEFORE the caller is judged: an unconfigured relay
  // has no secret to compare against, and answering 401 there would tell a
  // prober that the deployment exists but is unfinished.
  const missing = missingConfig(env);
  if (missing !== null) {
    // Name the variable in the log for the operator, never in the response.
    logEvent({ event: 'error', status: 500, reason: `missing-${missing}` });
    return json(500, { ok: false, reason: 'relay-misconfigured' }, 'relay');
  }

  // Authenticate before reading a single byte of body. This ordering is the
  // point: a stranger must not be able to make the isolate buffer anything, and
  // must not reach the code that spends our APNs provider key.
  if (!(await secretsMatch(bearer(req), env.RELAY_SHARED_SECRET))) {
    logEvent({ event: 'reject', status: 401, reason: 'unauthorized' });
    return json(401, { ok: false, reason: 'unauthorized' }, 'relay');
  }

  const raw = await readBoundedBody(req, MAX_BODY_BYTES);
  if (raw === null) {
    logEvent({ event: 'reject', status: 413, reason: 'body-too-large' });
    return json(413, { ok: false, reason: 'body-too-large' }, 'relay');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    logEvent({ event: 'reject', status: 400, reason: 'bad-json' });
    return json(400, { ok: false, reason: 'bad-json' }, 'relay');
  }

  const validated = validatePushRequest(parsed);
  if (!validated.ok) {
    // `reason` names a field, never a value — see validate.ts.
    logEvent({ event: 'reject', status: validated.error.status, reason: validated.error.reason });
    return json(validated.error.status, { ok: false, reason: validated.error.reason }, 'relay');
  }

  const tokenProvider = getProvider(env);
  const now = Date.now();

  let result: { status: number; reason?: string; apnsId?: string };
  try {
    result = await forwardToApns(env, await tokenProvider.getToken(now), validated.value, now);

    // A cached token can outlive its welcome if Apple rotates or the isolate's
    // clock drifted. Re-sign once rather than failing every push until the
    // isolate recycles.
    if (result.status === 403 && result.reason !== undefined && TOKEN_RETRY_REASONS.has(result.reason)) {
      tokenProvider.invalidate();
      result = await forwardToApns(env, await tokenProvider.getToken(now), validated.value, now);
    }
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'apns-timeout' : 'apns-unreachable';
    logEvent({ event: 'error', status: 502, reason, ms: Date.now() - startedAt });
    return json(502, { ok: false, reason }, 'relay');
  }

  logEvent({
    event: 'push',
    status: result.status,
    apnsStatus: result.status,
    reason: result.reason,
    ms: Date.now() - startedAt,
  });

  // Pass Apple's status through untouched. 410 in particular is load-bearing:
  // it is how the daemon learns to prune a dead device token.
  return json(
    result.status,
    {
      ok: result.status === 200,
      apnsStatus: result.status,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.apnsId !== undefined ? { apnsId: result.apnsId } : {}),
    },
    'apns',
  );
}

export default {
  async fetch(req: Request, env: RelayEnv): Promise<Response> {
    const startedAt = Date.now();
    const { pathname } = new URL(req.url);

    if (pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(405, { ok: false, reason: 'method-not-allowed' }, 'relay');
      }
      // Deliberately says nothing about configuration or traffic.
      return json(200, { ok: true }, 'relay');
    }

    if (pathname !== '/push') {
      return json(404, { ok: false, reason: 'not-found' }, 'relay');
    }
    if (req.method !== 'POST') {
      return json(405, { ok: false, reason: 'method-not-allowed' }, 'relay');
    }

    try {
      return await handlePush(req, env, startedAt);
    } catch {
      // Never let an exception message reach the client: it could quote a
      // header or a body fragment.
      logEvent({ event: 'error', status: 500, reason: 'unhandled', ms: Date.now() - startedAt });
      return json(500, { ok: false, reason: 'internal-error' }, 'relay');
    }
  },
};
