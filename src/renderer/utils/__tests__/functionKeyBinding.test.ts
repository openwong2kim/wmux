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
    // macOS는 수정자가 붙은 F키를 기능 키로 전달하므로 안내가 필요 없다.
    expect(isBareFunctionKeyCombo('Ctrl+F7')).toBe(false);
    expect(isBareFunctionKeyCombo('Ctrl+Shift+F5')).toBe(false);
  });

  it('does not match non-function keys', () => {
    expect(isBareFunctionKeyCombo('Ctrl+Shift+1')).toBe(false);
    expect(isBareFunctionKeyCombo('A')).toBe(false);
    expect(isBareFunctionKeyCombo('F13')).toBe(false); // 범위 밖
    expect(isBareFunctionKeyCombo('Ctrl+F')).toBe(false); // 'F' 단독은 F키가 아님
  });
});

describe('hasBareFunctionKeyBinding', () => {
  it('returns true only when a binding uses a BARE function key', () => {
    expect(hasBareFunctionKeyBinding([kb('Ctrl+Shift+1'), kb('F7')])).toBe(true);
    // Ctrl+F7(Mac 기본값)은 정상 동작하므로 안내 대상이 아니다.
    expect(hasBareFunctionKeyBinding([kb('Ctrl+F7')])).toBe(false);
  });

  it('returns false when no binding uses a function key', () => {
    expect(hasBareFunctionKeyBinding([kb('Ctrl+Shift+1'), kb('A')])).toBe(false);
    expect(hasBareFunctionKeyBinding([])).toBe(false);
  });
});
