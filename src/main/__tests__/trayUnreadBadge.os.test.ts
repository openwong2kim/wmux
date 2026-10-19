import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// E5 — the platform unread badge. macOS gets a real dock badge; Windows/Linux
// have no dock, so the count is prefixed onto the tray tooltip instead. These
// lock the two platform branches, the clear-at-zero contract, and the 999+ cap.

const setBadgeMock = vi.fn();
const setToolTipMock = vi.fn();

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    setAboutPanelOptions: vi.fn(),
    dock: { setBadge: setBadgeMock },
  },
  Tray: class {
    setToolTip = setToolTipMock;
    setContextMenu = vi.fn();
    on = vi.fn();
    destroy = vi.fn();
  },
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: {
    createFromPath: vi.fn(() => ({ setTemplateImage: vi.fn(), resize: vi.fn() })),
  },
  BrowserWindow: vi.fn(),
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: {},
}));

/** Load tray.ts under a given platform, optionally creating the Tray first. */
async function loadTray(
  platform: string,
  opts: { withTray?: boolean } = {},
): Promise<typeof import('../tray')> {
  vi.stubGlobal('process', { ...process, platform });
  const mod = await import('../tray');
  if (opts.withTray) {
    const fakeWindow = { show: vi.fn(), focus: vi.fn() } as unknown as import('electron').BrowserWindow;
    mod.createTray(fakeWindow, { onQuit: vi.fn(), onShutdownAll: vi.fn() });
    setToolTipMock.mockClear();
  }
  return mod;
}

describe('updateUnreadBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('macOS (dock badge)', () => {
    it('writes the count as a string', async () => {
      const { updateUnreadBadge } = await loadTray('darwin');
      updateUnreadBadge(3);
      expect(setBadgeMock).toHaveBeenCalledWith('3');
    });

    it('clears the badge with an empty string at zero', async () => {
      const { updateUnreadBadge } = await loadTray('darwin');
      updateUnreadBadge(0);
      expect(setBadgeMock).toHaveBeenCalledWith('');
    });

    it('caps a runaway count at 999+ so the badge stays readable', async () => {
      const { updateUnreadBadge } = await loadTray('darwin');
      updateUnreadBadge(1000);
      expect(setBadgeMock).toHaveBeenCalledWith('999+');
    });

    it('does not cap at exactly 999', async () => {
      const { updateUnreadBadge } = await loadTray('darwin');
      updateUnreadBadge(999);
      expect(setBadgeMock).toHaveBeenCalledWith('999');
    });

    it('never touches the tray tooltip on mac (the dock owns the count)', async () => {
      const { updateUnreadBadge } = await loadTray('darwin', { withTray: true });
      updateUnreadBadge(5);
      expect(setToolTipMock).not.toHaveBeenCalled();
    });
  });

  describe('Windows / Linux (tray tooltip)', () => {
    it('prefixes the tooltip with the count', async () => {
      const { updateUnreadBadge } = await loadTray('win32', { withTray: true });
      updateUnreadBadge(7);
      expect(setToolTipMock).toHaveBeenCalledWith('[7] wmux');
    });

    it('restores the plain tooltip at zero', async () => {
      const { updateUnreadBadge } = await loadTray('win32', { withTray: true });
      updateUnreadBadge(4);
      updateUnreadBadge(0);
      expect(setToolTipMock).toHaveBeenLastCalledWith('wmux');
    });

    it('never touches the dock badge off mac', async () => {
      const { updateUnreadBadge } = await loadTray('linux', { withTray: true });
      updateUnreadBadge(2);
      expect(setBadgeMock).not.toHaveBeenCalled();
    });

    it('is a silent no-op before the tray exists (boot ordering)', async () => {
      const { updateUnreadBadge } = await loadTray('win32');
      expect(() => updateUnreadBadge(2)).not.toThrow();
      expect(setToolTipMock).not.toHaveBeenCalled();
    });
  });
});

