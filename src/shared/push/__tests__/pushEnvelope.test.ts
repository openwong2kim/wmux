import { describe, it, expect } from 'vitest';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import {
  DEVICE_ID_PATTERN,
  PUSH_ENVELOPE_VERSION,
  PUSH_IV_BYTES,
  PUSH_KAT,
  PUSH_MAX_AGE_MS,
  PUSH_MAX_FUTURE_SKEW_MS,
  PUSH_MAX_PLAINTEXT_BYTES,
  PUSH_TAG_BYTES,
  PUSH_X25519_KEY_BYTES,
  PushEnvelopeError,
  buildPushAad,
  decodePushEnvelopeFromRelay,
  encodePushEnvelopeForRelay,
  isPushEnvelope,
  openPushEnvelope,
  privateKeyFromRaw,
  publicKeyFromRaw,
  rawFromPublicKey,
  sealPushEnvelope,
  type PushEnvelope,
} from '../pushEnvelope';

const DEVICE_PRIV = Buffer.from(PUSH_KAT.devicePrivateKey, 'base64');
const DEVICE_PUB = Buffer.from(PUSH_KAT.devicePublicKey, 'base64');
const EPH_PRIV = Buffer.from(PUSH_KAT.ephemeralPrivateKey, 'base64');
const DEVICE_ID = PUSH_KAT.deviceId;
const TS = PUSH_KAT.ts;

/** 32 raw private bytes of a generated pair. */
function rawPrivate(pair: { privateKey: { export: (o: { format: 'jwk' }) => unknown } }): Buffer {
  const jwk = pair.privateKey.export({ format: 'jwk' }) as { d?: string };
  return Buffer.from(jwk.d as string, 'base64url');
}

const OTHER = generateKeyPairSync('x25519');
const OTHER_PUB = rawFromPublicKey(OTHER.publicKey);
const OTHER_PRIV = rawPrivate(OTHER);

function seal(overrides: Partial<Parameters<typeof sealPushEnvelope>[0]> = {}): PushEnvelope {
  return sealPushEnvelope({
    devicePublicKey: DEVICE_PUB,
    deviceId: DEVICE_ID,
    payload: { title: 'Approval needed', body: 'rm -rf ./build' },
    ts: TS,
    ...overrides,
  });
}

function open(envelope: unknown, overrides: Partial<Parameters<typeof openPushEnvelope>[0]> = {}) {
  return openPushEnvelope({
    devicePrivateKey: DEVICE_PRIV,
    deviceId: DEVICE_ID,
    envelope,
    now: TS,
    ...overrides,
  });
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PushEnvelopeError);
    expect((err as PushEnvelopeError).code).toBe(code);
    return;
  }
  throw new Error(`expected PushEnvelopeError(${code}) but nothing was thrown`);
}

/** Flip one bit of a base64 field without changing its decoded length. */
function flipByte(b64: string, index: number): string {
  const buf = Buffer.from(b64, 'base64');
  buf[index] ^= 0x01;
  return buf.toString('base64');
}

