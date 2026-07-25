import { describe, it, expect } from 'vitest';

import {
  DEVICE_ID_PATTERN,
  PUSH_ENVELOPE_VERSION,
  PUSH_HKDF_INFO,
  PUSH_IV_BYTES,
  PUSH_MAX_AGE_MS,
  PUSH_MAX_FUTURE_SKEW_MS,
  PUSH_MAX_PLAINTEXT_BYTES,
  PUSH_TAG_BYTES,
  PushEnvelopeError,
  buildPushAad,
  decodePushEnvelopeFromRelay,
  derivePushKey,
  encodePushEnvelopeForRelay,
  isPushEnvelope,
  openPushEnvelope,
  sealPushEnvelope,
  type PushEnvelope,
} from '../pushEnvelope';

const SECRET = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const OTHER_SECRET = Buffer.alloc(32, 0xab);
const DEVICE_ID = 'dev-kat-0001';
const TS = 1753420800000;

/**
 * Known-answer vector, duplicated verbatim in the pushEnvelope.ts header and
 * intended for the Swift NSE unit tests. If this test fails, the wire format
 * changed and every already-shipped iOS build stops decrypting.
 */
const PUSH_KAT = {
  keyHex: '88aee925fdcdc9fb5f87a55895a0cd5928229585208723a5e249526dfb437add',
  iv: 'AQIDBAUGBwgJCgsM',
  ct: 'VwO5KiVWzFM7fSpkP9KEX1rMoi0Vk4OVmBacMffQ1np9k+13BeKVngmpFzq+QFIuIEkzGgCzlAXpuk9yRU12cgeZb5seVoA=',
  tag: 'm9eu9MzvCyHwmNnA3idz5Q==',
  aad: 'wmux:push:v1|dev-kat-0001|1753420800000',
  payload: { title: 'Approval needed', body: 'rm -rf ./build', approvalId: 'ap_1' },
} as const;

function seal(overrides: Partial<Parameters<typeof sealPushEnvelope>[0]> = {}): PushEnvelope {
  return sealPushEnvelope({
    deviceSecret: SECRET,
    deviceId: DEVICE_ID,
    payload: { title: 'Approval needed', body: 'rm -rf ./build' },
    ts: TS,
    ...overrides,
  });
}

