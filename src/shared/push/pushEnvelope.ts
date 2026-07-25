/**
 * The sealed push envelope — the format the daemon writes and the iOS
 * Notification Service Extension reads.
 *
 * The relay that carries it is operated by this project and cannot read any of
 * it: the only plaintext it ever sees is routing metadata (an APNs device
 * token, a size, a timestamp). This file is the single definition of the
 * format so the Node sender and the Swift receiver cannot drift.
 *
 * ── WHY PUBLIC KEY, AND NOT A SHARED SECRET ────────────────────────────────
 * The original design derived one AES key from the device's pairing secret.
 * That could not be built: `DeviceStore` deliberately never persists that
 * secret — `devices.json` holds a scrypt hash and a salt, and the in-memory
 * cache holds a SHA-256 digest — so the daemon has nothing to derive from at
 * send time. Keeping a copy just for push would have turned the roster into a
 * file worth stealing, which is exactly the property the M3 design is built
 * around (it is why its ACL hardening can be deferred at all).
 *
 * So the phone generates an X25519 key pair, keeps the private half in the
 * Keychain, and registers only the public half. The daemon stores a public key,
 * which is not a secret, and the roster stays worthless to anyone who reads it.
 * Each notification also gets a fresh ephemeral sender key, so compromising the
 * daemon later does not decrypt notifications captured earlier.
 *
 * ── WIRE FORMAT ────────────────────────────────────────────────────────────
 *
 *   {
 *     "v":   1,
 *     "deviceId": "…",           // the device this was sealed for
 *     "ts":  1753420800000,      // integer, Unix epoch MILLISECONDS
 *     "epk": "<base64, 32 bytes>",  // ephemeral X25519 public key
 *     "iv":  "<base64, 12 bytes>",
 *     "ct":  "<base64>",
 *     "tag": "<base64, 16 bytes>"
 *   }
 *
 * ── CRYPTO ─────────────────────────────────────────────────────────────────
 *
 *   shared = X25519(ephemeral_private, device_public)
 *   key    = HKDF-SHA256(ikm = shared, salt = "", info = INFO || epk || spk, 32)
 *   aad    = UTF-8("wmux:push:v1|" + deviceId + "|" + ts)
 *   ct,tag = AES-256-GCM(key, iv, aad, plaintext = UTF-8(JSON.stringify(payload)))
 *
 * where INFO is UTF-8("wmux:push:v1"), `epk` is the 32 raw bytes of the
 * ephemeral public key and `spk` the 32 raw bytes of the device's registered
 * public key. Binding both keys into the KDF is what stops a key derived here
 * from being meaningful in any other context.
 *
 * ── HOW SWIFT REPRODUCES THIS (Notification Service Extension) ─────────────
 *
 *   import CryptoKit
 *
 *   // 0. The private key generated at registration, from the Keychain.
 *   let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: keychainBytes)
 *   let spk  = priv.publicKey.rawRepresentation          // the 32 bytes you registered
 *
 *   // 1. Agree, using the ephemeral key from the envelope.
 *   let epkData = Data(base64Encoded: env.epk)!
 *   let epk     = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: epkData)
 *   let shared  = try priv.sharedSecretFromKeyAgreement(with: epk)
 *
 *   // 2. Derive. `salt` is EMPTY; `sharedInfo` is the info string then both keys.
 *   var info = Data("wmux:push:v1".utf8)
 *   info.append(epkData)
 *   info.append(spk)
 *   let key = shared.hkdfDerivedSymmetricKey(
 *       using: SHA256.self, salt: Data(), sharedInfo: info, outputByteCount: 32)
 *
 *   // 3. Open. The AAD must be built with `ts` as an INTEGER.
 *   let aad = Data("wmux:push:v1|\(env.deviceId)|\(env.ts)".utf8)
 *   let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: Data(base64Encoded: env.iv)!),
 *                                   ciphertext: Data(base64Encoded: env.ct)!,
 *                                   tag: Data(base64Encoded: env.tag)!)
 *   let plaintext = try AES.GCM.open(box, using: key, authenticating: aad)
 *
 *   // 4. Reject when `ts` is older than PUSH_MAX_AGE_MS (300_000) or more than
 *   //    PUSH_MAX_FUTURE_SKEW_MS (60_000) ahead, and when `deviceId` is not
 *   //    this device's.
 *
 * ── FIVE WAYS TO BREAK THIS SILENTLY ───────────────────────────────────────
 *
 * 1. **HKDF salt.** It is ZERO LENGTH, not 32 zero bytes. Those happen to agree
 *    here — HMAC-SHA256 pads any key shorter than its 64-byte block with zeros,
 *    so `Data()` and `Data(repeating: 0, count: 32)` derive the same key — but
 *    do not rely on the coincidence.
 * 2. **The timestamp in the AAD.** `ts` MUST be interpolated as an integer.
 *    Swift's default `String(describing:)` of a `Double` yields "1.7534208e+12",
 *    which authenticates nothing. Decode it as `Int64`.
 * 3. **Base64 is standard, WITH padding** — not base64url. Do not translate
 *    "-_" and do not strip "=". This module rejects non-canonical encodings on
 *    the way in, so what Swift receives is always canonical.
 * 4. **`epk` and `spk` go into `sharedInfo` in that order**, raw bytes, no
 *    separator. Swapping them derives a different key and fails authentication
 *    with no other symptom.
 * 5. **`deviceId` is compared byte-for-byte, case-sensitively.** It is a UUID
 *    from the daemon; do not normalize it.
 *
 * Neither JSON key order nor the payload's own key order affects anything: the
 * only order-sensitive bytes are the AAD string and the `sharedInfo` above.
 *
 * ── KNOWN-ANSWER TEST VECTOR ───────────────────────────────────────────────
 * Hardcode this in the Swift unit tests. `pushEnvelope.test.ts` asserts it, so
 * if the format ever changes both sides fail at once instead of in the field.
 * See `PUSH_KAT` at the bottom of this file for the exact values.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

export const PUSH_ENVELOPE_VERSION = 1 as const;

/** HKDF info prefix. The ephemeral and static public keys follow it. */
export const PUSH_HKDF_INFO = 'wmux:push:v1';

