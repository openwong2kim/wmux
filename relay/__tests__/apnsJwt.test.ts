import { describe, it, expect, beforeAll } from 'vitest';

import {
  TOKEN_MAX_AGE_MS,
  createApnsTokenProvider,
  decodeP8ToPkcs8,
  importApnsKey,
  signApnsJwt,
} from '../src/apnsJwt';

const KEY_ID = 'ABCD123456';
const TEAM_ID = 'TEAM123456';

/**
 * A throwaway P-256 key generated at test time. Nothing resembling a real .p8
 * is committed to the repo — a checked-in test key trips secret scanners and
 * teaches the wrong habit.
 */
let testKeyP8 = '';
let testPublicKey: CryptoKey;

function toPem(der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

function decodeJwtPart(part: string): Record<string, unknown> {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function decodeJwtSignature(part: string): Uint8Array {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  testKeyP8 = toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  testPublicKey = pair.publicKey;
});

describe('decodeP8ToPkcs8', () => {
  it('strips PEM armour', () => {
    expect(decodeP8ToPkcs8(testKeyP8).length).toBeGreaterThan(50);
  });

  it('tolerates literal \\n sequences from a secret store paste', () => {
    const flattened = testKeyP8.replace(/\n/g, '\\n');
    expect(decodeP8ToPkcs8(flattened)).toEqual(decodeP8ToPkcs8(testKeyP8));
  });

  it('tolerates CRLF and a bare base64 body', () => {
    expect(decodeP8ToPkcs8(testKeyP8.replace(/\n/g, '\r\n'))).toEqual(decodeP8ToPkcs8(testKeyP8));
    const bare = testKeyP8.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    expect(decodeP8ToPkcs8(bare)).toEqual(decodeP8ToPkcs8(testKeyP8));
  });

  it('rejects empty or non-base64 input', () => {
    expect(() => decodeP8ToPkcs8('')).toThrow(/empty/);
    expect(() => decodeP8ToPkcs8('-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----')).toThrow(
      /base64/,
    );
  });
});

describe('signApnsJwt', () => {
  it('produces the header and claims Apple documents', async () => {
    const key = await importApnsKey(testKeyP8);
    const jwt = await signApnsJwt(key, { keyId: KEY_ID, teamId: TEAM_ID }, 1753420800000);
    const [h, c, s] = jwt.split('.');

    expect(decodeJwtPart(h)).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(decodeJwtPart(c)).toEqual({ iss: TEAM_ID, iat: 1753420800 });
    expect(s.length).toBeGreaterThan(0);
  });

  it('emits base64url with no padding anywhere', async () => {
    const key = await importApnsKey(testKeyP8);
    const jwt = await signApnsJwt(key, { keyId: KEY_ID, teamId: TEAM_ID }, Date.now());
    expect(jwt).not.toMatch(/[+/=]/);
    expect(jwt.split('.')).toHaveLength(3);
  });

  it('signs raw r||s (64 bytes), the JWS ES256 form — not DER', async () => {
    const key = await importApnsKey(testKeyP8);
    const jwt = await signApnsJwt(key, { keyId: KEY_ID, teamId: TEAM_ID }, Date.now());
    expect(decodeJwtSignature(jwt.split('.')[2])).toHaveLength(64);
  });

  it('produces a signature that verifies against the public key', async () => {
    const key = await importApnsKey(testKeyP8);
    const jwt = await signApnsJwt(key, { keyId: KEY_ID, teamId: TEAM_ID }, Date.now());
    const [h, c, s] = jwt.split('.');
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      testPublicKey,
      decodeJwtSignature(s),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(verified).toBe(true);
  });

  it('floors iat to whole seconds', async () => {
    const key = await importApnsKey(testKeyP8);
    const jwt = await signApnsJwt(key, { keyId: KEY_ID, teamId: TEAM_ID }, 1753420800999);
    expect(decodeJwtPart(jwt.split('.')[1]).iat).toBe(1753420800);
  });
});

describe('createApnsTokenProvider — reuse window', () => {
  function provider() {
    return createApnsTokenProvider({ keyP8: testKeyP8, keyId: KEY_ID, teamId: TEAM_ID });
  }

  it('reuses the token inside the window', async () => {
    const p = provider();
    const t0 = await p.getToken(1_000_000);
    expect(await p.getToken(1_000_000 + TOKEN_MAX_AGE_MS - 1)).toBe(t0);
  });

  it('re-signs once the window closes', async () => {
    const p = provider();
    const t0 = await p.getToken(1_000_000);
    const t1 = await p.getToken(1_000_000 + TOKEN_MAX_AGE_MS + 1);
    expect(t1).not.toBe(t0);
    expect(decodeJwtPart(t1.split('.')[1]).iat).toBe(Math.floor((1_000_000 + TOKEN_MAX_AGE_MS + 1) / 1000));
  });

  it('re-signs when the clock jumps backwards', async () => {
    const p = provider();
    const t0 = await p.getToken(5_000_000);
    expect(await p.getToken(1_000_000)).not.toBe(t0);
  });

  it('re-signs after invalidate()', async () => {
    const p = provider();
    const t0 = await p.getToken(1_000_000);
    p.invalidate();
    // Same timestamp: only the invalidation can explain a different token.
    const t1 = await p.getToken(1_000_000 + 1000);
    expect(t1).not.toBe(t0);
  });

  it('collapses concurrent callers onto one signature', async () => {
    const p = provider();
    const tokens = await Promise.all(Array.from({ length: 8 }, () => p.getToken(2_000_000)));
    expect(new Set(tokens).size).toBe(1);
  });

  it('does not poison the isolate after a bad key', async () => {
    const p = createApnsTokenProvider({ keyP8: 'garbage!!!', keyId: KEY_ID, teamId: TEAM_ID });
    await expect(p.getToken(1_000_000)).rejects.toThrow();
    // A second attempt must re-run the import rather than replaying a rejected promise.
    await expect(p.getToken(1_000_001)).rejects.toThrow();
  });
});