function open(envelope: unknown, overrides: Partial<Parameters<typeof openPushEnvelope>[0]> = {}) {
  return openPushEnvelope({
    deviceSecret: SECRET,
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

describe('pushEnvelope — key derivation', () => {
  it('derives the known-answer key (Swift parity anchor)', () => {
    expect(derivePushKey(SECRET).toString('hex')).toBe(PUSH_KAT.keyHex);
  });

  it('is deterministic and secret-dependent', () => {
    expect(derivePushKey(SECRET).equals(derivePushKey(SECRET))).toBe(true);
    expect(derivePushKey(SECRET).equals(derivePushKey(OTHER_SECRET))).toBe(false);
  });

  it('treats a zero-length salt and a 32-zero-byte salt identically (WARNING 1)', async () => {
    const { hkdfSync } = await import('node:crypto');
    const withZeroSalt = Buffer.from(
      hkdfSync('sha256', SECRET, Buffer.alloc(32, 0), Buffer.from(PUSH_HKDF_INFO, 'utf8'), 32),
    );
    expect(withZeroSalt.toString('hex')).toBe(PUSH_KAT.keyHex);
  });

  it('rejects a short secret', () => {
    expectCode(() => derivePushKey(Buffer.alloc(8)), 'bad-secret');
  });
});

describe('pushEnvelope — AAD', () => {
  it('builds the exact known-answer AAD string', () => {
    expect(buildPushAad(DEVICE_ID, TS).toString('utf8')).toBe(PUSH_KAT.aad);
  });

  it('renders ts as a plain decimal integer (WARNING 2)', () => {
    expect(buildPushAad(DEVICE_ID, 1753420800000).toString('utf8')).toContain('|1753420800000');
    expect(buildPushAad(DEVICE_ID, 0).toString('utf8')).toBe('wmux:push:v1|dev-kat-0001|0');
  });

  it('refuses a deviceId containing the separator', () => {
    expectCode(() => buildPushAad('a|b', TS), 'bad-device-id');
    expect(DEVICE_ID_PATTERN.test('a|b')).toBe(false);
  });
});

describe('pushEnvelope — known-answer vector', () => {
  it('seals to the published ciphertext and tag', () => {
    const env = seal({
      payload: { ...PUSH_KAT.payload },
      iv: Buffer.from(PUSH_KAT.iv, 'base64'),
    });
    expect(env).toEqual({
      v: PUSH_ENVELOPE_VERSION,
      deviceId: DEVICE_ID,
      ts: TS,
      iv: PUSH_KAT.iv,
      ct: PUSH_KAT.ct,
      tag: PUSH_KAT.tag,
    });
  });

  it('opens the published ciphertext', () => {
    const env: PushEnvelope = {
      v: PUSH_ENVELOPE_VERSION,
      deviceId: DEVICE_ID,
      ts: TS,
      iv: PUSH_KAT.iv,
      ct: PUSH_KAT.ct,
      tag: PUSH_KAT.tag,
    };
    expect(open(env)).toEqual(PUSH_KAT.payload);
  });
});

describe('pushEnvelope — round trip', () => {
  it('round-trips a payload', () => {
    const payload = { title: 'Approval needed', body: 'rm -rf ./build', approvalId: 'ap_9' };
    expect(open(seal({ payload }))).toEqual(payload);
  });

  it('preserves unknown forward-compatible fields', () => {
    const payload = { title: 't', body: 'b', sessionId: 's1', futureField: { nested: [1, 2] } };
    expect(open(seal({ payload }))).toEqual(payload);
  });

  it('round-trips multibyte UTF-8 and control characters', () => {
    const payload = { title: '승인 필요 ⚠️', body: 'echo "日本語"\n\tdone' };
    expect(open(seal({ payload }))).toEqual(payload);
  });

  it('uses a fresh random nonce per seal', () => {
    const ivs = new Set(Array.from({ length: 16 }, () => seal({ iv: undefined }).iv));
    expect(ivs.size).toBe(16);
  });

  it('emits canonical base64 field shapes', () => {
    const env = seal();
    expect(Buffer.from(env.iv, 'base64')).toHaveLength(PUSH_IV_BYTES);
    expect(Buffer.from(env.tag, 'base64')).toHaveLength(PUSH_TAG_BYTES);
    // Standard alphabet with padding — never base64url (WARNING 3).
    expect(env.iv + env.ct + env.tag).not.toMatch(/[-_]/);
  });

  it('accepts its own output through the structural guard', () => {
    expect(isPushEnvelope(seal())).toBe(true);
    expect(isPushEnvelope(JSON.parse(JSON.stringify(seal())))).toBe(true);
  });
});

describe('pushEnvelope — tamper detection', () => {
  it('rejects a flipped ciphertext byte', () => {
    const env = seal();
    expectCode(() => open({ ...env, ct: flipByte(env.ct, 3) }), 'auth-failed');
  });

  it('rejects a flipped tag byte', () => {
    const env = seal();
    expectCode(() => open({ ...env, tag: flipByte(env.tag, 0) }), 'auth-failed');
  });

  it('rejects a flipped iv byte', () => {
    const env = seal();
    expectCode(() => open({ ...env, iv: flipByte(env.iv, 5) }), 'auth-failed');
  });

  it('rejects a ts rewritten inside the freshness window (AAD binding)', () => {
    const env = seal();
    const moved = { ...env, ts: TS - 1000 };
    expectCode(() => open(moved, { now: TS }), 'auth-failed');
  });

  it('rejects the wrong device secret', () => {
    const env = seal();
    expectCode(() => open(env, { deviceSecret: OTHER_SECRET }), 'auth-failed');
  });
});

describe('pushEnvelope — device binding', () => {
  it('rejects an envelope addressed to another device', () => {
    const env = seal();
    expectCode(() => open(env, { deviceId: 'dev-other-0002' }), 'device-mismatch');
  });

  it('fails authentication when only the AAD device id differs', () => {
    // Same secret, sealed for device A, presented as device B with the id
    // rewritten to match — the AAD no longer reconstructs.
    const env = seal({ deviceId: 'dev-aaa' });
    expectCode(
      () => openPushEnvelope({ deviceSecret: SECRET, deviceId: 'dev-bbb', envelope: { ...env, deviceId: 'dev-bbb' }, now: TS }),
      'auth-failed',
    );
  });

  it('rejects a malformed deviceId at seal time', () => {
    expectCode(() => seal({ deviceId: 'has space' }), 'bad-device-id');
    expectCode(() => seal({ deviceId: '' }), 'bad-device-id');
    expectCode(() => seal({ deviceId: 'x'.repeat(129) }), 'bad-device-id');
  });
});

describe('pushEnvelope — freshness', () => {
  it('accepts an envelope inside the window', () => {
    const env = seal();
    expect(open(env, { now: TS + PUSH_MAX_AGE_MS - 1 })).toBeTruthy();
    expect(open(env, { now: TS - PUSH_MAX_FUTURE_SKEW_MS + 1 })).toBeTruthy();
  });

  it('rejects a stale envelope', () => {
    const env = seal();
    expectCode(() => open(env, { now: TS + PUSH_MAX_AGE_MS + 1 }), 'stale');
  });

  it('rejects an envelope from too far in the future', () => {
    const env = seal();
    expectCode(() => open(env, { now: TS - PUSH_MAX_FUTURE_SKEW_MS - 1 }), 'future');
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

describe('pushEnvelope — malformed input', () => {
  it('rejects non-envelope values', () => {
    for (const bad of [null, undefined, 42, 'str', [], {}]) {
      expectCode(() => open(bad), 'bad-shape');
    }
  });

  it('rejects an unknown version', () => {
    expectCode(() => open({ ...seal(), v: 2 }), 'bad-shape');
    expect(isPushEnvelope({ ...seal(), v: 2 })).toBe(false);
  });

  it('rejects a non-integer ts', () => {
    expect(isPushEnvelope({ ...seal(), ts: 1.5 })).toBe(false);
    expect(isPushEnvelope({ ...seal(), ts: '1753420800000' })).toBe(false);
    expect(isPushEnvelope({ ...seal(), ts: -1 })).toBe(false);
  });

  it('rejects non-canonical base64', () => {
    const env = seal();
    // Node's decoder silently ignores the junk character; we must not.
    expectCode(() => open({ ...env, ct: `${env.ct.slice(0, 4)}*${env.ct.slice(5)}` }), 'bad-base64');
    expectCode(() => open({ ...env, tag: env.tag.replace(/=+$/, '') }), 'bad-base64');
  });

  it('rejects an iv or tag of the wrong length', () => {
    const env = seal();
    expectCode(() => open({ ...env, iv: Buffer.alloc(16).toString('base64') }), 'bad-shape');
    expectCode(() => open({ ...env, tag: Buffer.alloc(8).toString('base64') }), 'bad-shape');
  });

  it('rejects a payload without string title/body', () => {
    expectCode(() => seal({ payload: { title: 1, body: 'b' } as never }), 'bad-payload');
    expectCode(() => seal({ payload: ['a'] as never }), 'bad-payload');
  });

  it('rejects an oversized payload rather than truncating', () => {
    const body = 'x'.repeat(PUSH_MAX_PLAINTEXT_BYTES);
    expectCode(() => seal({ payload: { title: 't', body } }), 'payload-too-large');
  });

});

describe('pushEnvelope — relay blob', () => {
  it('round-trips through the opaque relay encoding', () => {
    const env = seal();
    const blob = encodePushEnvelopeForRelay(env);
    expect(blob).not.toMatch(/[-_]/); // standard base64, not base64url
    expect(decodePushEnvelopeFromRelay(blob)).toEqual(env);
  });

  it('returns null for junk instead of throwing', () => {
    expect(decodePushEnvelopeFromRelay('not*base64')).toBeNull();
    expect(decodePushEnvelopeFromRelay(Buffer.from('{"v":2}').toString('base64'))).toBeNull();
    expect(decodePushEnvelopeFromRelay(Buffer.from('not json').toString('base64'))).toBeNull();
  });

  it('keeps the worst-case blob inside the APNs 4 KB payload budget', () => {
    // Longest legal deviceId + largest legal payload + the relay's aps wrapper.
    const deviceId = 'd'.repeat(128);
    const body = 'x'.repeat(PUSH_MAX_PLAINTEXT_BYTES - 64);
    const env = sealPushEnvelope({
      deviceSecret: SECRET,
      deviceId,
      payload: { title: 't', body },
      ts: TS,
    });
    const blob = encodePushEnvelopeForRelay(env);
    const apnsBody = JSON.stringify({
      aps: { alert: { title: 'wmux', body: 'New activity' }, 'mutable-content': 1, sound: 'default' },
      wmux: blob,
    });
    expect(apnsBody.length).toBeLessThan(4096);
  });
});
