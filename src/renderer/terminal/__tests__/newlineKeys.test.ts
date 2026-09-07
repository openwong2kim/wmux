/**
 * Tests for the deterministic newline-key encoder.
 *
 * Regression target: Ctrl+J silently dropped under a CJK IME. xterm.js derives
 * Ctrl+<letter> from the deprecated `keyCode`, which becomes 229 ("Process")
 * with the IME active, so Ctrl+J never produced an LF and in-pane TUIs (codex,
 * Claude Code) never saw the newline. The encoder matches the physical `code`
 * so the byte is emitted regardless of IME/layout state.
 */
import { describe, it, expect } from 'vitest';
import { resolveNewlineKeyByte, type NewlineKeyEventLike } from '../newlineKeys';

function ev(partial: Partial<NewlineKeyEventLike>): NewlineKeyEventLike {
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

describe('resolveNewlineKeyByte — Ctrl+J', () => {
  it('emits LF for Ctrl+J via physical code (Latin layout)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }))).toBe('\n');
  });

  it('emits LF for Ctrl+J even when an IME mangles key to "Process"', () => {
    // keyCode would be 229 here; we never look at it. code stays 'KeyJ'.
    expect(resolveNewlineKeyByte(ev({ key: 'Process', code: 'KeyJ', ctrlKey: true }))).toBe('\n');
  });

  it('ignores Ctrl+Shift+J (reserved for app shortcuts)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('ignores Ctrl+Alt+J and Ctrl+Meta+J', () => {
    expect(resolveNewlineKeyByte(ev({ code: 'KeyJ', ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolveNewlineKeyByte(ev({ code: 'KeyJ', ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it('ignores a bare J (no Ctrl)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ' }))).toBeNull();
  });

  it('defers during an active IME composition (isComposing) so preedit is not split', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Process', code: 'KeyJ', ctrlKey: true, isComposing: true })),
    ).toBeNull();
  });

  it('defers to an explicit user Ctrl+J keybinding', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }), { hasCustomCtrlJBinding: true }),
    ).toBe(null);
  });

  it('still emits LF when opts is present but no Ctrl+J binding', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }), { hasCustomCtrlJBinding: false }),
    ).toBe('\n');
  });
});

describe('resolveNewlineKeyByte — Shift+Enter (preserved behavior)', () => {
  it('emits CSI u for Shift+Enter on a local pane (default fallback)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }))).toBe('\x1b[13;2u');
  });

  it('emits the win32-input-mode pair when the pane negotiated ?9001h (#1152)', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), {
        protocol: { win32Input: true },
      }),
    ).toBe('\x1b[13;28;13;1;16;1_\x1b[13;28;0;0;16;1_');
  });

  it('prefers win32-input-mode over kitty when both were seen', () => {
    // Codex on Windows requests 9001; a stray kitty sequence must not win.
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), {
        protocol: { win32Input: true, kitty: true },
      }),
    ).toBe('\x1b[13;28;13;1;16;1_\x1b[13;28;0;0;16;1_');
  });

  it('hands Shift+Enter back to xterm when a mirror/web viewer saw no protocol', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), { shiftEnterFallback: 'xterm' }),
    ).toBeNull();
  });

  it('emits CSI u for a mirror once the remote asked for kitty', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), {
        protocol: { kitty: true },
        shiftEnterFallback: 'xterm',
      }),
    ).toBe('\x1b[13;2u');
  });

  it('ignores plain Enter', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter' }))).toBeNull();
  });

  it('ignores Ctrl+Shift+Enter', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true, ctrlKey: true }))).toBeNull();
  });
});

describe('resolveNewlineKeyByte — Ctrl+Enter', () => {
  it('emits LF for Ctrl+Enter so an in-pane TUI inserts a newline instead of submitting', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }))).toBe('\n');
  });

  it('emits LF for Ctrl+Enter on the numeric keypad (NumpadEnter still reports key "Enter")', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', code: 'NumpadEnter', ctrlKey: true }))).toBe('\n');
  });

  it('ignores Ctrl+Shift+Enter (Shift+Enter already owns its CSI u path)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('ignores Ctrl+Alt+Enter and Ctrl+Meta+Enter', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it('defers during an active IME composition so a preedit is not split', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', ctrlKey: true, isComposing: true }))).toBeNull();
  });

  it('ignores a bare Enter (no Ctrl) — plain submit is unchanged', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter' }))).toBeNull();
  });
});
