// === LanLink PIN-EKE pairing + reconnect key agreement (PR-4, C4/C5/C7/C9) ===
//
// Construction class: a DOUBLE-MASKED EKE — PIN-bound ephemeral X25519 with HKDF
// key-binding and a mutual key-confirmation MAC. This is NOT SPAKE2/CPace: native
// node:crypto X25519 exposes only scalar-mult (crypto.diffieHellman), not the
// point addition those need. We are precise about the limit (see SECURITY notes
// in the design doc): there is NO offline brute-force from a captured transcript;
// an active same-LAN attacker gets ONE online guess per handshake, hard-bounded
// by the window fail-burn (server-side), MAX_PAKE_IN_FLIGHT, and the <=2min TTL.
//
// The PIN NEVER travels: it appears only as scrypt(PIN) -> mask and in the confirm
// MAC. The wire carries an unmasked ephemeral pubkey (jPub), a masked responder
// pubkey, nonces, and a MAC — none reveal the PIN.
//
// Imports node:crypto + node:util + sibling wire/aead/sanitize only (execute-wall
// clean). No literal control chars in source.

import crypto from 'node:crypto';
import { deriveSessionKeys, type SessionKeys } from './aead';
import { sanitizeRemotePeerName } from './sanitize';

export const PIN_LEN = 6;
export const PAIR_TTL_MS = 120_000; // <=2 min (server enforces with a monotonic clock)
export const PAIR_FAIL_BURN = 5; // window-scoped fail cap (server enforces)
export const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

const NONCE_LEN = 16;
const RAW_PUB_LEN = 32;
const MAC_LEN = 32;
const NAME_WIRE_MAX = 100;
// Fixed 12-byte SPKI prefix for an X25519 raw public key (runtime-verified
// constant). raw32 == export({type:'spki',format:'der'}).subarray(12).
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
// Deterministic-UUID namespace ("lanlink-peers-v5", 16 bytes). uuidv5 over the
// joiner's ephemeral pubkey gives a stable PAIRING id (C9): re-pairing the same
// device UPDATES its record rather than duplicating it.
const LANLINK_NS = Buffer.from('6c616e6c696e6b2d70656572732d7635', 'hex');

const WIRE_VERSION = 1;
const CIPHER_ID = 1;

export class PairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairError';
  }
}

export interface PairResult {
  /** Stable pairing id = uuidv5(joiner ephemeral pubkey). Symmetric: both sides compute the same value. */
  peerUuid: string;
  /** The OTHER party's display name (sanitized). */
  peerName: string;
  /** The shared long-term secret (32 bytes); persisted owner-DACL by both sides. */
  longTermSecret: Buffer;
}

// ── crypto helpers ───────────────────────────────────────────────────────────

function scryptAsync(password: Buffer, salt: Buffer, keylen: number): Promise<Buffer> {
  // scrypt runs on the libuv threadpool (C5) — NEVER scryptSync, which would block
  // the daemon event loop and the machine-local control pipe. maxmem MUST be set
  // explicitly: N=2**15,r=8 needs exactly 32 MiB == the default maxmem and would
  // otherwise throw ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, SCRYPT_PARAMS, (err, dk) => {
      if (err) reject(err);
      else resolve(dk);
    });
  });
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer | string, len: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function rawPubOf(keyObject: crypto.KeyObject): Buffer {
  return keyObject.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length);
}

function pubKeyFromRaw(raw32: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw32]),
    format: 'der',
    type: 'spki',
  });
}

function isAllZero(b: Buffer): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

/**
 * X25519 shared secret with a contributory-behaviour check (C7). A small-order /
 * low-order peer point yields an all-zero shared secret; Node's X25519 already
 * throws on this, and we ALSO reject an all-zero result explicitly. Any failure
 * (bad point, throw, all-zero) collapses to the SAME PairError so a wrong PIN and
 * a malicious point are indistinguishable to the attacker (no oracle).
 */
function x25519Shared(privateKey: crypto.KeyObject, peerRawPub: Buffer): Buffer {
  let shared: Buffer;
  try {
    const publicKey = pubKeyFromRaw(peerRawPub);
    shared = crypto.diffieHellman({ privateKey, publicKey });
  } catch {
    throw new PairError('X25519 key agreement failed');
  }
  if (shared.length !== RAW_PUB_LEN || isAllZero(shared)) {
    throw new PairError('degenerate X25519 shared secret');
  }
  return shared;
}

