import { describe, it, expect } from 'vitest';
import {
  canonicalizeChannelName,
  isValidChannelName,
  CHANNEL_NAME_MAX,
  CHANNEL_NAME_MIN,
} from '../channels';

describe('canonicalizeChannelName', () => {
  it('trims whitespace and lowercases', () => {
    expect(canonicalizeChannelName('  General  ')).toBe('general');
  });

  it('replaces non-allowed characters with a single hyphen (trailing hyphen kept)', () => {
    // "##hello##" → "-hello-" → strip leading hyphen → "hello-".
    // The trailing hyphen is intentional — only the leading position is
    // stripped because CHANNEL_NAME_RE requires a letter/digit start.
    expect(canonicalizeChannelName('##hello##')).toBe('hello-');
    expect(isValidChannelName('hello-')).toBe(true);
  });

  it('strips a single leading hyphen', () => {
    expect(canonicalizeChannelName('-leading-hyphen')).toBe('leading-hyphen');
  });

  it('strips multiple leading hyphens', () => {
    expect(canonicalizeChannelName('--double-leading')).toBe('double-leading');
  });

  it('clamps to CHANNEL_NAME_MAX characters', () => {
    const long = 'a'.repeat(100);
    const out = canonicalizeChannelName(long);
    expect(out).toHaveLength(CHANNEL_NAME_MAX);
    expect(out).toBe('a'.repeat(CHANNEL_NAME_MAX));
  });

  it('returns empty string for empty input (documented edge case)', () => {
    expect(canonicalizeChannelName('')).toBe('');
    // isValidChannelName rejects empty — the boundary check catches it.
    expect(isValidChannelName('')).toBe(false);
  });

  it('returns "" for all-punctuation input (documented edge case)', () => {
    // "!!!" → "-" → strip leading hyphen → "". The leading-hyphen strip
    // also handles the all-hyphen case so the canonicalizer never
    // returns a result that starts with a hyphen.
    expect(canonicalizeChannelName('!!!')).toBe('');
    // isValidChannelName rejects empty — the boundary check catches it.
    expect(isValidChannelName('')).toBe(false);
  });

  it('round-trips a valid name unchanged', () => {
    expect(canonicalizeChannelName('foo-bar-1')).toBe('foo-bar-1');
    expect(isValidChannelName('foo-bar-1')).toBe(true);
  });

  it('clamps a 200-char input to exactly CHANNEL_NAME_MAX', () => {
    const long = 'b'.repeat(200);
    expect(canonicalizeChannelName(long)).toHaveLength(CHANNEL_NAME_MAX);
  });

  it('preserves interior hyphens when clamping (no truncation artifact)', () => {
    // 70 chars of a-; clamp to 64 → first 64 a-.
    const input = 'a-'.repeat(35); // 70 chars
    const out = canonicalizeChannelName(input);
    expect(out).toHaveLength(CHANNEL_NAME_MAX);
    expect(out).toBe('a-'.repeat(32)); // 64 chars
  });
});

describe('isValidChannelName', () => {
  it('accepts single lowercase letter', () => {
    expect(isValidChannelName('a')).toBe(true);
  });

  it('accepts a name at the max length', () => {
    expect(isValidChannelName('a'.repeat(CHANNEL_NAME_MAX))).toBe(true);
  });

  it('rejects a name over the max length', () => {
    expect(isValidChannelName('a'.repeat(CHANNEL_NAME_MAX + 1))).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(isValidChannelName('General')).toBe(false);
  });

  it('rejects a name starting with a hyphen', () => {
    expect(isValidChannelName('-foo')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidChannelName('')).toBe(false);
  });

  it('rejects names shorter than CHANNEL_NAME_MIN', () => {
    expect(CHANNEL_NAME_MIN).toBe(1);
    expect(isValidChannelName('')).toBe(false);
  });
});
