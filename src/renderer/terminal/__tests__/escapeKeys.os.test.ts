import { describe, it, expect } from 'vitest';
import {
  encodeEscape,
  isBareEscape,
  ESCAPE_CSI_U,
} from '../escapeKeys';

describe('encodeEscape', () => {
  it('emits a bare ESC when nothing was negotiated', () => {
    expect(encodeEscape(undefined)).toBe('\x1b');
    expect(encodeEscape({})).toBe('\x1b');
  });

  it('emits CSI-u when the pane pushed kitty', () => {
    expect(encodeEscape({ kitty: true })).toBe(ESCAPE_CSI_U);
  });

  // #1373: ConPTY converts a win32 KEY_EVENT record back into a bare ESC for
  // the client, so the record pair was never worth its risk — and Escape went
  // dead in Claude Code panes on 3.56.0. The bare byte is what 3.55.0 sent.
  it('emits a bare ESC under win32-input-mode, not a key record', () => {
    expect(encodeEscape({ win32Input: true })).toBe('\x1b');
  });

  it('still emits CSI-u when kitty is pushed alongside win32-input-mode', () => {
    expect(encodeEscape({ win32Input: true, kitty: true })).toBe(ESCAPE_CSI_U);
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
