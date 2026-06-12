import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { shouldPollMetadata } from '../metadata.handler';

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  BrowserWindow: {},
}));

/** Build a fake BrowserWindow with overridable visibility predicates. */
function fakeWindow(overrides: Partial<{
  destroyed: boolean;
  loading: boolean;
  visible: boolean;
  minimized: boolean;
}> = {}): BrowserWindow {
  const o = { destroyed: false, loading: false, visible: true, minimized: false, ...overrides };
  return {
    isDestroyed: () => o.destroyed,
    isVisible: () => o.visible,
    isMinimized: () => o.minimized,
    webContents: { isLoading: () => o.loading },
  } as unknown as BrowserWindow;
}

describe('shouldPollMetadata', () => {
  it('polls when the window is visible, loaded, and not minimized', () => {
    expect(shouldPollMetadata(fakeWindow())).toBe(true);
  });

  it('skips when the window is hidden to tray', () => {
    expect(shouldPollMetadata(fakeWindow({ visible: false }))).toBe(false);
  });

  it('skips when the window is minimized', () => {
    expect(shouldPollMetadata(fakeWindow({ minimized: true }))).toBe(false);
  });

  it('skips while the renderer is still loading', () => {
    expect(shouldPollMetadata(fakeWindow({ loading: true }))).toBe(false);
  });

  it('skips when the window is destroyed', () => {
    expect(shouldPollMetadata(fakeWindow({ destroyed: true }))).toBe(false);
  });
});
