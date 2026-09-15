import { describe, it, expect } from 'vitest';
import {
  encodeEscape,
  isBareEscape,
  ESCAPE_CSI_U,
  ESCAPE_WIN32,
} from '../escapeKeys';

describe('encodeEscape', () => {
  it('emits a bare ESC when nothing was negotiated', () => {
    expect(encodeEscape(undefined)).toBe('\x1b');
    expect(encodeEscape({})).toBe('\x1b');
  });

  it('emits CSI-u when the pane pushed kitty', () => {
    expect(encodeEscape({ kitty: true })).toBe(ESCAPE_CSI_U);
  });

  it('emits the win32-input-mode pair when the pane negotiated ?9001h', () => {
    expect(encodeEscape({ win32Input: true })).toBe(ESCAPE_WIN32);
  });

  it('prefers win32-input-mode over kitty', () => {
    expect(encodeEscape({ win32Input: true, kitty: true })).toBe(ESCAPE_WIN32);
  });

  it('does not re-encode unmodified Escape for modifyOtherKeys', () => {
    expect(encodeEscape({ modifyOtherKeys: 2 })).toBe('\x1b');
  });
});

describe('isBareEscape', () => {
  const bare = {
    key: 'Escape',
    code: 'Escape',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
  };

  it('matches a bare Escape', () => {
    expect(isBareEscape(bare)).toBe(true);
  });

  it('matches IME-mangled Escape via physical code', () => {
    expect(isBareEscape({ ...bare, key: 'Process' })).toBe(true);
  });

  it('defers during an IME composition', () => {
    expect(isBareEscape({ ...bare, isComposing: true })).toBe(false);
  });

  it('ignores modified Escape', () => {
    expect(isBareEscape({ ...bare, shiftKey: true })).toBe(false);
    expect(isBareEscape({ ...bare, ctrlKey: true })).toBe(false);
    expect(isBareEscape({ ...bare, altKey: true })).toBe(false);
    expect(isBareEscape({ ...bare, metaKey: true })).toBe(false);
  });
});
