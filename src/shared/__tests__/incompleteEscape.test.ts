import { describe, it, expect } from 'vitest';
import { IncompleteEscapeSplitter, splitIncompleteEscape } from '../incompleteEscape';

describe('splitIncompleteEscape', () => {
  it('passes through complete text', () => {
    expect(splitIncompleteEscape('hello')).toEqual({ complete: 'hello', pending: '' });
    expect(splitIncompleteEscape('')).toEqual({ complete: '', pending: '' });
  });

  it('carries a CUP split after ESC[', () => {
    expect(splitIncompleteEscape('hello\x1b[')).toEqual({
      complete: 'hello',
      pending: '\x1b[',
    });
  });

  it('carries a CUP split in the parameters', () => {
    expect(splitIncompleteEscape('hello\x1b[12;6')).toEqual({
      complete: 'hello',
      pending: '\x1b[12;6',
    });
  });

  it('does not carry a finished CUP', () => {
    expect(splitIncompleteEscape('hello\x1b[12;6Hworld')).toEqual({
      complete: 'hello\x1b[12;6Hworld',
      pending: '',
    });
  });

  it('carries an unfinished OSC', () => {
    expect(splitIncompleteEscape('x\x1b]8;;http://example.com')).toEqual({
      complete: 'x',
      pending: '\x1b]8;;http://example.com',
    });
  });

  it('does not carry a BEL-terminated OSC', () => {
    expect(splitIncompleteEscape('x\x1b]8;;http://example.com\x07y')).toEqual({
      complete: 'x\x1b]8;;http://example.com\x07y',
      pending: '',
    });
  });

  it('pending-only when the whole string is an unfinished sequence', () => {
    expect(splitIncompleteEscape('\x1b[?2026')).toEqual({
      complete: '',
      pending: '\x1b[?2026',
    });
  });
});

describe('IncompleteEscapeSplitter', () => {
  it('holds an unfinished sequence across chunks until one finishes it', () => {
    const splitter = new IncompleteEscapeSplitter();
    expect(splitter.push('a\x1b[12')).toBe('a');
    expect(splitter.push(';6')).toBe('');
    expect(splitter.push('Hb\x1b]0;t')).toBe('\x1b[12;6Hb');
    expect(splitter.take()).toBe('\x1b]0;t');
    // take() starts over at ground.
    expect(splitter.push('plain')).toBe('plain');
    expect(splitter.take()).toBe('');
  });

  it('holds a sequence of any length (a raw replay can end inside a long OSC)', () => {
    const splitter = new IncompleteEscapeSplitter();
    const body = 'x'.repeat(10_000);
    expect(splitter.push(`ok\x1b]52;c;${body}`)).toBe('ok');
    expect(splitter.push(body)).toBe('');
    expect(splitter.take()).toBe(`\x1b]52;c;${body}${body}`);
  });
});
