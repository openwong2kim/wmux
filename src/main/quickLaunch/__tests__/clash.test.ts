import { describe, expect, it, vi } from 'vitest';
import { clashesWithBuiltin } from '../index';

vi.mock('electron', () => ({ globalShortcut: {}, ipcMain: {}, BrowserWindow: class {}, screen: {} }));

describe('clashesWithBuiltin', () => {
  it('flags a chord wmux already uses and allows the default', () => {
    // ⌘K is the command palette.
    expect(clashesWithBuiltin('CommandOrControl+K', 'darwin')).toBe(true);
    expect(clashesWithBuiltin('CommandOrControl+Shift+Space', 'darwin')).toBe(false);
    expect(clashesWithBuiltin('CommandOrControl+Shift+Space', 'win32')).toBe(false);
  });
});
