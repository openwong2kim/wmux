/**
 * pushEnvelope — the end-to-end encrypted payload that travels daemon → relay →
 * APNs → iOS Notification Service Extension (roadmap M5, contract M5b).
 *
 * The relay and Apple both handle this envelope, and neither can read it: the
 * only plaintext they see is the routing metadata (`deviceId`, `ts`) that the
 * envelope binds as AES-GCM additional authenticated data. This module is the
 * single definition of that format so the Node sender and the Swift receiver
 * cannot drift.
 *
 * Pure module by design: it does no I/O, holds no device records, and is NOT
 * wired into the daemon here (PushSender is deferred until M3's DeviceStore
 * lands). It takes the raw per-device pairing secret and gives back an envelope.
 *
 * ---------------------------------------------------------------------------
 * WIRE FORMAT (v1)
 * ---------------------------------------------------------------------------
 *   {
 *     "v": 1,
 *     "deviceId": "<pairing device id, ASCII>",
 *     "ts": 1753420800000,        // integer, Unix epoch MILLISECONDS
 *     "iv":  "<base64, 12 bytes>",
 *     "ct":  "<base64, AES-256-GCM ciphertext>",
 *     "tag": "<base64, 16 bytes>"
 *   }
 *
 * Cryptography:
 *   key   = HKDF-SHA256(ikm = deviceSecret, salt = <empty>, info = "wmux:push:v1", L = 32)
 *   nonce = 12 random bytes, fresh per envelope (never reused with the same key)
 *   aad   = UTF-8("wmux:push:v1|" + deviceId + "|" + ts)
 *   ct,tag = AES-256-GCM(key, nonce, aad, plaintext = UTF-8(JSON.stringify(payload)))
 *
 * ---------------------------------------------------------------------------
 * HOW SWIFT REPRODUCES THIS (Notification Service Extension, CryptoKit)
 * ---------------------------------------------------------------------------
 * Every byte below is load-bearing. The five things that break byte-for-byte
 * parity are called out as WARNINGs — read them before writing the extension.
 *
 *   import CryptoKit
 *   import Foundation
 *
 *   // 0. Unwrap the opaque blob the relay put in the APNs payload. The relay
 *   //    never sees the envelope's fields — it forwards one base64 string
 *   //    under the "wmux" key (see encodePushEnvelopeForRelay).
 *   guard let blob = request.content.userInfo["wmux"] as? String,
 *         let envJSON = Data(base64Encoded: blob) else { throw … }
 *   let env = try JSONDecoder().decode(PushEnvelopeDTO.self, from: envJSON)
 *
 *   // 1. Derive the push key. HKDF-SHA256, ZERO-LENGTH salt, fixed info string,
 *   //    32-byte output. `deviceSecretBytes` is the RAW secret from pairing.
 *   let pushKey = HKDF<SHA256>.deriveKey(
 *       inputKeyMaterial: SymmetricKey(data: deviceSecretBytes),
 *       salt: Data(),                            // zero-length, see WARNING 1
 *       info: Data("wmux:push:v1".utf8),         // exactly 12 ASCII bytes
 *       outputByteCount: 32
 *   )
 *
 *   // 2. Rebuild the AAD. Plain UTF-8 string concatenation — NOT JSON.
 *   let aad = Data("wmux:push:v1|\(deviceId)|\(tsMillis)".utf8)   // see WARNING 2
 *
 *   // 3. Open the sealed box. Standard base64 WITH padding — see WARNING 3.
 *   guard let ivData  = Data(base64Encoded: env.iv),
 *         let ctData  = Data(base64Encoded: env.ct),
 *         let tagData = Data(base64Encoded: env.tag) else { throw … }
 *   let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: ivData),
 *                                   ciphertext: ctData,
 *                                   tag: tagData)
 *   let plaintext = try AES.GCM.open(box, using: pushKey, authenticating: aad)
 *   let payload = try JSONDecoder().decode(PushPayload.self, from: plaintext)
 *
 *   // 4. Enforce freshness on the Swift side too (the daemon already does):
 *   //    reject when tsMillis is older than PUSH_MAX_AGE_MS (300_000) or more
 *   //    than PUSH_MAX_FUTURE_SKEW_MS (60_000) in the future.
 *
 * WARNING 1 — salt. The salt is a zero-length byte string, not "absent" and not
 *   a random value. RFC 5869 substitutes HashLen zero bytes when no salt is
 *   given, and HMAC-SHA256 pads any key shorter than its 64-byte block with
 *   zeros, so `Data()` and `Data(repeating: 0, count: 32)` derive the identical
 *   key. Verified against Node's `hkdfSync` — either form is correct.
 *
 * WARNING 2 — the timestamp inside the AAD. `ts` MUST be interpolated as a
 *   decimal integer with no grouping, no sign, no fraction. Decode it into an
 *   `Int64`, never a `Double`: `JSONSerialization` yields `NSNumber` for JSON
 *   numbers, and interpolating a `Double` produces "1.7534208e+12" or
 *   "1753420800000.0", either of which changes the AAD bytes and fails
 *   authentication with an error that looks like a key problem. Use
 *   `Int64` (or `Decodable` into `Int64`) and `String(tsMillis)`.
 *
 * WARNING 3 — base64 variant. Standard RFC 4648 §4 alphabet ("+/") WITH "="
 *   padding, produced by Node's `Buffer#toString('base64')` and consumed by
 *   Swift's `Data(base64Encoded:)` with default options. It is NOT base64url;
 *   do not translate "-_" and do not strip padding. This module rejects
 *   non-canonical encodings on the way in, so what Swift receives is always the
 *   canonical padded form.
 *
 * WARNING 4 — JSON key order is irrelevant. Neither the envelope's key order
 *   nor the plaintext payload's key order affects decryption: the only
 *   order-sensitive bytes are the AAD string built in step 2. Do not attempt to
 *   canonicalize JSON on either side.
 *
 * WARNING 5 — deviceId is compared byte-for-byte, case-sensitively, and must
 *   be the same string the pairing record stored. It may not contain "|"
 *   (enforced by DEVICE_ID_PATTERN when sealing) so the AAD cannot be made
 *   ambiguous by a crafted id.
 *
 * KNOWN-ANSWER TEST VECTOR — hardcode this in the Swift unit tests. It is
 * asserted by `pushEnvelope.test.ts`, so if the format ever changes, both
 * suites fail together instead of silently disagreeing.
 *
 *   deviceSecret (hex, 32 bytes)
 *     000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
 *   derived push key (hex, 32 bytes)
 *     88aee925fdcdc9fb5f87a55895a0cd5928229585208723a5e249526dfb437add
 *   deviceId  "dev-kat-0001"
 *   ts        1753420800000
 *   iv (b64)  "AQIDBAUGBwgJCgsM"                     (hex 0102030405060708090a0b0c)
 *   payload   {"title":"Approval needed","body":"rm -rf ./build","approvalId":"ap_1"}
 *   aad       "wmux:push:v1|dev-kat-0001|1753420800000"   (39 ASCII bytes)
 *   ct  (b64) "VwO5KiVWzFM7fSpkP9KEX1rMoi0Vk4OVmBacMffQ1np9k+13BeKVngmpFzq+QFIuIEkzGgCzlAXpuk9yRU12cgeZb5seVoA="
 *   tag (b64) "m9eu9MzvCyHwmNnA3idz5Q=="
 *
 * A Swift extension that reproduces `derived push key` and then opens that
 * `ct`/`tag` with that `aad` is byte-for-byte compatible with this module.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** Envelope format version. Bump only for a breaking wire change. */
