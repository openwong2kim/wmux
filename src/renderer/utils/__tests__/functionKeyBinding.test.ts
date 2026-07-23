import { describe, it, expect } from 'vitest';
import type { CustomKeybinding } from '../../../shared/types';
import { isBareFunctionKeyCombo, hasBareFunctionKeyBinding } from '../functionKeyBinding';

const kb = (key: string): CustomKeybinding => ({
  id: `kb-${key}`,
  key,
  label: '',
  command: '',
  sendEnter: true,
});

describe('isBareFunctionKeyCombo', () => {
  it('matches a lone function key (F1–F12)', () => {
    expect(isBareFunctionKeyCombo('F7')).toBe(true);
    expect(isBareFunctionKeyCombo('F1')).toBe(true);
    expect(isBareFunctionKeyCombo('F12')).toBe(true);
  });

  it('does NOT match a function key carrying modifiers (Ctrl+F7 reaches the app)', () => {
    // macOS delivers modified F-keys as function keys — no guidance needed.
    expect(isBareFunctionKeyCombo('Ctrl+F7')).toBe(false);
    expect(isBareFunctionKeyCombo('Ctrl+Shift+F5')).toBe(false);
  });

  it('does not match non-function keys', () => {
    expect(isBareFunctionKeyCombo('Ctrl+Shift+1')).toBe(false);
    expect(isBareFunctionKeyCombo('A')).toBe(false);
    expect(isBareFunctionKeyCombo('F13')).toBe(false); // out of range
    expect(isBareFunctionKeyCombo('Ctrl+F')).toBe(false); // bare 'F' is not an F-key
  });
});

describe('hasBareFunctionKeyBinding', () => {
  it('returns true only when a binding uses a BARE function key', () => {
    expect(hasBareFunctionKeyBinding([kb('Ctrl+Shift+1'), kb('F7')])).toBe(true);
    // Ctrl+F7 (Mac default) works normally — not a guidance target.
    expect(hasBareFunctionKeyBinding([kb('Ctrl+F7')])).toBe(false);
  });

  it('returns false when no binding uses a function key', () => {
    expect(hasBareFunctionKeyBinding([kb('Ctrl+Shift+1'), kb('A')])).toBe(false);
    expect(hasBareFunctionKeyBinding([])).toBe(false);
  });
});
