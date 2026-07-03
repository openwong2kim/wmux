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

  it('matches when the function key is the last part of a combo', () => {
    expect(isBareFunctionKeyCombo('Ctrl+F7')).toBe(true);
    expect(isBareFunctionKeyCombo('Ctrl+Shift+F5')).toBe(true);
  });

  it('does not match non-function keys', () => {
    expect(isBareFunctionKeyCombo('Ctrl+Shift+1')).toBe(false);
    expect(isBareFunctionKeyCombo('A')).toBe(false);
    expect(isBareFunctionKeyCombo('F13')).toBe(false); // 범위 밖
    expect(isBareFunctionKeyCombo('Ctrl+F')).toBe(false); // 'F' 단독은 F키가 아님
  });
});

describe('hasBareFunctionKeyBinding', () => {
  it('returns true when any binding uses a function key', () => {
    expect(hasBareFunctionKeyBinding([kb('Ctrl+Shift+1'), kb('F7')])).toBe(true);
    expect(hasBareFunctionKeyBinding([kb('Ctrl+F7')])).toBe(true);
  });

  it('returns false when no binding uses a function key', () => {
    expect(hasBareFunctionKeyBinding([kb('Ctrl+Shift+1'), kb('A')])).toBe(false);
    expect(hasBareFunctionKeyBinding([])).toBe(false);
  });
});
