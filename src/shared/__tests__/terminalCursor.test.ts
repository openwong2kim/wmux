import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_CURSOR_STYLE,
  isTerminalCursorStyle,
  sanitizeTerminalCursorStyle,
} from '../terminalCursor';

describe('terminalCursor', () => {
  it('accepts the three xterm.js cursorStyle values', () => {
    expect(isTerminalCursorStyle('block')).toBe(true);
    expect(isTerminalCursorStyle('bar')).toBe(true);
    expect(isTerminalCursorStyle('underline')).toBe(true);
  });

  it('rejects anything else, including the empty string', () => {
    expect(isTerminalCursorStyle('')).toBe(false);
    expect(isTerminalCursorStyle('beam')).toBe(false);
    expect(isTerminalCursorStyle('Block')).toBe(false);
    expect(isTerminalCursorStyle(null)).toBe(false);
    expect(isTerminalCursorStyle(undefined)).toBe(false);
  });

  it('sanitizes unknown session values to the block default', () => {
    expect(sanitizeTerminalCursorStyle('underline')).toBe('underline');
    expect(sanitizeTerminalCursorStyle('nope')).toBe(DEFAULT_TERMINAL_CURSOR_STYLE);
    expect(sanitizeTerminalCursorStyle(undefined)).toBe('block');
  });
});