function xorInto(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/**
 * Whiten bit 255 of a raw X25519 public key before it is PIN-masked (C-crypto
 * fix). A raw X25519 u-coordinate always has bit 255 == 0 (u < 2^255-19); XOR-ing
 * a uniform PIN-derived mask over a value with a deterministic top bit lets a
 * PASSIVE eavesdropper distinguish the correct PIN's unmask (top bit always 0)
 * from a wrong PIN's (top bit 0 only ~50%), leaking ~1 bit of the PIN offline. We
 * OR a fresh random bit into position 255 of the PLAINTEXT key so the masked
 * value is uniformly distributed; RFC7748 ignores bit 255 in the u-coordinate, so
 * the receiver clears it (clearTopBit) before the DH and key agreement is exact.
 */
function whitenTopBit(raw32: Buffer): Buffer {
  const out = Buffer.from(raw32);
  out[31] = (out[31] & 0x7f) | (crypto.randomBytes(1)[0] & 0x80);
  return out;
}

/** Clear bit 255 of a recovered raw X25519 pubkey before the DH (RFC7748-lossless). */
function clearTopBit(raw32: Buffer): Buffer {
  const out = Buffer.from(raw32);
  out[31] &= 0x7f;
  return out;
}

/** Deterministic RFC4122 v5 UUID over `name` in the LanLink namespace (no external dep). */
export function deterministicUuid(name: Buffer | string): string {
  const nameBuf = typeof name === 'string' ? Buffer.from(name, 'utf8') : name;
  const h = crypto.createHash('sha1').update(LANLINK_NS).update(nameBuf).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC4122 variant
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The stable pairing id derived from the joiner's raw ephemeral pubkey (C9). */
export function deterministicPeerUuid(rawJPub32: Buffer): string {
  return deterministicUuid(rawJPub32);
}

// ── name <-> wire ────────────────────────────────────────────────────────────

function nameToWire(name: string): Buffer {
  let b = Buffer.from(name, 'utf8');
  if (b.length > NAME_WIRE_MAX) b = b.subarray(0, NAME_WIRE_MAX);
  return b;
}

function readName(body: Buffer, off: number): { name: string; end: number } {
  if (off >= body.length) throw new PairError('pairing frame truncated (name length)');
  const nameLen = body[off];
  const start = off + 1;
  const end = start + nameLen;
  if (end > body.length) throw new PairError('pairing frame truncated (name)');
  // sanitize on receipt (design §1): strip control/bidi + clamp.
  const name = sanitizeRemotePeerName(body.subarray(start, end).toString('utf8'));
  return { name, end };
}

// ── transcript / session derivation (shared by both roles) ───────────────────

function buildTranscript(helloBody: Buffer, pake2Body: Buffer): Buffer {
  return crypto.createHash('sha256').update(helloBody).update(pake2Body).digest();
}

function deriveSecrets(shared: Buffer, sessionSalt: Buffer, transcript: Buffer): {
  masterSecret: Buffer;
  confirmKey: Buffer;
  longTermSecret: Buffer;
} {
  const masterSecret = hkdf(
    shared,
    sessionSalt,
    Buffer.concat([Buffer.from('wmux-lanlink/v1 master'), transcript]),
    32,
  );
  const confirmKey = hkdf(masterSecret, sessionSalt, 'wmux-lanlink/v1 confirm', 32);
  const longTermSecret = hkdf(masterSecret, sessionSalt, 'wmux-lanlink/v1 longterm', 32);
  return { masterSecret, confirmKey, longTermSecret };
}

function joinerMacOf(confirmKey: Buffer, transcript: Buffer): Buffer {
  return hmac(confirmKey, Buffer.concat([Buffer.from('wmux-lanlink/v1 joiner'), transcript]));
}

function responderMacOf(confirmKey: Buffer, transcript: Buffer): Buffer {
  return hmac(confirmKey, Buffer.concat([Buffer.from('wmux-lanlink/v1 responder'), transcript]));
}

// ── PAKE_HELLO / PAKE2 / CONFIRM body codecs ─────────────────────────────────

function encodeHelloBody(jPub: Buffer, helloNonce: Buffer, selfName: string): Buffer {
  const name = nameToWire(selfName);
  return Buffer.concat([
    Buffer.from([WIRE_VERSION, CIPHER_ID]),
    jPub,
    helloNonce,
    Buffer.from([name.length]),
    name,
  ]);
}

function parseHelloBody(body: Buffer): { jPub: Buffer; helloNonce: Buffer; name: string } {
  // version/cipher are the FIRST two byte reads (C18 downgrade gate) — reject
  // before any crypto.
  if (body.length < 2 + RAW_PUB_LEN + NONCE_LEN + 1) throw new PairError('PAKE_HELLO too short');
  if (body[0] !== WIRE_VERSION) throw new PairError('PAKE_HELLO unsupported wire version');
  if (body[1] !== CIPHER_ID) throw new PairError('PAKE_HELLO unsupported cipher');
  const jPub = body.subarray(2, 2 + RAW_PUB_LEN);
  const helloNonce = body.subarray(2 + RAW_PUB_LEN, 2 + RAW_PUB_LEN + NONCE_LEN);
  const { name } = readName(body, 2 + RAW_PUB_LEN + NONCE_LEN);
  return { jPub: Buffer.from(jPub), helloNonce: Buffer.from(helloNonce), name };
}

function encodePake2Body(respPubMasked: Buffer, respNonce: Buffer, selfName: string): Buffer {
  const name = nameToWire(selfName);
  return Buffer.concat([respPubMasked, respNonce, Buffer.from([name.length]), name]);
}

function parsePake2Body(body: Buffer): { respPubMasked: Buffer; respNonce: Buffer; name: string } {
  if (body.length < RAW_PUB_LEN + NONCE_LEN + 1) throw new PairError('PAKE2 too short');
  const respPubMasked = body.subarray(0, RAW_PUB_LEN);
  const respNonce = body.subarray(RAW_PUB_LEN, RAW_PUB_LEN + NONCE_LEN);
  const { name } = readName(body, RAW_PUB_LEN + NONCE_LEN);
  return {
    respPubMasked: Buffer.from(respPubMasked),
    respNonce: Buffer.from(respNonce),
    name,
  };
}

// ── Responder (the listening side; A in "A shows PIN, B joins") ───────────────

interface ResponderPending {
  shared: Buffer;
  sessionSalt: Buffer;
  helloNonce: Buffer;
  respNonce: Buffer;
  jPubRaw: Buffer;
  helloBody: Buffer;
  pake2Body: Buffer;
  joinerName: string;
}

export class PairingResponder {
  private pending: ResponderPending | null = null;

  constructor(private readonly pin: string, private readonly selfName: string) {}

  /** Process PAKE_HELLO, return the PAKE2 body to send. scrypt runs async (C5). */
  async onHello(helloBody: Buffer): Promise<Buffer> {
    const { jPub, helloNonce, name } = parseHelloBody(helloBody);
    const respEph = crypto.generateKeyPairSync('x25519');
    const respNonce = crypto.randomBytes(NONCE_LEN);
    const sessionSalt = crypto.createHash('sha256').update(helloNonce).update(respNonce).digest();
    const pinKey = await scryptAsync(Buffer.from(this.pin, 'utf8'), sessionSalt, 32);
    const mask = hkdf(pinKey, sessionSalt, 'wmux-lanlink/v1 mask', RAW_PUB_LEN);
    // DH: any failure (bad/low-order point, all-zero) -> PairError, unified with a
    // wrong-PIN failure by the server (C7).
    const shared = x25519Shared(respEph.privateKey, jPub);
    // Whiten the biased top bit BEFORE masking (no offline-distinguisher leak).
    const rPubRaw = whitenTopBit(rawPubOf(respEph.publicKey));
    const respPubMasked = xorInto(rPubRaw, mask);
    const pake2Body = encodePake2Body(respPubMasked, respNonce, this.selfName);
    this.pending = {
      shared,
      sessionSalt,
      helloNonce,
      respNonce,
      jPubRaw: jPub,
      helloBody: Buffer.from(helloBody),
      pake2Body,
      joinerName: name,
    };
    return pake2Body;
  }

  /**
   * Verify the joiner's CONFIRM MAC. On success returns the PairResult, the
   * responder's MAC (to send as the FIRST AEAD record plaintext, C18), and the
   * material the server needs to build the AEAD session. THROWS PairError on a
   * MAC mismatch (the server treats this identically to any handshake failure).
   */
  onConfirm(confirmBody: Buffer): {
    result: PairResult;
    respMac: Buffer;
    sessionKeys: SessionKeys;
    helloNonce: Buffer;
    respNonce: Buffer;
  } {
    if (!this.pending) throw new PairError('CONFIRM before PAKE_HELLO');
    if (confirmBody.length !== MAC_LEN) throw new PairError('CONFIRM wrong length');
    const p = this.pending;
    const transcript = buildTranscript(p.helloBody, p.pake2Body);
    const { confirmKey, longTermSecret } = deriveSecrets(p.shared, p.sessionSalt, transcript);
    const expected = joinerMacOf(confirmKey, transcript);
    // length-check first (timingSafeEqual throws on unequal length), no structural
    // short-circuit before the constant-time compare.
    if (confirmBody.length !== expected.length || !crypto.timingSafeEqual(confirmBody, expected)) {
      throw new PairError('CONFIRM MAC mismatch');
    }
    const respMac = responderMacOf(confirmKey, transcript);
    // Pairing ephemerals double as the session ephemerals: ee = shared (C2/§5).
    const sessionKeys = deriveSessionKeys(longTermSecret, p.shared, p.helloNonce, p.respNonce);
    const result: PairResult = {
      peerUuid: deterministicPeerUuid(p.jPubRaw),
      peerName: p.joinerName,
      longTermSecret,
    };
    return { result, respMac, sessionKeys, helloNonce: p.helloNonce, respNonce: p.respNonce };
  }
}

// ── Initiator (the joining side; B enters PIN, connects to A) ─────────────────

export interface PendingJoin {
  jPriv: crypto.KeyObject;
  jPubRaw: Buffer;
  helloNonce: Buffer;
  pin: string;
  helloBody: Buffer;
}

export interface JoinPending2 {
  longTermSecret: Buffer;
  confirmKey: Buffer;
  transcript: Buffer;
  peerUuid: string;
  peerName: string;
  sessionKeys: SessionKeys;
}

export class PairingInitiator {
  private j: PendingJoin | null = null;

  constructor(private readonly pin: string, private readonly selfName: string) {}

  /** Build PAKE_HELLO (jPub UNMASKED + helloNonce + name). */
  hello(): Buffer {
    const eph = crypto.generateKeyPairSync('x25519');
    const jPubRaw = rawPubOf(eph.publicKey);
    const helloNonce = crypto.randomBytes(NONCE_LEN);
    const helloBody = encodeHelloBody(jPubRaw, helloNonce, this.selfName);
    this.j = { jPriv: eph.privateKey, jPubRaw, helloNonce, pin: this.pin, helloBody };
    return helloBody;
  }

  /** Process PAKE2, return the CONFIRM body + pending state for verifyRespMac. */
  async onPake2(pake2Body: Buffer): Promise<{ confirm: Buffer; pending: JoinPending2 }> {
    if (!this.j) throw new PairError('PAKE2 before PAKE_HELLO');
    const j = this.j;
    const { respPubMasked, respNonce, name } = parsePake2Body(pake2Body);
    const sessionSalt = crypto.createHash('sha256').update(j.helloNonce).update(respNonce).digest();
    const pinKey = await scryptAsync(Buffer.from(j.pin, 'utf8'), sessionSalt, 32);
    const mask = hkdf(pinKey, sessionSalt, 'wmux-lanlink/v1 mask', RAW_PUB_LEN);
    // Unmask, then clear the whitened top bit before the DH (RFC7748-lossless).
    const rPubRaw = clearTopBit(xorInto(respPubMasked, mask));
    const shared = x25519Shared(j.jPriv, rPubRaw); // wrong PIN -> wrong rPub -> degenerate/wrong shared
    const transcript = buildTranscript(j.helloBody, pake2Body);
    const { confirmKey, longTermSecret } = deriveSecrets(shared, sessionSalt, transcript);
    const confirm = joinerMacOf(confirmKey, transcript);
    const sessionKeys = deriveSessionKeys(longTermSecret, shared, j.helloNonce, respNonce);
    const pending: JoinPending2 = {
      longTermSecret,
      confirmKey,
      transcript,
      peerUuid: deterministicPeerUuid(j.jPubRaw),
      peerName: name,
      sessionKeys,
    };
    return { confirm, pending };
  }

  /** Verify the responder's MAC (decrypted from the first AEAD record). */
  verifyRespMac(plaintext: Buffer, pending: JoinPending2): PairResult {
    const expected = responderMacOf(pending.confirmKey, pending.transcript);
    if (plaintext.length !== expected.length || !crypto.timingSafeEqual(plaintext, expected)) {
      throw new PairError('responder MAC mismatch');
    }
    return {
      peerUuid: pending.peerUuid,
      peerName: pending.peerName,
      longTermSecret: pending.longTermSecret,
    };
  }
}

// ── Reconnect (known peer, ephemeral DH, NO scrypt — C3) ──────────────────────
//
// Like the PAKE codecs, these return the frame BODY only — the server wraps each
// in encodeFrame(0x04 / 0x05). No scrypt, no PIN: a fresh ephemeral DH bound into
// the stored long-term secret yields a unique session key per reconnect (C2).

export function encodeReconnectHelloBody(peerUuid: string, ephPubRaw: Buffer, connNonce: Buffer): Buffer {
  const uuidBytes = Buffer.from(peerUuid.replace(/-/g, ''), 'hex'); // 16 bytes
  return Buffer.concat([Buffer.from([WIRE_VERSION, CIPHER_ID]), uuidBytes, ephPubRaw, connNonce]);
}

export function parseReconnectHello(body: Buffer): { peerUuid: string; ephPubRaw: Buffer; connNonce: Buffer } {
  if (body.length < 2 + 16 + RAW_PUB_LEN + NONCE_LEN) throw new PairError('RECONNECT_HELLO too short');
  if (body[0] !== WIRE_VERSION) throw new PairError('RECONNECT_HELLO unsupported wire version');
  if (body[1] !== CIPHER_ID) throw new PairError('RECONNECT_HELLO unsupported cipher');
  const uuidHex = body.subarray(2, 18).toString('hex');
  const peerUuid = `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20, 32)}`;
  const ephPubRaw = Buffer.from(body.subarray(18, 18 + RAW_PUB_LEN));
  const connNonce = Buffer.from(body.subarray(18 + RAW_PUB_LEN, 18 + RAW_PUB_LEN + NONCE_LEN));
  return { peerUuid, ephPubRaw, connNonce };
}

export function encodeReconnect2Body(ephPubRaw: Buffer, respNonce: Buffer): Buffer {
  return Buffer.concat([ephPubRaw, respNonce]);
}

export function parseReconnect2Body(body: Buffer): { ephPubRaw: Buffer; respNonce: Buffer } {
  if (body.length < RAW_PUB_LEN + NONCE_LEN) throw new PairError('RECONNECT2 too short');
  return {
    ephPubRaw: Buffer.from(body.subarray(0, RAW_PUB_LEN)),
    respNonce: Buffer.from(body.subarray(RAW_PUB_LEN, RAW_PUB_LEN + NONCE_LEN)),
  };
}

/** Responder side of reconnect: fresh ephemeral DH (no scrypt) -> session keys. */
export function reconnectResponder(
  longTermSecret: Buffer,
  peerEphPubRaw: Buffer,
  connNonce: Buffer,
): { sessionKeys: SessionKeys; reconnect2Body: Buffer } {
  const eph = crypto.generateKeyPairSync('x25519');
  const respNonce = crypto.randomBytes(NONCE_LEN);
  const ee = x25519Shared(eph.privateKey, peerEphPubRaw);
  const sessionKeys = deriveSessionKeys(longTermSecret, ee, connNonce, respNonce);
  return { sessionKeys, reconnect2Body: encodeReconnect2Body(rawPubOf(eph.publicKey), respNonce) };
}

/** Initiator side of reconnect: build the hello body, then finish with RECONNECT2. */
export class ReconnectInitiator {
  private eph: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } | null = null;
  private connNonce: Buffer | null = null;

  constructor(private readonly peerUuid: string, private readonly longTermSecret: Buffer) {}

  hello(): Buffer {
    const eph = crypto.generateKeyPairSync('x25519');
    this.eph = eph;
    this.connNonce = crypto.randomBytes(NONCE_LEN);
    return encodeReconnectHelloBody(this.peerUuid, rawPubOf(eph.publicKey), this.connNonce);
  }

  onReconnect2(body: Buffer): SessionKeys {
    if (!this.eph || !this.connNonce) throw new PairError('RECONNECT2 before hello');
    const { ephPubRaw, respNonce } = parseReconnect2Body(body);
    const ee = x25519Shared(this.eph.privateKey, ephPubRaw);
    return deriveSessionKeys(this.longTermSecret, ee, this.connNonce, respNonce);
  }
}