export const PUSH_ENVELOPE_VERSION = 1 as const;

/** HKDF `info` string. Fixed forever for v1 — changing it rotates every key. */
export const PUSH_HKDF_INFO = 'wmux:push:v1';

/** First field of the AAD string; domain-separates from any other AAD we sign. */
export const PUSH_AAD_PREFIX = 'wmux:push:v1';

/** Field separator inside the AAD. deviceId may not contain it. */
export const PUSH_AAD_SEPARATOR = '|';

export const PUSH_KEY_BYTES = 32; // AES-256
export const PUSH_IV_BYTES = 12; // 96-bit GCM nonce (the only size CryptoKit accepts without ceremony)
export const PUSH_TAG_BYTES = 16; // 128-bit GCM tag

/** Shortest pairing secret we will derive from. M3 is expected to mint 32 bytes. */
export const PUSH_MIN_SECRET_BYTES = 16;

/**
 * Plaintext cap, derived from the 4096-byte APNs payload limit by walking the
 * whole inflation chain at worst case (128-char deviceId):
 *
 *   plaintext 1800 → ct 1800 → base64(ct) 2400 → envelope JSON ~2633
 *     → base64(envelope) 3512 → APNs body ~3616   (≈480 bytes of headroom)
 *
 * We throw rather than truncate — the caller decides what to shorten.
 */
export const PUSH_MAX_PLAINTEXT_BYTES = 1800;

/** Envelopes older than this are refused at open time. */
export const PUSH_MAX_AGE_MS = 5 * 60 * 1000;

/** Tolerance for a sender clock that runs ahead of the receiver. */
export const PUSH_MAX_FUTURE_SKEW_MS = 60 * 1000;

