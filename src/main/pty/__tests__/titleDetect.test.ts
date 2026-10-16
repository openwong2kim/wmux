import { describe, it, expect } from 'vitest';
import { ClaudeTitleTurnEdge, sanitizeTitle, TERMINAL_TITLE_MAX } from '../titleDetect';

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

describe('ClaudeTitleTurnEdge (#2264)', () => {
  it('reports the running spinner turning idle, once', () => {
    const edge = new ClaudeTitleTurnEdge();
    expect(edge.observe('◐ 50번째 소수 검증')).toBe(false);
    expect(edge.observe('◑ 50번째 소수 검증')).toBe(false);
    expect(edge.observe('✳ 50번째 소수 검증')).toBe(true);
    expect(edge.observe('✳ 50번째 소수 검증')).toBe(false);
  });

  it('needs a running title first', () => {
    expect(new ClaudeTitleTurnEdge().observe('✳ Claude Code')).toBe(false);
  });

  it('forgets a running title that another title replaced', () => {
    const edge = new ClaudeTitleTurnEdge();
    edge.observe('◐ Claude Code');
    edge.observe('bash');
    expect(edge.observe('✳ Claude Code')).toBe(false);
  });

  it('reads only the leading glyph', () => {
    const edge = new ClaudeTitleTurnEdge();
    edge.observe('notes ◐ draft');
    expect(edge.observe('✳ Claude Code')).toBe(false);
  });
});