// The tooltip is the ONLY unread surface off macOS, and it has a second author:
// updateTraySessionCount, fired whenever the window hides to or returns from
// the tray. Each used to write the whole string, so hiding to tray with unread
// mail erased the count from the one surface still showing it — precisely the
// blind spot the badge was added for.
describe('tray tooltip composition (badge + session nudge)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('keeps the unread badge when the window hides to tray', async () => {
    const { updateUnreadBadge, updateTraySessionCount } = await loadTray('win32', { withTray: true });
    updateUnreadBadge(5);
    updateTraySessionCount(7);
    expect(setToolTipMock).toHaveBeenLastCalledWith('[5] wmux — 7 background sessions running');
  });

  it('keeps the session nudge when an unread arrives while hidden', async () => {
    const { updateUnreadBadge, updateTraySessionCount } = await loadTray('win32', { withTray: true });
    updateTraySessionCount(3);
    updateUnreadBadge(2);
    expect(setToolTipMock).toHaveBeenLastCalledWith('[2] wmux — 3 background sessions running');
  });

  it('keeps the badge when the window is shown again (nudge cleared to null)', async () => {
    const { updateUnreadBadge, updateTraySessionCount } = await loadTray('win32', { withTray: true });
    updateUnreadBadge(4);
    updateTraySessionCount(6);
    updateTraySessionCount(null);
    expect(setToolTipMock).toHaveBeenLastCalledWith('[4] wmux');
  });

  it('drops to the plain tooltip once both signals are clear', async () => {
    const { updateUnreadBadge, updateTraySessionCount } = await loadTray('win32', { withTray: true });
    updateUnreadBadge(4);
    updateTraySessionCount(6);
    updateUnreadBadge(0);
    updateTraySessionCount(null);
    expect(setToolTipMock).toHaveBeenLastCalledWith('wmux');
  });

  it('singularizes a lone background session alongside the badge', async () => {
    const { updateUnreadBadge, updateTraySessionCount } = await loadTray('win32', { withTray: true });
    updateUnreadBadge(1);
    updateTraySessionCount(1);
    expect(setToolTipMock).toHaveBeenLastCalledWith('[1] wmux — 1 background session running');
  });

  it('caps the tooltip badge at 999+ like the dock badge', async () => {
    const { updateUnreadBadge } = await loadTray('win32', { withTray: true });
    updateUnreadBadge(1000);
    expect(setToolTipMock).toHaveBeenLastCalledWith('[999+] wmux');
  });

  it('applies a badge that arrived before the tray existed', async () => {
    const mod = await loadTray('win32');
    mod.updateUnreadBadge(3);
    expect(setToolTipMock).not.toHaveBeenCalled();
    const fakeWindow = { show: vi.fn(), focus: vi.fn() } as unknown as import('electron').BrowserWindow;
    mod.createTray(fakeWindow, { onQuit: vi.fn(), onShutdownAll: vi.fn() });
    expect(setToolTipMock).toHaveBeenCalledWith('[3] wmux');
  });

  it('does not carry a count across a destroyed tray', async () => {
    const mod = await loadTray('win32', { withTray: true });
    mod.updateUnreadBadge(8);
    mod.updateTraySessionCount(2);
    mod.destroyTray();
    setToolTipMock.mockClear();
    const fakeWindow = { show: vi.fn(), focus: vi.fn() } as unknown as import('electron').BrowserWindow;
    mod.createTray(fakeWindow, { onQuit: vi.fn(), onShutdownAll: vi.fn() });
    expect(setToolTipMock).not.toHaveBeenCalledWith(expect.stringContaining('[8]'));
  });
});

// The IPC listener is the trust boundary for this value: it comes from the
// renderer, so main normalizes it before any platform call. registerHandlers.ts
// pulls in the whole main-process handler graph (PTYManager, DaemonClient, MCP),
// so the listener is not importable in a unit test — these pin the normalization
// and the static (non-`require`) wiring at the source level, the same pattern
// used elsewhere for main/renderer wiring that cannot be imported under vitest.
describe('NOTIFICATION_BADGE_COUNT listener wiring', () => {
  const src = path.join(__dirname, '..', 'ipc', 'registerHandlers.ts');
  let text = '';

  beforeEach(() => {
    text = readFileSync(src, 'utf-8');
  });

  it('imports the tray helper statically rather than with an inline require', () => {
    expect(text).toMatch(/import \{ updateUnreadBadge \} from '\.\.\/tray';/);
    expect(text).not.toMatch(/require\('\.\.\/tray'\)/);
  });

  it('normalizes the renderer count to a non-negative integer before applying it', () => {
    const block = text.slice(text.indexOf('IPC.NOTIFICATION_BADGE_COUNT'));
    expect(block).toMatch(/Number\.isFinite\(count\)/);
    expect(block).toMatch(/Math\.floor\(count\)/);
    expect(block).toMatch(/:\s*0;/);
  });

  it('removes the listener on cleanup so a handler swap cannot double-register', () => {
    const removals = text.match(/removeAllListeners\(IPC\.NOTIFICATION_BADGE_COUNT\)/g) ?? [];
    // Once defensively before registering, once in the cleanup function.
    expect(removals.length).toBeGreaterThanOrEqual(2);
  });
});
