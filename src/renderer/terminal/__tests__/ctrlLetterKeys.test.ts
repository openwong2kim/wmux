import { describe, it, expect } from 'vitest';
import { resolveCtrlLetterByte, type CtrlLetterEventLike } from '../ctrlLetterKeys';

function ev(partial: Partial<CtrlLetterEventLike>): CtrlLetterEventLike {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...partial,
  };
}

describe('resolveCtrlLetterByte — Dvorak / logical key (#1227)', () => {
  it('emits SIGINT (0x03) from logical C even when the physical key is I', () => {
    // Dvorak: the key that types "c" sits where QWERTY I is. keyCode would be
    // 73, and xterm would emit Ctrl+I (tab). We encode from e.key instead.
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyI', ctrlKey: true }))).toBe('\x03');
  });

  it('emits Ctrl+J (LF) from logical J on the physical C key, not SIGINT', () => {
    // The IME fallback must NOT treat physical KeyC as C when the layout
    // already reported a Latin letter — that is how Dvorak J would steal copy.
    expect(resolveCtrlLetterByte(ev({ key: 'j', code: 'KeyC', ctrlKey: true }))).toBe('\n');
  });

  it('emits Ctrl+Z from logical Z', () => {
    expect(resolveCtrlLetterByte(ev({ key: 'z', code: 'KeySlash', ctrlKey: true }))).toBe('\x1a');
  });
});

describe('resolveCtrlLetterByte — IME fallback', () => {
  it('falls back to physical KeyC when the IME mangles key to Process', () => {
    expect(resolveCtrlLetterByte(ev({ key: 'Process', code: 'KeyC', ctrlKey: true }))).toBe('\x03');
  });

  it('falls back to physical KeyC when the IME reports a Hangul jamo', () => {
    expect(resolveCtrlLetterByte(ev({ key: 'ㅊ', code: 'KeyC', ctrlKey: true }))).toBe('\x03');
  });
});

describe('resolveCtrlLetterByte — guards', () => {
  it('ignores Shift/Alt/Meta and an active IME composition', () => {
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyC', ctrlKey: true, metaKey: true }))).toBeNull();
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyC', ctrlKey: true, isComposing: true }))).toBeNull();
  });

  it('ignores a bare C (no Ctrl) and non-letter keys', () => {
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyC' }))).toBeNull();
    expect(resolveCtrlLetterByte(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }))).toBeNull();
  });
});