export const PUSH_AAD_PREFIX = 'wmux:push:v1';
export const PUSH_AAD_SEPARATOR = '|';

export const PUSH_KEY_BYTES = 32; // AES-256
export const PUSH_IV_BYTES = 12; // 96-bit GCM nonce (the only size CryptoKit accepts without ceremony)
export const PUSH_TAG_BYTES = 16; // 128-bit GCM tag
/** X25519 public and private keys are both 32 raw bytes. */
export const PUSH_X25519_KEY_BYTES = 32;

/**
 * Plaintext cap, derived from the 4096-byte APNs payload limit by walking the
 * JSON and base64 expansion backwards and leaving room for the aps dictionary.
 */
export const PUSH_MAX_PLAINTEXT_BYTES = 1800;

/** A notification delivered after this cannot be decrypted; Apple stops retrying too. */
export const PUSH_MAX_AGE_MS = 5 * 60 * 1000;

/** Tolerance for a sender clock that runs ahead of the receiver. */
export const PUSH_MAX_FUTURE_SKEW_MS = 60 * 1000;

export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Canonical base64 (RFC 4648 §4) with padding. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type PushEnvelopeErrorCode =
  | 'bad-key'
  | 'bad-device-id'
  | 'bad-timestamp'
  | 'bad-payload'
  | 'payload-too-large'
  | 'bad-shape'
  | 'device-mismatch'
  | 'stale'
  | 'future'
  | 'auth-failed';

export class PushEnvelopeError extends Error {
  readonly code: PushEnvelopeErrorCode;
  constructor(code: PushEnvelopeErrorCode, message: string) {
    super(message);
    this.name = 'PushEnvelopeError';
    this.code = code;
  }
}

/**
 * What the extension renders. `title`/`body` are required; anything else rides
 * along so M6 can add fields without a format change.
 */
export interface PushPayload {
  title: string;
  body: string;
  approvalId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

/** The JSON object the relay carries as one opaque `ciphertext` string. */
export interface PushEnvelope {
  v: typeof PUSH_ENVELOPE_VERSION;
  deviceId: string;
  ts: number;
  /** Ephemeral X25519 public key, base64, 32 bytes. */
  epk: string;
  iv: string;
  ct: string;
  tag: string;
}

// ── key handling ───────────────────────────────────────────────────────────

/**
 * Turn the 32 raw bytes a device registered into a key object.
 *
 * Raw is the representation on both sides of the wire: it is what CryptoKit's
 * `rawRepresentation` gives and takes, and carrying SPKI/DER instead would mean
 * the phone had to build ASN.1 to register.
 */
export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (!(raw instanceof Uint8Array) || raw.length !== PUSH_X25519_KEY_BYTES) {
    throw new PushEnvelopeError(
      'bad-key',
      `x25519 public key must be ${PUSH_X25519_KEY_BYTES} raw bytes`,
    );
  }
  try {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') },
      format: 'jwk',
    });
  } catch (err) {
    throw new PushEnvelopeError('bad-key', `not a valid x25519 public key: ${String(err)}`);
  }
}

