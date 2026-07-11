// Unit tests for the commander trust registry (P3b, codex P1).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mintCommanderToken,
  revokeCommanderToken,
  isCommanderToken,
  __resetCommanderTrustForTesting,
} from '../commanderTrust';

describe('commanderTrust', () => {
  beforeEach(() => __resetCommanderTrustForTesting());

  it('a minted token verifies; revocation kills it', () => {
    const token = mintCommanderToken();
    expect(token.length).toBeGreaterThanOrEqual(64);
    expect(isCommanderToken(token)).toBe(true);
    revokeCommanderToken(token);
    expect(isCommanderToken(token)).toBe(false);
  });

  it('rejects non-strings, empty strings, and unknown tokens', () => {
    mintCommanderToken();
    expect(isCommanderToken(undefined)).toBe(false);
    expect(isCommanderToken(null)).toBe(false);
    expect(isCommanderToken('')).toBe(false);
    expect(isCommanderToken('not-a-real-token')).toBe(false);
    expect(isCommanderToken(42)).toBe(false);
  });

  it('tokens are independent — revoking one leaves the other live', () => {
    const a = mintCommanderToken();
    const b = mintCommanderToken();
    expect(a).not.toBe(b);
    revokeCommanderToken(a);
    expect(isCommanderToken(a)).toBe(false);
    expect(isCommanderToken(b)).toBe(true);
  });
});
