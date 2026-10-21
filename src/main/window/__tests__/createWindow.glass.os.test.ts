import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The options createWindow hands to BrowserWindow, per platform, Windows build
// and persisted glass level. platform.ts reads process.platform when it loads,
// so each case stubs the platform and imports createWindow afresh.

const h = vi.hoisted(() => ({
  release: '10.0.26200',
  options: [] as Array<Record<string, unknown>>,
  themeAtConstruction: [] as string[],
  nativeTheme: { themeSource: 'system' as 'system' | 'light' | 'dark' },
  plan: { maximized: false, fullScreen: false },
  windows: [] as Array<{ maximize: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; fire(event: string): void }>,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, release: () => h.release };
  return { ...mocked, default: mocked };
});

vi.mock('electron', () => {
  class BrowserWindow {
    private visible: boolean;
    private handlers = new Map<string, () => void>();
    webContents = {
      on: vi.fn(),
      once: vi.fn(),
      ipc: { handle: vi.fn() },
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      session: { webRequest: { onHeadersReceived: vi.fn() } },
    };
    constructor(opts: Record<string, unknown>) {
      h.options.push(opts);
      h.themeAtConstruction.push(h.nativeTheme.themeSource);
      this.visible = opts.show !== false;
      h.windows.push(this);
    }
    on = vi.fn();
    once = vi.fn((event: string, handler: () => void) => { this.handlers.set(event, handler); });
    fire(event: string): void { this.handlers.get(event)?.(); }
    // Electron's maximize() shows a hidden window.
    maximize = vi.fn(() => { this.visible = true; });
    show = vi.fn(() => { this.visible = true; });
    focus = vi.fn();
    isVisible = () => this.visible;
    isDestroyed = () => false;
  }
  return {
    app: { isPackaged: false },
    BrowserWindow,
    nativeTheme: h.nativeTheme,
    powerMonitor: { on: vi.fn() },
    screen: { getAllDisplays: () => [] },
    shell: { openExternal: vi.fn() },
  };
});

vi.mock('../windowDisplayed', () => ({ windowDisplayedReporter: { attach: vi.fn() } }));
vi.mock('../flashFrame', () => ({ attachFlashFrameAutoClear: vi.fn() }));
vi.mock('../windowState', () => ({
  DEFAULT_WINDOW_SIZE: { width: 1280, height: 800 },
  MIN_WINDOW_SIZE: { width: 600, height: 400 },
  loadWindowState: () => null,
  planRestore: () => h.plan,
  saveWindowState: vi.fn(),
  saveWindowStateSync: vi.fn(),
}));

const realPlatform = process.platform;

async function optionsFor(
  platform: NodeJS.Platform,
  release: string,
  windowGlass: unknown,
  windowAppearance?: unknown,
  windowGlassEffective?: unknown,
) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  h.release = release;
  h.options.length = 0;
  h.themeAtConstruction.length = 0;
  h.nativeTheme.themeSource = 'system';
  h.windows.length = 0;
  vi.resetModules();
  const { createWindow } = await import('../createWindow');
  const { isWindowGlassOn } = await import('../windowGlass');
  const win = createWindow({ deferLoad: true, windowGlass, windowGlassEffective, windowAppearance });
  // The appearance as the window was built: what DWM tints the first frames with.
  return { opts: h.options[0], glassOn: isWindowGlassOn(win), themeSource: h.themeAtConstruction[0], win: h.windows[0] };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_DEV_SERVER_URL = 'http://127.0.0.1:5173/';
});