/**
 * Accepted deviceId shape. Deliberately excludes the AAD separator and any
 * whitespace so the AAD string can never be made ambiguous.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Canonical base64 (RFC 4648 §4) with padding. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type PushEnvelopeErrorCode =
  | 'bad-secret'
  | 'bad-device-id'
  | 'bad-payload'
  | 'payload-too-large'
  | 'bad-shape'
  | 'bad-version'
  | 'bad-base64'
  | 'device-mismatch'
  | 'stale'
  | 'future'
  | 'auth-failed';

/** Every rejection path throws this, so callers can branch without string matching. */
export class PushEnvelopeError extends Error {
  readonly code: PushEnvelopeErrorCode;

  constructor(code: PushEnvelopeErrorCode, message: string) {
    super(message);
    this.name = 'PushEnvelopeError';
    this.code = code;
  }
}

/**
 * What the daemon encrypts. `title`/`body` are what the extension renders;
 * the ids let the notification deep-link into the right card.
 * Unknown extra fields survive the round trip so M6 can add fields without a
 * format bump.
 */
export interface PushPayload {
  title: string;
  body: string;
  approvalId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

/** The JSON object handed to the relay as `ciphertext`'s container. */
export interface PushEnvelope {
  v: typeof PUSH_ENVELOPE_VERSION;
  deviceId: string;
  ts: number;
  iv: string;
  ct: string;
  tag: string;
}

/**
 * HKDF-SHA256 with an empty salt and a fixed info string. Exported so a caller
 * can cache the key per device, and so the Swift parity test has something to
 * compare against.
 */
export function derivePushKey(deviceSecret: Uint8Array): Buffer {
  if (!(deviceSecret instanceof Uint8Array) || deviceSecret.length < PUSH_MIN_SECRET_BYTES) {
    throw new PushEnvelopeError(
      'bad-secret',
      `device secret must be at least ${PUSH_MIN_SECRET_BYTES} raw bytes`,
    );
  }
  const derived = hkdfSync(
    'sha256',
    deviceSecret,
    new Uint8Array(0), // zero-length salt — see WARNING 1 in the header
    Buffer.from(PUSH_HKDF_INFO, 'utf8'),
    PUSH_KEY_BYTES,
  );
  return Buffer.from(derived);
}

/**
 * The exact AAD bytes both sides must agree on. Exported because it is the
 * single most likely thing for the Swift port to get wrong.
 */
export function buildPushAad(deviceId: string, ts: number): Buffer {
  assertDeviceId(deviceId);
  assertTimestamp(ts);
  return Buffer.from(
    `${PUSH_AAD_PREFIX}${PUSH_AAD_SEPARATOR}${deviceId}${PUSH_AAD_SEPARATOR}${ts}`,
    'utf8',
  );
}

export interface SealPushOptions {
  /** Raw per-device pairing secret (M3 mints it). Not base64 text. */
  deviceSecret: Uint8Array;
  deviceId: string;
  payload: PushPayload;
  /** Defaults to `Date.now()`. Tests and known-answer vectors pin it. */
  ts?: number;
  /**
   * Nonce override. ONLY for tests and test vectors — reusing a nonce with the
   * same key destroys GCM's security.
   */
  iv?: Uint8Array;
}

/** Encrypt a payload into a v1 envelope. */
export function sealPushEnvelope(opts: SealPushOptions): PushEnvelope {
  const { deviceSecret, deviceId, payload } = opts;
  assertDeviceId(deviceId);

  const ts = opts.ts ?? Date.now();
  assertTimestamp(ts);

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PushEnvelopeError('bad-payload', 'payload must be a plain object');
  }
  if (typeof payload.title !== 'string' || typeof payload.body !== 'string') {
    throw new PushEnvelopeError('bad-payload', 'payload.title and payload.body must be strings');
  }

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  if (plaintext.length > PUSH_MAX_PLAINTEXT_BYTES) {
    throw new PushEnvelopeError(
      'payload-too-large',
      `payload is ${plaintext.length} bytes, limit is ${PUSH_MAX_PLAINTEXT_BYTES}`,
    );
  }

  const iv = opts.iv ? Buffer.from(opts.iv) : randomBytes(PUSH_IV_BYTES);
  if (iv.length !== PUSH_IV_BYTES) {
    throw new PushEnvelopeError('bad-shape', `iv must be ${PUSH_IV_BYTES} bytes`);
  }

  const key = derivePushKey(deviceSecret);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: PUSH_TAG_BYTES });
  cipher.setAAD(buildPushAad(deviceId, ts));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: PUSH_ENVELOPE_VERSION,
    deviceId,
    ts,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export interface OpenPushOptions {
  deviceSecret: Uint8Array;
  /** The receiver's own device id. A mismatch is rejected before any crypto. */
  deviceId: string;
  envelope: unknown;
  /** Defaults to `Date.now()`. */
  now?: number;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
}

/**
 * Verify and decrypt. Throws `PushEnvelopeError` on every rejection path;
 * a tampered byte anywhere in iv/ct/tag/deviceId/ts surfaces as `auth-failed`.
 */
