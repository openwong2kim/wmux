import { describe, it, expect } from 'vitest';
import { sanitizeRemoteText, sanitizeRemotePeerName, hasResidualControl } from '../sanitize';

// Build every control / invisible codepoint with String.fromCharCode so the
// source file stays printable ASCII (no literal invisible characters).
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const ESC = ch(0x1b);
const BEL = ch(0x07);
const TAB = ch(0x09);

describe('sanitize — ingress sanitizer (C16)', () => {
  it('normalizes CR/LF to a single space (no welding)', () => {
    expect(sanitizeRemoteText('l1\nl2')).toBe('l1 l2');
    expect(sanitizeRemoteText('a\r\nb')).toBe('a b');
  });

  it('normalizes U+2028/U+2029 line/paragraph separators to a space', () => {
    expect(sanitizeRemoteText('a' + ch(0x2028) + 'b')).toBe('a b');
    expect(sanitizeRemoteText('a' + ch(0x2029) + 'b')).toBe('a b');
    expect(hasResidualControl('a' + ch(0x2028) + 'b')).toBe(true);
  });

  it('strips C0 except TAB', () => {
    expect(sanitizeRemoteText('a' + ch(0x00) + 'b' + TAB + 'c')).toBe('ab' + TAB + 'c');
    expect(sanitizeRemoteText('a' + ch(0x0b) + 'b' + ch(0x0c) + 'c')).toBe('abc');
  });

  it('strips DEL (0x7F)', () => {
    expect(sanitizeRemoteText('a' + ch(0x7f) + 'b')).toBe('ab');
  });

  it('strips C1 including the 8-bit CSI 0x9B', () => {
    expect(sanitizeRemoteText('a' + ch(0x9b) + '31mb')).toBe('a31mb');
  });

  it('strips a lone ESC', () => {
    expect(sanitizeRemoteText('a' + ESC + 'b')).toBe('ab');
  });

  it('strips an OSC sequence (incl. its intro ESC)', () => {
    expect(sanitizeRemoteText('a' + ESC + ']0;window-title' + BEL + 'b')).toBe('ab');
  });

  it('strips zero-width + bidi isolates (Trojan-Source U+2066-2069) + ALM U+061C', () => {
    expect(sanitizeRemoteText('a' + ch(0x200b) + 'b' + ch(0x2066) + 'c' + ch(0x2069) + 'd' + ch(0x061c) + 'e')).toBe('abcde');
    expect(sanitizeRemoteText('x' + ch(0x202e) + 'y')).toBe('xy');
  });

  it('strips invisible Hangul fillers', () => {
    expect(sanitizeRemoteText('Alice' + ch(0x3164))).toBe('Alice');
    expect(sanitizeRemoteText(ch(0x115f, 0x1160, 0xffa0) + 'z')).toBe('z');
  });

  it('clamps the body to 4000 and the name to 100, never throwing', () => {
    expect(sanitizeRemoteText('x'.repeat(10000)).length).toBe(4000);
    expect(sanitizeRemotePeerName('y'.repeat(500)).length).toBe(100);
  });

  it('drops a trailing lone high surrogate', () => {
    expect(sanitizeRemoteText('ok' + ch(0xd800))).toBe('ok');
  });

  it('never throws on 2000 fuzzed inputs (incl. lone surrogates, across the BMP)', () => {
    for (let i = 0; i < 2000; i++) {
      const n = i % 60;
      let s = '';
      for (let j = 0; j < n; j++) s += ch((i * 7 + j * 13) % 0x11000);
      expect(() => sanitizeRemoteText(s)).not.toThrow();
      expect(() => sanitizeRemotePeerName(s)).not.toThrow();
    }
  });

  it('hasResidualControl flags a planted isolate / ESC but passes clean text + TAB', () => {
    expect(hasResidualControl('a' + ch(0x2066) + 'b')).toBe(true);
    expect(hasResidualControl('a' + ESC + 'b')).toBe(true);
    expect(hasResidualControl('clean text' + TAB + 'with tab')).toBe(false);
  });
});
