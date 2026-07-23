import { describe, it, expect } from 'vitest';
import { sanitizeFontFamily, terminalFontFamilyCss } from '../terminalFont';

describe('sanitizeFontFamily', () => {
  it('passes a clean family name through unchanged', () => {
    expect(sanitizeFontFamily('JetBrains Mono')).toBe('JetBrains Mono');
    expect(sanitizeFontFamily('D2Coding')).toBe('D2Coding');
  });

  it('preserves CJK family names', () => {
    expect(sanitizeFontFamily('나눔고딕코딩')).toBe('나눔고딕코딩');
  });

  it('strips single, double, and back quotes', () => {
    expect(sanitizeFontFamily(`Ev'il"Font`)).toBe('EvilFont');
    expect(sanitizeFontFamily('Back`tick')).toBe('Backtick');
  });

  it('strips CSS terminators ; { }', () => {
    expect(sanitizeFontFamily('Arial; }')).toBe('Arial');
    expect(sanitizeFontFamily('x{color:red}')).toBe('xcolor:red');
  });

  it('strips backslash and control characters (incl. NUL/CR/LF/TAB)', () => {
    expect(sanitizeFontFamily('A\\B')).toBe('AB');
    // Control chars are removed outright (a font name never legitimately
    // contains them), so adjacent letters join rather than gaining a space.
    expect(sanitizeFontFamily('A\tB\nC\rD\0E')).toBe('ABCDE');
  });

  it('neutralizes a full CSS-injection payload', () => {
    const attack = `Arial', monospace; } body { background: url(http://evil) `;
    const safe = sanitizeFontFamily(attack);
    // No quote, semicolon, or brace can survive — so it cannot escape the
    // quoted font-family token it will be embedded in.
    expect(safe).not.toMatch(/['"`;{}\\]/);
  });

  it('collapses runs of whitespace and trims', () => {
    expect(sanitizeFontFamily('  Fira   Code  ')).toBe('Fira Code');
  });

  it('returns empty string for blank / all-unsafe / non-string input', () => {
    expect(sanitizeFontFamily('   ')).toBe('');
    expect(sanitizeFontFamily(`'";{}`)).toBe('');
    // @ts-expect-error — runtime guard against a non-string from JS callers
    expect(sanitizeFontFamily(undefined)).toBe('');
  });

  it('caps length at 128 characters', () => {
    const long = 'a'.repeat(500);
    expect(sanitizeFontFamily(long)).toHaveLength(128);
  });
});

// Cross-platform fallback chain lock — mac mono (Menlo/SF Mono/Monaco), win mono
// (Consolas/Courier New), CJK fallback (Apple SD Gothic Neo/Malgun Gothic), generic.
const FALLBACK_CHAIN =
  "'Menlo', 'SF Mono', 'Monaco', 'Consolas', 'Courier New', 'Apple SD Gothic Neo', 'Malgun Gothic', monospace";

describe('terminalFontFamilyCss', () => {
  it('wraps a clean name in quotes and appends the fallback chain', () => {
    expect(terminalFontFamilyCss('JetBrains Mono')).toBe(`'JetBrains Mono', ${FALLBACK_CHAIN}`);
  });

  it('sanitizes a dirty name before wrapping (regression guard)', () => {
    // The injection chars are stripped, then the remainder is quoted once.
    const css = terminalFontFamilyCss(`x'; } body {`);
    expect(css).toBe(`'x body', ${FALLBACK_CHAIN}`);
    // Exactly eight quoted families × 2 quotes — no extra quotes leaked in.
    expect((css.match(/'/g) || []).length).toBe(16);
  });

  it('returns the fallback chain alone when the name is empty/unsafe', () => {
    const chain = FALLBACK_CHAIN;
    expect(terminalFontFamilyCss('')).toBe(chain);
    expect(terminalFontFamilyCss(`'";{}`)).toBe(chain);
  });
});
