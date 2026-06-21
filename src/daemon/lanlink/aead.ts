// === LanLink AEAD channel (PR-4, chacha20-poly1305 IETF) ===
//
// Native node:crypto only. XChaCha20 (192-bit nonce) is NOT native — we use the
// IETF chacha20-poly1305 (96-bit / 12-byte nonce, 16-byte tag, 32-byte key).
//
// THE CRUX (C2): session keys derive from a FRESH per-connection ephemeral X25519
// DH (`ee`), never a pure function of (longTermSecret, nonces). With the counter
// reset to 1 on every connection, a key that was a pure function of long-term
// material + nonces would re-use (key, nonce=1) whenever the nonces collided —
// a two-time pad + Poly1305-key disclosure. Binding fresh `ee` makes every
// connection's key unique even if both nonces AND the RNG collide.

import crypto from 'node:crypto';

export const AEAD_KEY_LEN = 32;
export const AEAD_NONCE_LEN = 12;
export const AEAD_TAG_LEN = 16;
export const COUNTER_MAX = 2n ** 63n; // C17 overflow ceiling (fits a signed-safe u64 window)

const COUNTER_BYTES = 8;
const HKDF_HASH = 'sha256';
const AEAD_VERSION_BYTE = 1; // mirrors wire.WIRE_VERSION; part of the AEAD AAD
const AEAD_CIPHER_BYTE = 1; // mirrors wire.CIPHER_ID; part of the AEAD AAD

/** 1 = client->server (c2s), 2 = server->client (s2c). */
export type Direction = 1 | 2;

export interface SessionKeys {
  c2sKey: Buffer;
  s2cKey: Buffer;
}

export class AeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AeadError';
  }
}

/** HKDF-SHA256 returning a Buffer (hkdfSync yields an ArrayBuffer — MUST wrap). */
function hkdf(ikm: Buffer, salt: Buffer, info: string, len: number): Buffer {
  return Buffer.from(crypto.hkdfSync(HKDF_HASH, ikm, salt, info, len));
}

/**
 * The ONLY factory for SessionKeys (C2 hard invariant). It CONSUMES the fresh
 * per-connection ephemeral DH output `ee`, so a fresh AeadSealer/AeadOpener
 * (counter reset to 1) is always backed by single-use key material. Direction
 * separation is by KEY (distinct HKDF labels c2s/s2c), the load-bearing
 * guarantee; the nonce direction tag is defense-in-depth.
 */
export function deriveSessionKeys(
  longTermSecret: Buffer,
  ee: Buffer,
  helloNonce: Buffer,
  respNonce: Buffer,
): SessionKeys {
  const sessionIkm = hkdf(
    longTermSecret,
    Buffer.concat([ee, helloNonce, respNonce]),
    'wmux-lanlink/v1 session',
    32,
  );
  return {
    c2sKey: hkdf(sessionIkm, ee, 'wmux-lanlink/v1 c2s', AEAD_KEY_LEN),
    s2cKey: hkdf(sessionIkm, ee, 'wmux-lanlink/v1 s2c', AEAD_KEY_LEN),
  };
}

/** nonce(12B) = directionTag(u32be) || counter(u64be). */
function nonceFor(direction: Direction, counter: bigint): Buffer {
  const n = Buffer.alloc(AEAD_NONCE_LEN);
  n.writeUInt32BE(direction, 0);
  n.writeBigUInt64BE(counter, 4);
  return n;
}

/** AAD binds version || cipherId || direction || counter (C17). */
function aadFor(direction: Direction, counter: bigint): Buffer {
  const aad = Buffer.alloc(3 + COUNTER_BYTES);
  aad.writeUInt8(AEAD_VERSION_BYTE, 0);
  aad.writeUInt8(AEAD_CIPHER_BYTE, 1);
  aad.writeUInt8(direction, 2);
  aad.writeBigUInt64BE(counter, 3);
  return aad;
}

/** Outbound sealer. Counter starts at 1; record = [u64be counter][ct][16B tag]. */
export class AeadSealer {
  private counter = 0n;

  constructor(private readonly key: Buffer, private readonly direction: Direction) {
    if (key.length !== AEAD_KEY_LEN) throw new AeadError('AEAD seal key must be 32 bytes');
  }

  seal(plaintext: Buffer): Buffer {
    const counter = this.counter + 1n;
    if (counter > COUNTER_MAX) throw new AeadError('AEAD counter overflow'); // BEFORE nonce derive (C17)
    const nonce = nonceFor(this.direction, counter);
    const aad = aadFor(this.direction, counter);
    const cipher = crypto.createCipheriv('chacha20-poly1305', this.key, nonce, {
      authTagLength: AEAD_TAG_LEN,
    });
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.counter = counter; // advance only after a successful seal
    const header = Buffer.alloc(COUNTER_BYTES);
    header.writeBigUInt64BE(counter, 0);
    return Buffer.concat([header, ct, tag]);
  }
}

/** Inbound opener. Drops a non-increasing counter (replay) BEFORE deciphering. */
export class AeadOpener {
  private lastCounter = 0n;

  constructor(private readonly key: Buffer, private readonly direction: Direction) {
    if (key.length !== AEAD_KEY_LEN) throw new AeadError('AEAD open key must be 32 bytes');
  }

  open(record: Buffer): Buffer {
    if (record.length < COUNTER_BYTES + AEAD_TAG_LEN) {
      throw new AeadError('AEAD record too short');
    }
    const counter = record.readBigUInt64BE(0);
    // Replay defense: counter check BEFORE any decipher work, and lastCounter is
    // advanced ONLY after final() succeeds (C17) — so a tag/AAD failure can never
    // poison the high-water mark and let a real next record be wrongly dropped.
    if (counter <= this.lastCounter) {
      throw new AeadError('AEAD counter not strictly increasing (replay)');
    }
    if (counter > COUNTER_MAX) throw new AeadError('AEAD counter exceeds max');
    const tag = record.subarray(record.length - AEAD_TAG_LEN);
    const ct = record.subarray(COUNTER_BYTES, record.length - AEAD_TAG_LEN);
    const nonce = nonceFor(this.direction, counter);
    const aad = aadFor(this.direction, counter);
    const decipher = crypto.createDecipheriv('chacha20-poly1305', this.key, nonce, {
      authTagLength: AEAD_TAG_LEN,
    });
    decipher.setAAD(aad, { plaintextLength: ct.length });
    decipher.setAuthTag(tag);
    let pt: Buffer;
    try {
      pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new AeadError('AEAD tag verification failed'); // lastCounter UNCHANGED
    }
    this.lastCounter = counter;
    return pt;
  }
}
