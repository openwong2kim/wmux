// The relay's one-time tokens: single use, short-lived, few, and spent only on purpose.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CdpRelayTokens, RELAY_TOKEN_TTL_MS, RELAY_TOKENS_MAX_UNUSED } from '../CdpRelayTokens';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CdpRelayTokens', () => {
  it('finds a minted token without spending it, and spends it once', () => {
    const tokens = new CdpRelayTokens<string>();
    const token = tokens.mint('chrome-a');
    const ticket = tokens.lookup(token);
    expect(ticket?.binding).toBe('chrome-a');
    // Looking does not spend.
    expect(tokens.lookup(token)?.binding).toBe('chrome-a');
    expect(tokens.consume(ticket!)).toBe(true);
    expect(tokens.lookup(token)).toBeNull();
    expect(tokens.consume(ticket!)).toBe(false);
  });

  it('gives each mint its own token, and refuses one it never minted', () => {
    const tokens = new CdpRelayTokens<string>();
    const a = tokens.mint('x');
    const b = tokens.mint('x');
    expect(a).not.toBe(b);
    expect(tokens.lookup(`${a}x`)).toBeNull();
    expect(tokens.lookup('')).toBeNull();
  });

  it('expires an unused token after the TTL, even one already looked up', () => {
    const tokens = new CdpRelayTokens<string>();
    const token = tokens.mint('x');
    const ticket = tokens.lookup(token)!;
    vi.advanceTimersByTime(RELAY_TOKEN_TTL_MS - 1);
    expect(tokens.lookup(token)).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(tokens.lookup(token)).toBeNull();
    expect(tokens.consume(ticket)).toBe(false);
  });

  it('keeps at most the newest RELAY_TOKENS_MAX_UNUSED unused tokens', () => {
    const tokens = new CdpRelayTokens<number>();
    const minted = Array.from({ length: RELAY_TOKENS_MAX_UNUSED + 1 }, (_, i) => tokens.mint(i));
    expect(tokens.size).toBe(RELAY_TOKENS_MAX_UNUSED);
    expect(tokens.lookup(minted[0])).toBeNull();
    expect(tokens.lookup(minted[1])?.binding).toBe(1);
    expect(tokens.lookup(minted[RELAY_TOKENS_MAX_UNUSED])?.binding).toBe(RELAY_TOKENS_MAX_UNUSED);
  });

  it('drops the tokens of a binding that is gone', () => {
    const tokens = new CdpRelayTokens<string>();
    const a = tokens.mint('a');
    const b = tokens.mint('b');
    tokens.forget((binding) => binding === 'a');
    expect(tokens.lookup(a)).toBeNull();
    expect(tokens.lookup(b)?.binding).toBe('b');
  });
});