afterEach(() => {
  h.plan = { maximized: false, fullScreen: false };
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  delete (globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_DEV_SERVER_URL;
});

describe('createWindow window glass options', () => {
  it.each(['soft', 'clear', null])('Windows 11 26200 with level %s: acrylic behind a transparent window', async (level) => {
    const { opts, glassOn } = await optionsFor('win32', '10.0.26200', level);
    expect(opts.backgroundMaterial).toBe('acrylic');
    expect(opts.backgroundColor).toBe('#00000000');
    expect(opts.titleBarOverlay).toEqual({ color: '#00000000', symbolColor: '#C2BDC9', height: 40 });
    expect(opts.vibrancy).toBeUndefined();
    expect(glassOn).toBe(true);
  });

  it('Windows 11 with glass Off: an opaque window in the dark frame colour', async () => {
    const { opts, glassOn } = await optionsFor('win32', '10.0.26200', 'off');
    expect(opts.backgroundMaterial).toBeUndefined();
    expect(opts.backgroundColor).toBe('#121015');
    expect(opts.titleBarOverlay).toEqual({ color: '#121015', symbolColor: '#C2BDC9', height: 40 });
    expect(glassOn).toBe(false);
  });

  it('Windows 11 with glass Off and a light theme saved: the light frame colour (#2512)', async () => {
    const { opts } = await optionsFor('win32', '10.0.26200', 'off', 'light');
    expect(opts.backgroundColor).toBe('#ECECEF');
    expect(opts.titleBarOverlay).toEqual({ color: '#ECECEF', symbolColor: '#3F3F48', height: 40 });
  });

  it.each(['10.0.19045', '10.0.22000'])('Windows build %s: opaque whatever the level', async (release) => {
    const { opts, glassOn } = await optionsFor('win32', release, 'clear');
    expect(opts.backgroundMaterial).toBeUndefined();
    expect(opts.backgroundColor).toBe('#121015');
    expect(opts.titleBarOverlay).toEqual({ color: '#121015', symbolColor: '#C2BDC9', height: 40 });
    expect(glassOn).toBe(false);
  });

  it('macOS keeps its vibrancy material and no acrylic', async () => {
    const { opts } = await optionsFor('darwin', '25.0.0', 'soft');
    expect(opts.vibrancy).toBe('sidebar');
    expect(opts.backgroundColor).toBe('#00000000');
    expect(opts.backgroundMaterial).toBeUndefined();
    expect(opts.titleBarOverlay).toBeUndefined();
  });

  it('Linux stays opaque, in the dark start colour by default', async () => {
    const { opts } = await optionsFor('linux', '6.8.0', 'soft');
    expect(opts.backgroundColor).toBe('#121015');
    expect(opts.backgroundMaterial).toBeUndefined();
    expect(opts.vibrancy).toBeUndefined();
  });

  it('Linux with a light theme saved starts in the light start colour (#2512)', async () => {
    const { opts } = await optionsFor('linux', '6.8.0', 'soft', 'light');
    expect(opts.backgroundColor).toBe('#ECECEF');
  });
});

describe('createWindow for a theme that blocked glass at the last save', () => {
  // The renderer turns Windows glass off for a theme whose text cannot stay
  // legible over it and saves that as `windowGlassEffective`, keeping the
  // user's Soft or Clear. The next launch must start the way the window will
  // stay: the opaque path, not acrylic until the renderer loads.
  it.each(['soft', 'clear'])('level %s with the window last shown Off: the same opaque start as glass Off', async (level) => {
    const blocked = await optionsFor('win32', '10.0.26200', level, 'dark', 'off');
    const off = await optionsFor('win32', '10.0.26200', 'off', 'dark');
    expect(blocked.opts).toEqual(off.opts);
    expect(blocked.opts.show).toBe(false);
    expect(blocked.opts.backgroundMaterial).toBeUndefined();
    expect(blocked.glassOn).toBe(false);
    // No appearance override either: the renderer hands it to the system.
    expect(blocked.themeSource).toBe('system');
  });

  it('a light theme that blocked glass starts in the light frame colour, hidden until painted', async () => {
    const { opts } = await optionsFor('win32', '10.0.26200', 'soft', 'light', 'off');
    expect(opts.backgroundColor).toBe('#ECECEF');
    expect(opts.show).toBe(false);
  });

  it.each(['soft', 'clear', null, undefined])('the window last shown %s starts with acrylic at Soft', async (effective) => {
    const { opts, glassOn } = await optionsFor('win32', '10.0.26200', 'soft', 'dark', effective);
    expect(opts.backgroundMaterial).toBe('acrylic');
    expect(glassOn).toBe(true);
  });
});

describe('createWindow app appearance before a glass window exists', () => {
  it('sets the saved polarity before building an acrylic window', async () => {
    expect((await optionsFor('win32', '10.0.26200', 'soft', 'light')).themeSource).toBe('light');
    expect((await optionsFor('win32', '10.0.26200', 'clear', 'dark')).themeSource).toBe('dark');
  });

  it('uses dark, the default theme, on a first run with no session', async () => {
    expect((await optionsFor('win32', '10.0.26200', null, undefined)).themeSource).toBe('dark');
  });

  it('keeps the system appearance for a session saved before the polarity was', async () => {
    expect((await optionsFor('win32', '10.0.26200', 'soft', null)).themeSource).toBe('system');
  });

  it('keeps the system appearance when the window starts opaque', async () => {
    expect((await optionsFor('win32', '10.0.26200', 'off', 'dark')).themeSource).toBe('system');
    expect((await optionsFor('win32', '10.0.19045', 'soft', 'dark')).themeSource).toBe('system');
  });

  it('leaves macOS and Linux to the renderer', async () => {
    expect((await optionsFor('darwin', '25.0.0', 'soft', 'light')).themeSource).toBe('system');
    expect((await optionsFor('linux', '6.8.0', 'soft', 'light')).themeSource).toBe('system');
  });
});

describe('createWindow first frames (#2512)', () => {
  it('builds the opaque Windows window hidden and shows it on its first paint', async () => {
    const { opts, win } = await optionsFor('win32', '10.0.26200', 'off', 'dark');
    expect(opts.show).toBe(false);
    expect(win.show).not.toHaveBeenCalled();
    win.fire('ready-to-show');
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('maximizes a restored maximized window when it is revealed, not before', async () => {
    h.plan = { maximized: true, fullScreen: false };
    const { win } = await optionsFor('win32', '10.0.26200', 'off', 'dark');
    expect(win.maximize).not.toHaveBeenCalled();
    win.fire('ready-to-show');
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
  });

  it('shows a glass window at once, and maximizes it at once', async () => {
    h.plan = { maximized: true, fullScreen: false };
    const { opts, win } = await optionsFor('win32', '10.0.26200', 'soft', 'dark');
    expect(opts.show).toBeUndefined();
    expect(win.maximize).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['win32', '10.0.26200', 'off', 'light'],
    ['win32', '10.0.26200', 'soft', 'light'],
    ['darwin', '25.0.0', 'soft', 'light'],
    ['linux', '6.8.0', 'soft', 'dark'],
    ['win32', '10.0.26200', 'off', undefined],
  ] as const)('on %s (%s, glass %s) passes the saved polarity %s to the preload', async (platform, release, level, appearance) => {
    const { opts } = await optionsFor(platform, release, level, appearance);
    const prefs = opts.webPreferences as { additionalArguments?: string[] };
    expect(prefs.additionalArguments).toEqual([`--wmux-start-polarity=${appearance ?? 'dark'}`]);
  });
});
