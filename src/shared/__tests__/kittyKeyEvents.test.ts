import { describe, it, expect } from 'vitest';
import { kittyChunkAsLegacy } from '../kittyKeyEvents';

// Bytes captured from xterm 6.1 in a wmux pane after Claude Code pushed
// `CSI > 5 u` and Codex pushed `CSI > 7 u` (flag 2 adds the releases).
describe('kittyChunkAsLegacy', () => {
  it('reads kitty Escape, Enter and Ctrl+letter as their legacy bytes', () => {
    expect(kittyChunkAsLegacy('\x1b[27u')).toBe('\x1b');
    expect(kittyChunkAsLegacy('\x1b[13u')).toBe('\r');
    expect(kittyChunkAsLegacy('\x1b[99;5u')).toBe('\x03');
    expect(kittyChunkAsLegacy('\x1b[117;5u')).toBe('\x15');
  });

  it('drops key releases, alone or glued to their press', () => {
    expect(kittyChunkAsLegacy('\x1b[27;1:3u')).toBe('');
    expect(kittyChunkAsLegacy('\x1b[104;1:3u')).toBe('');
    expect(kittyChunkAsLegacy('\x1b[99;5u\x1b[99;5:3u')).toBe('\x03');
  });

  it('leaves everything else alone', () => {
    expect(kittyChunkAsLegacy('\x1b[13;2u')).toBe('\x1b[13;2u'); // Shift+Enter is not a submit
    expect(kittyChunkAsLegacy('\x1b[?5u')).toBe('\x1b[?5u'); // the terminal's flags reply
    expect(kittyChunkAsLegacy('\x1b[A')).toBe('\x1b[A');
    expect(kittyChunkAsLegacy('\x1b')).toBe('\x1b');
    expect(kittyChunkAsLegacy('hi\x1b[27u')).toBe('hi\x1b[27u');
    expect(kittyChunkAsLegacy('대한민국')).toBe('대한민국');
  });
});
