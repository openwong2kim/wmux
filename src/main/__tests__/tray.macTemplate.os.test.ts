import { describe, it, expect, vi, beforeEach } from 'vitest';

// The macOS menu bar needs an alpha-only template image, not the app icon.
// Downscaling icon.icns (a 1024px art board on an opaque black plate) rendered
// as a black blob in the menu bar (owner-reported 2026-07-20). These lock that
// mac loads assets/trayTemplate.png and flags it as a template so the OS
// inverts it for light/dark menu bars, while other platforms keep icon.<ext>.

const setTemplateImageMock = vi.fn();
const trayImageMock = { setTemplateImage: setTemplateImageMock, resize: vi.fn() };
const createFromPathMock = vi.fn(() => trayImageMock);

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    setAboutPanelOptions: vi.fn(),
  },
  Tray: class {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
  },
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: { createFromPath: createFromPathMock },
  BrowserWindow: vi.fn(),
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: {},
}));

async function makeTray(platform: string): Promise<void> {
  vi.stubGlobal('process', { ...process, platform });
  const { createTray } = await import('../tray');
  const fakeWindow = { show: vi.fn(), focus: vi.fn() } as unknown as import('electron').BrowserWindow;
  createTray(fakeWindow, { onQuit: vi.fn(), onShutdownAll: vi.fn() });
}

describe('createTray icon selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    createFromPathMock.mockReturnValue(trayImageMock);
  });

  it('macOS: loads the trayTemplate asset and marks it as a template image', async () => {
    await makeTray('darwin');
    const path = createFromPathMock.mock.calls[0] as unknown as string[];
    expect(path[0]).toMatch(/trayTemplate\.png$/);
    expect(setTemplateImageMock).toHaveBeenCalledWith(true);
  });

  it('Windows: keeps the full-color app icon and does not set template mode', async () => {
    await makeTray('win32');
    const path = createFromPathMock.mock.calls[0] as unknown as string[];
    expect(path[0]).toMatch(/icon\.ico$/);
    expect(setTemplateImageMock).not.toHaveBeenCalled();
  });
});
