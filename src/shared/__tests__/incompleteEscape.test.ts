import { describe, it, expect } from 'vitest';
import { splitIncompleteEscape } from '../incompleteEscape';

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
