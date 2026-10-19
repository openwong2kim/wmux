import { describe, expect, it } from 'vitest';
import { shortcutLabel } from '../shortcutLabel';

describe('shortcutLabel', () => {
  it('labels the shortcut the way each keyboard reads it', () => {
    expect(shortcutLabel('darwin', 'Meta+K')).toBe('⌘K');
    expect(shortcutLabel('win32', 'Ctrl+K')).toBe('Ctrl+K');
    expect(shortcutLabel('linux', undefined)).toBe('');
  });
});