/** The receiving half, for tests and for anything that opens an envelope. */
export function privateKeyFromRaw(raw: Uint8Array): KeyObject {
  if (!(raw instanceof Uint8Array) || raw.length !== PUSH_X25519_KEY_BYTES) {
    throw new PushEnvelopeError(
      'bad-key',
      `x25519 private key must be ${PUSH_X25519_KEY_BYTES} raw bytes`,
    );
  }
  try {
    // The public half is derivable, but the JWK import wants it spelled out, so
    // round-trip through a temporary key object to get it.
    const tmp = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b656e04220420', 'hex'), // PKCS#8 prefix for X25519
        Buffer.from(raw),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    return tmp;
  } catch (err) {
    throw new PushEnvelopeError('bad-key', `not a valid x25519 private key: ${String(err)}`);
  }
}

/** The 32 raw bytes of a public key, in the form the phone registers. */
export function rawFromPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string') {
    throw new PushEnvelopeError('bad-key', 'key object is not an x25519 public key');
  }
  return Buffer.from(jwk.x, 'base64url');
}

/**
 * HKDF-SHA256 over the ECDH output, binding both public keys.
 *
 * Exported so the Swift parity test has something to compare against, and so a
 * caller can see exactly what goes into the KDF rather than trusting prose.
 */
export function derivePushKey(shared: Uint8Array, epkRaw: Uint8Array, spkRaw: Uint8Array): Buffer {
  const info = Buffer.concat([
    Buffer.from(PUSH_HKDF_INFO, 'utf8'),
    Buffer.from(epkRaw),
    Buffer.from(spkRaw),
  ]);
  return Buffer.from(hkdfSync('sha256', shared, new Uint8Array(0), info, PUSH_KEY_BYTES));
}

/** `wmux:push:v1|<deviceId>|<ts>` as UTF-8. `ts` is an integer, never a float. */
export function buildPushAad(deviceId: string, ts: number): Buffer {
  assertDeviceId(deviceId);
  assertTimestamp(ts);
  return Buffer.from(
    `${PUSH_AAD_PREFIX}${PUSH_AAD_SEPARATOR}${deviceId}${PUSH_AAD_SEPARATOR}${ts}`,
    'utf8',
  );
}

// ── seal ───────────────────────────────────────────────────────────────────

export interface SealPushOptions {
  /** The device's registered X25519 public key, 32 raw bytes. */
  devicePublicKey: Uint8Array;
  deviceId: string;
  payload: PushPayload;
  /** Defaults to `Date.now()`. Tests and known-answer vectors pin it. */
  ts?: number;
  /**
   * Nonce override. ONLY for tests and vectors — reusing a nonce with the same
   * key destroys GCM's security.
   */
  iv?: Uint8Array;
  /**
   * Ephemeral private key override. ONLY for vectors. In production this is
   * generated fresh per envelope, which is what gives forward secrecy.
   */
  ephemeralPrivateKey?: Uint8Array;
}

export function sealPushEnvelope(opts: SealPushOptions): PushEnvelope {
  const { devicePublicKey, deviceId, payload } = opts;
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

  const spk = publicKeyFromRaw(devicePublicKey);
  const spkRaw = Buffer.from(devicePublicKey);

  const ephemeral = opts.ephemeralPrivateKey
    ? privateKeyFromRaw(opts.ephemeralPrivateKey)
    : generateKeyPairSync('x25519').privateKey;
  const epkRaw = rawFromPublicKey(createPublicKey(ephemeral));

  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: ephemeral, publicKey: spk });
  } catch (err) {
    // Node refuses a low-order peer key rather than returning an all-zero
    // shared secret, so a junk registration fails here instead of producing an
    // envelope only a matching junk key could open.
    throw new PushEnvelopeError('bad-key', `key agreement failed: ${String(err)}`);
  }

  const key = derivePushKey(shared, epkRaw, spkRaw);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: PUSH_TAG_BYTES });
  cipher.setAAD(buildPushAad(deviceId, ts));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: PUSH_ENVELOPE_VERSION,
    deviceId,
    ts,
    epk: epkRaw.toString('base64'),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

// ── open ───────────────────────────────────────────────────────────────────