describe('pushEnvelope — x25519 key handling', () => {
  it('★ parses raw private keys correctly, checked against RFC 7748 §6.1', () => {
    // The published pair. This proves the PKCS#8 wrapping in privateKeyFromRaw
    // is right against the SPEC rather than against ourselves — a
    // self-consistent bug here would round-trip happily and fail only on a
    // real phone, which is the one place it would cost a shipped build.
    const alicePub = rawFromPublicKey(createPublicKey(privateKeyFromRaw(DEVICE_PRIV)));
    const bobPub = rawFromPublicKey(createPublicKey(privateKeyFromRaw(EPH_PRIV)));
    expect(alicePub.toString('hex')).toBe(
      '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    );
    expect(bobPub.toString('hex')).toBe(
      'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
    );
    // …and the vector's public key is that same value, so the KAT is anchored
    // to the spec too rather than to whatever this file happened to produce.
    expect(alicePub.equals(DEVICE_PUB)).toBe(true);
  });

  it('round-trips a raw public key', () => {
    expect(rawFromPublicKey(publicKeyFromRaw(DEVICE_PUB)).equals(DEVICE_PUB)).toBe(true);
    expect(PUSH_X25519_KEY_BYTES).toBe(32);
  });

  it('refuses a key of the wrong length', () => {
    expectCode(() => publicKeyFromRaw(Buffer.alloc(31)), 'bad-key');
    expectCode(() => publicKeyFromRaw(Buffer.alloc(33)), 'bad-key');
    expectCode(() => privateKeyFromRaw(Buffer.alloc(16)), 'bad-key');
  });

  it('★ refuses to seal to an all-zero public key', () => {
    // A low-order point agrees to an all-zero shared secret that any holder of
    // a matching junk key could reproduce. Node refuses the agreement rather
    // than returning it, and that must surface as a refusal to seal instead of
    // an envelope that looks fine.
    expectCode(() => seal({ devicePublicKey: Buffer.alloc(32) }), 'bad-key');
  });
});

describe('pushEnvelope — AAD', () => {
  it('builds the exact known-answer AAD string', () => {
    expect(buildPushAad(DEVICE_ID, TS).toString('utf8')).toBe(`wmux:push:v1|${DEVICE_ID}|${TS}`);
  });

  it('renders ts as a plain decimal integer (WARNING 2)', () => {
    // "1.7534208e+12" authenticates nothing, and it is the single most likely
    // Swift-side mistake.
    const aad = buildPushAad(DEVICE_ID, TS).toString('utf8');
    expect(aad).toContain('|1753420800000');
    expect(aad).not.toContain('e+');
    expect(buildPushAad(DEVICE_ID, 0).toString('utf8')).toBe(`wmux:push:v1|${DEVICE_ID}|0`);
  });

  it('refuses a non-integer or negative ts', () => {
    expectCode(() => buildPushAad(DEVICE_ID, 1.5), 'bad-timestamp');
    expectCode(() => buildPushAad(DEVICE_ID, -1), 'bad-timestamp');
  });

  it('refuses a deviceId containing the separator', () => {
    expect(DEVICE_ID_PATTERN.test('a|b')).toBe(false);
    expectCode(() => buildPushAad('a|b', TS), 'bad-device-id');
  });
});

describe('pushEnvelope — known-answer vector', () => {
  it('★ seals to the published envelope, field for field', () => {
    const env = seal({
      payload: { ...PUSH_KAT.payload },
      iv: Buffer.from(PUSH_KAT.iv, 'base64'),
      ephemeralPrivateKey: EPH_PRIV,
    });
    expect(env).toEqual({
      v: PUSH_ENVELOPE_VERSION,
      deviceId: PUSH_KAT.deviceId,
      ts: PUSH_KAT.ts,
      epk: PUSH_KAT.epk,
      iv: PUSH_KAT.iv,
      ct: PUSH_KAT.ct,
      tag: PUSH_KAT.tag,
    });
  });

  it('★ opens the published envelope', () => {
    const env: PushEnvelope = {
      v: PUSH_ENVELOPE_VERSION,
      deviceId: PUSH_KAT.deviceId,
      ts: PUSH_KAT.ts,
      epk: PUSH_KAT.epk,
      iv: PUSH_KAT.iv,
      ct: PUSH_KAT.ct,
      tag: PUSH_KAT.tag,
    };
    expect(open(env)).toEqual(PUSH_KAT.payload);
  });
});

describe('pushEnvelope — round trip', () => {
  it('round-trips a payload', () => {
    expect(open(seal())).toEqual({ title: 'Approval needed', body: 'rm -rf ./build' });
  });

  it('preserves unknown forward-compatible fields', () => {
    const payload = { title: 't', body: 'b', approvalId: 'ap_9', future: { nested: [1, 2] } };
    expect(open(seal({ payload }))).toEqual(payload);
  });

  it('round-trips multibyte UTF-8 and control characters', () => {
    const payload = { title: '승인 필요 🔐', body: 'line1\nline2\ttab' };
    expect(open(seal({ payload }))).toEqual(payload);
  });

  it('★ uses a fresh ephemeral key AND nonce per seal', () => {
    // Forward secrecy rests on the ephemeral key never repeating, and a fixed
    // one would still round-trip — only this catches it.
    const a = seal();
    const b = seal();
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('emits canonical base64 field shapes', () => {
    const env = seal();
    expect(Buffer.from(env.epk, 'base64')).toHaveLength(PUSH_X25519_KEY_BYTES);
    expect(Buffer.from(env.iv, 'base64')).toHaveLength(PUSH_IV_BYTES);
    expect(Buffer.from(env.tag, 'base64')).toHaveLength(PUSH_TAG_BYTES);
    // Standard alphabet with padding, never base64url (WARNING 3).
    for (const field of [env.epk, env.iv, env.ct, env.tag]) {
      expect(field).not.toMatch(/[-_]/);
    }
  });

  it('accepts its own output through the structural guard', () => {
    expect(isPushEnvelope(seal())).toBe(true);
  });
});

describe('pushEnvelope — tamper detection', () => {
  it('rejects a flipped ciphertext byte', () => {
    const env = seal();
    expectCode(() => open({ ...env, ct: flipByte(env.ct, 0) }), 'auth-failed');
  });

  it('rejects a flipped tag byte', () => {
    const env = seal();
    expectCode(() => open({ ...env, tag: flipByte(env.tag, 0) }), 'auth-failed');
  });

  it('rejects a flipped iv byte', () => {
    const env = seal();
    expectCode(() => open({ ...env, iv: flipByte(env.iv, 0) }), 'auth-failed');
  });

  it('★ rejects a swapped ephemeral key', () => {
    // `epk` is not covered by the GCM tag directly — it is bound through the
    // KDF. Swapping it derives a different key, so it must still fail.
    const env = seal();
    const other = seal();
    expectCode(() => open({ ...env, epk: other.epk }), 'auth-failed');
  });

  it('rejects a ts rewritten inside the freshness window (AAD binding)', () => {
    const env = seal();
    expectCode(() => open({ ...env, ts: TS + 1 }, { now: TS + 1 }), 'auth-failed');
  });

  it('rejects the wrong device private key', () => {
    expectCode(() => open(seal(), { devicePrivateKey: OTHER_PRIV }), 'auth-failed');
  });

  it('an envelope sealed to another device key does not open here', () => {
    const env = sealPushEnvelope({
      devicePublicKey: OTHER_PUB,
      deviceId: DEVICE_ID,
      payload: { title: 't', body: 'b' },
      ts: TS,
    });
    expectCode(() => open(env), 'auth-failed');
  });
});

describe('pushEnvelope — device binding', () => {
  it('rejects an envelope addressed to another device', () => {
    expectCode(() => open(seal(), { deviceId: 'someone-else' }), 'device-mismatch');
  });

  it('rejects a malformed deviceId at seal time', () => {
    expectCode(() => seal({ deviceId: 'has|pipe' }), 'bad-device-id');
    expectCode(() => seal({ deviceId: '' }), 'bad-device-id');
  });
});

describe('pushEnvelope — freshness', () => {
  it('accepts an envelope inside the window', () => {
    const env = seal();
    expect(open(env, { now: TS + PUSH_MAX_AGE_MS - 1 })).toBeTruthy();
    expect(open(env, { now: TS - PUSH_MAX_FUTURE_SKEW_MS + 1 })).toBeTruthy();
  });

  it('rejects a stale envelope', () => {
    expectCode(() => open(seal(), { now: TS + PUSH_MAX_AGE_MS + 1 }), 'stale');
  });

  it('rejects an envelope from too far in the future', () => {
    expectCode(() => open(seal(), { now: TS - PUSH_MAX_FUTURE_SKEW_MS - 1 }), 'future');
  });

  it('honours caller-supplied windows', () => {
    const env = seal();
    expectCode(() => open(env, { now: TS + 2, maxAgeMs: 1 }), 'stale');
    expect(open(env, { now: TS + 10_000_000, maxAgeMs: Number.MAX_SAFE_INTEGER })).toBeTruthy();
  });

  it('checks freshness before spending crypto on a corrupt body', () => {
    const env = seal();
    expectCode(() => open({ ...env, ct: 'AAAA' }, { now: TS + PUSH_MAX_AGE_MS + 1 }), 'stale');
  });
});

describe('pushEnvelope — shape and limits', () => {
  it('rejects an oversized payload before encrypting', () => {
    expectCode(
      () => seal({ payload: { title: 't', body: 'x'.repeat(PUSH_MAX_PLAINTEXT_BYTES) } }),
      'payload-too-large',
    );
  });

  it('requires title and body', () => {
    expectCode(() => seal({ payload: { title: 't' } as never }), 'bad-payload');
    expectCode(() => seal({ payload: { body: 'b' } as never }), 'bad-payload');
  });

  it('rejects non-canonical base64 on the way in', () => {
    const env = seal();
    // Deterministic: a random iv may contain no `+` at all, so a
    // replace(/\+/g,'-') would be a no-op and the test would assert nothing.
    expectCode(() => open({ ...env, iv: `-${env.iv.slice(1)}` }), 'bad-shape');
    // Trailing bits that do not survive a re-encode — `Buffer.from` accepts
    // these silently, which is why the re-encode comparison exists.
    expectCode(() => open({ ...env, tag: `${env.tag.slice(0, -2)}z=` }), 'bad-shape');
  });

  it('rejects an epk of the wrong length', () => {
    const env = seal();
    expectCode(() => open({ ...env, epk: Buffer.alloc(31).toString('base64') }), 'bad-shape');
  });

  it('rejects non-envelope values', () => {
    for (const bad of [null, undefined, 42, 'str', [], {}]) {
      expectCode(() => open(bad), 'bad-shape');
    }
  });

  it('rejects an unknown version', () => {
    expectCode(() => open({ ...seal(), v: 2 }), 'bad-shape');
    expect(isPushEnvelope({ ...seal(), v: 2 })).toBe(false);
  });
});

describe('pushEnvelope — relay transport', () => {
  it('round-trips through the relay blob encoding', () => {
    const env = seal();
    expect(decodePushEnvelopeFromRelay(encodePushEnvelopeForRelay(env))).toEqual(env);
  });

  it('the blob is standard base64, which is what the relay validates', () => {
    expect(encodePushEnvelopeForRelay(seal())).not.toMatch(/[-_]/);
  });

  it('returns null for junk rather than throwing', () => {
    expect(decodePushEnvelopeFromRelay('not base64!!')).toBeNull();
    expect(decodePushEnvelopeFromRelay(Buffer.from('{}').toString('base64'))).toBeNull();
  });
});
