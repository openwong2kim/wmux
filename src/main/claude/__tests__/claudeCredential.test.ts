/**
 * extractAccessToken / extractCredentialMetadata pure-function tests.
 *
 * Mirrors the Swift TokenStore behavior from
 * `openwong2kim/claude-token-check` so cross-platform parity is
 * locked. The actual platform branches (Keychain shell-out, file read)
 * are not unit-tested here — they're integration concerns covered at
 * dogfood time.
 */
import { describe, it, expect } from 'vitest';
import { extractAccessToken, extractCredentialMetadata } from '../claudeCredential';

describe('extractAccessToken', () => {
  it('returns null on empty / whitespace blob', () => {
    expect(extractAccessToken('')).toBeNull();
    expect(extractAccessToken('   ')).toBeNull();
    expect(extractAccessToken('\n\t')).toBeNull();
  });

  it('pulls direct accessToken from a flat JSON object', () => {
    const blob = JSON.stringify({ accessToken: 'sk-ant-xyz-1234567890ABCDEF' });
    expect(extractAccessToken(blob)).toBe('sk-ant-xyz-1234567890ABCDEF');
  });

  it('pulls nested accessToken from claudeAiOauth wrapper (Windows shape)', () => {
    const blob = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-deadbeefdeadbeef', refreshToken: 'r' },
    });
    expect(extractAccessToken(blob)).toBe('sk-ant-deadbeefdeadbeef');
  });

  it('pulls nested accessToken regardless of wrapper key name', () => {
    // The Swift impl iterates `json.values`, so wrapper key is irrelevant.
    const blob = JSON.stringify({ someUnknownWrapper: { accessToken: 'sk-ant-xyz1234567890' } });
    expect(extractAccessToken(blob)).toBe('sk-ant-xyz1234567890');
  });

  it('returns null when direct accessToken is empty string', () => {
    expect(extractAccessToken(JSON.stringify({ accessToken: '' }))).toBeNull();
  });

  it('returns null when nested accessToken is empty', () => {
    expect(
      extractAccessToken(JSON.stringify({ claudeAiOauth: { accessToken: '' } })),
    ).toBeNull();
  });

  it('falls back to raw-token regex when blob is not JSON', () => {
    expect(extractAccessToken('sk-ant-deadbeef.deadbeef-XYZ_1234567890')).toBe(
      'sk-ant-deadbeef.deadbeef-XYZ_1234567890',
    );
  });

  it('rejects raw tokens shorter than 20 chars (regex floor)', () => {
    expect(extractAccessToken('short')).toBeNull();
    expect(extractAccessToken('abc-1234567890')).toBeNull();
  });

  it('rejects raw blobs with whitespace inside', () => {
    expect(extractAccessToken('sk-ant has whitespace inside')).toBeNull();
  });

  it('handles JSON wrapped in whitespace', () => {
    const blob = `\n  ${JSON.stringify({ accessToken: 'sk-ant-padded-token-1234567890' })}  \n`;
    expect(extractAccessToken(blob)).toBe('sk-ant-padded-token-1234567890');
  });

  it('returns null for malformed JSON without a fallback raw token shape', () => {
    expect(extractAccessToken('{"accessToken": "missing-quote}')).toBeNull();
  });
});

describe('extractCredentialMetadata', () => {
  it('reads subscriptionType + rateLimitTier + expiresAt from claudeAiOauth wrapper', () => {
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-xyz1234567890',
        refreshToken: 'r',
        expiresAt: 1_750_000_000_000,
        subscriptionType: 'pro',
        rateLimitTier: 'standard',
      },
    });
    expect(extractCredentialMetadata(blob)).toEqual({
      subscriptionType: 'pro',
      rateLimitTier: 'standard',
      expiresAtMs: 1_750_000_000_000,
    });
  });

  it('returns nulls for raw-token blob (no metadata available)', () => {
    expect(extractCredentialMetadata('sk-ant-raw-token-1234567890')).toEqual({
      subscriptionType: null,
      rateLimitTier: null,
      expiresAtMs: null,
    });
  });

  it('returns nulls for empty / malformed JSON', () => {
    expect(extractCredentialMetadata('')).toEqual({
      subscriptionType: null,
      rateLimitTier: null,
      expiresAtMs: null,
    });
    expect(extractCredentialMetadata('{not json}')).toEqual({
      subscriptionType: null,
      rateLimitTier: null,
      expiresAtMs: null,
    });
  });

  it('returns nulls when metadata fields are missing or wrong type', () => {
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-xyz1234567890',
        subscriptionType: 42, // wrong type
        expiresAt: 'not a number',
      },
    });
    expect(extractCredentialMetadata(blob)).toEqual({
      subscriptionType: null,
      rateLimitTier: null,
      expiresAtMs: null,
    });
  });

  it('falls through to top-level if nested object has no metadata', () => {
    const blob = JSON.stringify({
      subscriptionType: 'team',
      claudeAiOauth: { accessToken: 'sk-ant-xyz1234567890' },
    });
    expect(extractCredentialMetadata(blob).subscriptionType).toBe('team');
  });

  it('reads partial metadata when only one field present', () => {
    const blob = JSON.stringify({ claudeAiOauth: { subscriptionType: 'max' } });
    expect(extractCredentialMetadata(blob)).toEqual({
      subscriptionType: 'max',
      rateLimitTier: null,
      expiresAtMs: null,
    });
  });
});
