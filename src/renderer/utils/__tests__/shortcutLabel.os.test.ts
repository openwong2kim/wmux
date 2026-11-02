import { describe, expect, it } from 'vitest';
import { shortcutLabel, withShortcut } from '../shortcutLabel';

describe('shortcutLabel', () => {
  it('labels the shortcut the way each keyboard reads it', () => {
    expect(shortcutLabel('darwin', 'Meta+K')).toBe('⌘K');
    expect(shortcutLabel('darwin', 'Meta+Shift+D')).toBe('⇧⌘D');
    expect(shortcutLabel('win32', 'Ctrl+K')).toBe('Ctrl+K');
    expect(shortcutLabel('win32', 'Ctrl+Shift+D')).toBe('Ctrl+Shift+D');
    expect(shortcutLabel('linux', undefined)).toBe('');
  });

  it('puts the key after a tooltip label, and nothing when there is no key', () => {
    expect(withShortcut('New workspace', '⌘N')).toBe('New workspace (⌘N)');
    expect(withShortcut('New workspace', '')).toBe('New workspace');
  });
});