export interface OpenPushOptions {
  /** The device's own X25519 private key, 32 raw bytes. */
  devicePrivateKey: Uint8Array;
  /** The receiver's own device id. A mismatch is rejected before any crypto. */
  deviceId: string;
  envelope: unknown;
  now?: number;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
}

/**
 * Verify and decrypt. Throws `PushEnvelopeError` on every rejection path; a
 * tampered byte anywhere in epk/iv/ct/tag/deviceId/ts surfaces as `auth-failed`.
 */
export function openPushEnvelope(opts: OpenPushOptions): PushPayload {
  const { devicePrivateKey, deviceId, envelope } = opts;
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

  const epkRaw = decodeStrictBase64(envelope.epk, 'epk', PUSH_X25519_KEY_BYTES);
  const iv = decodeStrictBase64(envelope.iv, 'iv', PUSH_IV_BYTES);
  const tag = decodeStrictBase64(envelope.tag, 'tag', PUSH_TAG_BYTES);
  const ct = decodeStrictBase64(envelope.ct, 'ct');

  const priv = privateKeyFromRaw(devicePrivateKey);
  const spkRaw = rawFromPublicKey(createPublicKey(priv));

  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: priv, publicKey: publicKeyFromRaw(epkRaw) });
  } catch {
    throw new PushEnvelopeError('auth-failed', 'envelope failed authentication');
  }

  const key = derivePushKey(shared, epkRaw, spkRaw);
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

// ── relay transport ────────────────────────────────────────────────────────

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
  return (
    env.v === PUSH_ENVELOPE_VERSION &&
    typeof env.deviceId === 'string' &&
    DEVICE_ID_PATTERN.test(env.deviceId) &&
    isIntegerTimestamp(env.ts) &&
    typeof env.epk === 'string' &&
    typeof env.iv === 'string' &&
    typeof env.ct === 'string' &&
    typeof env.tag === 'string'
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function assertDeviceId(deviceId: unknown): asserts deviceId is string {
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new PushEnvelopeError('bad-device-id', 'deviceId is missing or malformed');
  }
}

function assertTimestamp(ts: unknown): asserts ts is number {
  if (!isIntegerTimestamp(ts)) {
    throw new PushEnvelopeError('bad-timestamp', 'ts must be a non-negative integer (epoch ms)');
  }
}

function isIntegerTimestamp(ts: unknown): ts is number {
  return typeof ts === 'number' && Number.isInteger(ts) && ts >= 0;
}

/**
 * Decode base64 and refuse anything non-canonical. `Buffer.from(…, 'base64')`
 * silently ignores junk, so a tampered field would otherwise decode to
 * something shorter and fail later with a confusing error.
 */
function decodeStrictBase64(value: string, field: string, expectedBytes?: number): Buffer {
  if (!BASE64_PATTERN.test(value)) {
    throw new PushEnvelopeError('bad-shape', `${field} is not canonical base64`);
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64') !== value) {
    throw new PushEnvelopeError('bad-shape', `${field} is not canonical base64`);
  }
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    throw new PushEnvelopeError('bad-shape', `${field} must be ${expectedBytes} bytes`);
  }
  return buf;
}

/**
 * The known-answer vector. Hardcode these values in the Swift tests: if this
 * file and the extension ever disagree, both sides fail here rather than in the
 * field, where the only symptom is a notification that silently stays generic.
 *
 * Every value is fixed, including the ephemeral key, so the output is
 * deterministic. Production never pins the ephemeral key.
 */
export const PUSH_KAT = {
  /**
   * The two X25519 private keys are RFC 7748 §6.1's published pair, so their
   * public keys are checkable against the spec instead of against this file.
   * `pushEnvelope.test.ts` asserts that too — it is what proves the raw-bytes
   * key handling here is right and not merely self-consistent.
   */
  devicePrivateKey: 'dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=',
  devicePublicKey: 'hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=',
  /** Pinned so the vector is deterministic. Production never pins this. */
  ephemeralPrivateKey: 'XasIfmJKikt54X+Lg4AO5m87sSkmGLb9HC+LJ/+I4Os=',

  deviceId: '00000000-0000-4000-8000-000000000001',
  ts: 1753420800000,
  payload: { title: 'wmux', body: 'Approve deploy?' },

  /** The envelope those inputs must produce, field for field. */
  epk: '3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=',
  iv: 'AQIDBAUGBwgJCgsM',
  ct: 'eSBqMces8mYavMVQvUXTk5FhnGhcdOFcJ0meYy6ZakFn0XDrrVfKjsY=',
  tag: 'H9uo26R+wV513Zq+V0CJcQ==',
} as const;
