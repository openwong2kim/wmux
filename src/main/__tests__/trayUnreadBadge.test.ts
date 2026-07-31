import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// The IPC listener is the trust boundary for this value: it comes from the
// renderer, so main normalizes it before any platform call. registerHandlers.ts
// pulls in the whole main-process handler graph (PTYManager, DaemonClient, MCP),
// so the listener is not importable in a unit test — these pin the normalization
// and the static (non-`require`) wiring at the source level, the same pattern
// used elsewhere for main/renderer wiring that cannot be imported under vitest.
describe('NOTIFICATION_BADGE_COUNT listener wiring', () => {
  const src = new URL('../ipc/registerHandlers.ts', import.meta.url).pathname;
  let text = '';

  beforeEach(async () => {
    const fs = await import('node:fs');
    text = fs.readFileSync(src, 'utf-8');
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
