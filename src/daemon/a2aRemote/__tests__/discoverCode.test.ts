import { describe, expect, it } from 'vitest';
import { commitMatches, decodeSecret, discoverCode, discoverCommit, randomSecret } from '../discoverCode';

// Known vectors computed with an independent HKDF (Python hmac/hashlib).
const NS = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'; // bytes 0..31
const NR = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8'; // bytes 32..63
const FS = Array.from({ length: 32 }, () => 'AB').join(':');
const FR = Array.from({ length: 32 }, () => '01').join(':');
const HOST = '33333333-3333-4333-8333-333333333333';

describe('discoverCommit / commitMatches', () => {
  it('matches the known vector', () => {
    expect(discoverCommit(NR)).toBe('eL5vx7zd0guqXdkNgaumTlG1d6-xe8JCC2ualbT6AaE');
    expect(commitMatches('eL5vx7zd0guqXdkNgaumTlG1d6-xe8JCC2ualbT6AaE', NR)).toBe(true);
  });

  it('does not open with another nonce or a malformed input', () => {
    const commit = discoverCommit(NR);
    expect(commitMatches(commit, NS)).toBe(false);
    expect(commitMatches(commit, `${NR}=`)).toBe(false);
    expect(commitMatches('not-a-commit', NR)).toBe(false);
    expect(commitMatches(commit, '')).toBe(false);
  });
});

describe('discoverCode', () => {
  const base = { nonceS: NS, nonceR: NR, fingerprintS: FS, fingerprintR: FR, hostIdR: HOST };

  it('matches the known vectors, zero-padded', () => {
    expect(discoverCode(base)).toBe('569808');
    expect(discoverCode({ ...base, nonceR: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9PgE' })).toBe('029294');
  });

  it('binds both fingerprints in order: a man in the middle with another certificate gets another code', () => {
    expect(discoverCode({ ...base, fingerprintS: FR, fingerprintR: FS })).toBe('115601');
    expect(discoverCode({ ...base, fingerprintS: Array.from({ length: 32 }, () => 'CD').join(':') })).not.toBe('569808');
  });

  it('normalizes fingerprint case and colons', () => {
    expect(discoverCode({ ...base, fingerprintS: FS.toLowerCase().replace(/:/g, '') })).toBe('569808');
  });

  it('binds the requester hostId and both nonces', () => {
    expect(discoverCode({ ...base, hostIdR: '44444444-4444-4444-8444-444444444444' })).not.toBe('569808');
    expect(discoverCode({ ...base, nonceS: NR, nonceR: NS })).not.toBe('569808');
  });

  it('refuses a malformed nonce or fingerprint', () => {
    expect(() => discoverCode({ ...base, nonceS: 'short' })).toThrow(/nonce/);
    expect(() => discoverCode({ ...base, fingerprintR: 'nope' })).toThrow(/fingerprint/);
  });
});

describe('randomSecret / decodeSecret', () => {
  it('makes 32 random bytes in canonical base64url', () => {
    const a = randomSecret();
    expect(decodeSecret(a)?.length).toBe(32);
    expect(randomSecret()).not.toBe(a);
  });

  it('refuses anything but exactly 32 canonical bytes', () => {
    expect(decodeSecret(NS.slice(0, 42))).toBeNull();
    expect(decodeSecret(`${NS}A`)).toBeNull();
    expect(decodeSecret(NS.replace(/.$/, '+'))).toBeNull();
    // A non-canonical last character (stray low bits).
    expect(decodeSecret(NS.replace(/.$/, 'h'))).toBeNull();
    expect(decodeSecret(42)).toBeNull();
  });
});