export function openPushEnvelope(opts: OpenPushOptions): PushPayload {
  const { deviceSecret, deviceId, envelope } = opts;
  assertDeviceId(deviceId);

  if (!isPushEnvelope(envelope)) {
    throw new PushEnvelopeError('bad-shape', 'envelope is not a v1 push envelope');
  }
  if (envelope.deviceId !== deviceId) {
    // Structural check on top of the AAD binding: GCM would fail anyway, but a
    // distinct code lets the caller tell misrouting from corruption.
    throw new PushEnvelopeError('device-mismatch', 'envelope was sealed for another device');
  }

  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? PUSH_MAX_AGE_MS;
  const maxFuture = opts.maxFutureSkewMs ?? PUSH_MAX_FUTURE_SKEW_MS;
  if (envelope.ts < now - maxAge) {
    throw new PushEnvelopeError('stale', `envelope is older than ${maxAge}ms`);
  }
  if (envelope.ts > now + maxFuture) {
    throw new PushEnvelopeError('future', `envelope ts is more than ${maxFuture}ms in the future`);
  }

  const iv = decodeStrictBase64(envelope.iv, 'iv', PUSH_IV_BYTES);
  const tag = decodeStrictBase64(envelope.tag, 'tag', PUSH_TAG_BYTES);
  const ct = decodeStrictBase64(envelope.ct, 'ct');

  const key = derivePushKey(deviceSecret);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: PUSH_TAG_BYTES });
  decipher.setAAD(buildPushAad(deviceId, envelope.ts));
  decipher.setAuthTag(tag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // Never echo the underlying OpenSSL text — it varies by build and says nothing useful.
    throw new PushEnvelopeError('auth-failed', 'envelope failed authentication');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new PushEnvelopeError('bad-payload', 'decrypted plaintext is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PushEnvelopeError('bad-payload', 'decrypted payload is not an object');
  }
  const payload = parsed as PushPayload;
  if (typeof payload.title !== 'string' || typeof payload.body !== 'string') {
    throw new PushEnvelopeError('bad-payload', 'decrypted payload is missing title/body');
  }
  return payload;
}

/**
 * The relay's `ciphertext` field: base64 of the envelope JSON, as one opaque
 * string. The whole envelope goes inside — including `deviceId` and `ts` — so
 * the relay operator sees a single blob and cannot even tell which device an
 * APNs token belongs to beyond the token itself.
 *
 * Swift: `String(data: Data(base64Encoded: userInfo["wmux"] as! String)!, encoding: .utf8)`
 * then JSON-decode into the envelope struct, then follow the header's steps 1-4.
 */
export function encodePushEnvelopeForRelay(envelope: PushEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

/** Inverse of {@link encodePushEnvelopeForRelay}. Returns `null` on any junk. */
export function decodePushEnvelopeFromRelay(blob: string): PushEnvelope | null {
  if (typeof blob !== 'string' || !BASE64_PATTERN.test(blob)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(blob, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  return isPushEnvelope(parsed) ? parsed : null;
}

/** Structural guard for an envelope parsed off the wire. */
export function isPushEnvelope(value: unknown): value is PushEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const env = value as Record<string, unknown>;
  if (env.v !== PUSH_ENVELOPE_VERSION) return false;
  if (typeof env.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(env.deviceId)) return false;
  if (!isIntegerTimestamp(env.ts)) return false;
  return typeof env.iv === 'string' && typeof env.ct === 'string' && typeof env.tag === 'string';
}

function assertDeviceId(deviceId: unknown): asserts deviceId is string {
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new PushEnvelopeError(
      'bad-device-id',
      'deviceId must match ' + String(DEVICE_ID_PATTERN),
    );
  }
}

function assertTimestamp(ts: unknown): asserts ts is number {
  if (!isIntegerTimestamp(ts)) {
    throw new PushEnvelopeError('bad-shape', 'ts must be a non-negative integer (epoch ms)');
  }
}

function isIntegerTimestamp(ts: unknown): ts is number {
  return typeof ts === 'number' && Number.isSafeInteger(ts) && ts >= 0;
}

/**
 * Decode base64 and refuse anything non-canonical. Node's Buffer decoder
 * silently skips junk characters, which would let two different strings decode
 * to the same bytes; we round-trip to prove the input was the canonical form.
 */
function decodeStrictBase64(value: string, field: string, expectedBytes?: number): Buffer {
  if (!BASE64_PATTERN.test(value)) {
    throw new PushEnvelopeError('bad-base64', `${field} is not canonical base64`);
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64') !== value) {
    throw new PushEnvelopeError('bad-base64', `${field} is not canonical base64`);
  }
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    throw new PushEnvelopeError('bad-shape', `${field} must decode to ${expectedBytes} bytes`);
  }
  return buf;
}
