import { describe, it, expect } from 'vitest';
import { sanitizeTitle, TERMINAL_TITLE_MAX } from '../titleDetect';

describe('sanitizeTitle', () => {
  it('keeps a normal title unchanged', () => {
    expect(sanitizeTitle('my-session')).toBe('my-session');
  });

  it('strips control chars (CR/LF/TAB/BEL/C1) and collapses whitespace', () => {
    expect(sanitizeTitle('a\r\nb\tc\x07d\x9ae')).toBe('a b c d e');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeTitle('  spaced  ')).toBe('spaced');
  });

  it('caps length at TERMINAL_TITLE_MAX', () => {
    const long = 'x'.repeat(TERMINAL_TITLE_MAX + 50);
    expect(sanitizeTitle(long)).toHaveLength(TERMINAL_TITLE_MAX);
  });

  it('returns empty string for control-only or empty input', () => {
    expect(sanitizeTitle('\x07\x1b\x00')).toBe('');
    expect(sanitizeTitle('')).toBe('');
  });
});
