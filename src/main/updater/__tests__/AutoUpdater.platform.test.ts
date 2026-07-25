/**
 * Phase A (cross-platform) — platform invariants for AutoUpdater.
 *
 * The in-app updater ships for Windows (Squirrel.Windows) and Apple Silicon
 * macOS (Squirrel.Mac). This suite pins three invariants:
 *
 *   1. win32 is byte-for-byte unchanged — start() schedules a check that hits
 *      the EXACT update.electronjs.org/<repo>/win32/<version> feed URL.
 *   2. darwin-arm64 polls its OWN feed segment and manifest file, so the two
 *      platforms can never be served each other's artifacts.
 *   3. on every other platform (linux, Intel macOS — no build is produced) the
 *      updater is inert: no auto-check timer, UPDATE_CHECK resolves
 *      not-available, and UPDATE_INSTALL never touches the network, even
 *      though all OSes share one GitHub release's assets.
 *
 * AutoUpdater is electron-heavy, so we mock 'electron' and re-import the module
 * per platform (à la ToastManager.test.ts) with process.platform overridden.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC } from '../../../shared/constants';

const FAKE_VERSION = '9.9.9';
const EXPECTED_WIN32_FEED = `https://update.electronjs.org/openwong2kim/wmux/win32/${FAKE_VERSION}`;
const EXPECTED_DARWIN_FEED = `https://update.electronjs.org/openwong2kim/wmux/darwin-arm64/${FAKE_VERSION}`;

/** Platforms with no in-app updater: [platform, arch]. */
const UNSUPPORTED: ReadonlyArray<readonly [NodeJS.Platform, string]> = [
  ['linux', 'x64'],
  ['darwin', 'x64'], // Intel macOS — no build is produced
];

const realPlatform = process.platform;
const realArch = process.arch;
const tempDirs: string[] = [];

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
  vi.resetModules();
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Fixed response a test can serve for a given URL (body emitted as one chunk). */
interface FakeRoute { statusCode: number; body?: Buffer }

/**
 * (Re)load AutoUpdater with process.platform overridden and electron mocked.
 * Returns the class plus probes: every net.request URL, the captured ipcMain
 * handlers so tests can invoke UPDATE_CHECK / UPDATE_INSTALL directly, and
 * spies for shell.openPath / app.quit (#502). `routes` lets a test serve real
 * responses per URL; unrouted URLs get a 204 (no update).
 */
async function loadForPlatform(
  platform: NodeJS.Platform,
  routes?: (url: string) => FakeRoute | undefined,
  arch: string = platform === 'darwin' ? 'arm64' : 'x64',
) {
  vi.resetModules();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });

  const requestUrls: string[] = [];
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcListeners = new Map<string, (...args: unknown[]) => unknown>();
  // Downloads write through a real fs stream — give app.getPath('temp') a
  // real, throwaway directory instead of a shared literal.
  const tempPathDir = mkdtempSync(join(tmpdir(), 'wmux-autoupdater-test-'));
  tempDirs.push(tempPathDir);

  // Minimal net.request honoring `routes`; unrouted URLs emit a 204.
  const request = vi.fn((url: string) => {
    requestUrls.push(url);
    const cbs: Record<string, (arg: unknown) => void> = {};
    const req = {
      on(ev: string, cb: (arg: unknown) => void) { cbs[ev] = cb; return req; },
      end() {
        // Async response so check()'s promise settles like the real path.
        Promise.resolve().then(() => {
          const route = routes?.(url);
          if (!route) {
            const resp = { statusCode: 204, on: () => resp };
            cbs['response']?.(resp);
            return;
          }
          const handlers: Record<string, (arg?: unknown) => void> = {};
          const resp = {
            statusCode: route.statusCode,
            headers: {} as Record<string, string>,
            on(ev: string, cb: (arg?: unknown) => void) { handlers[ev] = cb; return resp; },
          };
          cbs['response']?.(resp);
          // data/end listeners attach synchronously inside the response
          // callback; deliver the body on the next microtask.
          Promise.resolve().then(() => {
            if (route.body !== undefined) handlers['data']?.(route.body);
            handlers['end']?.();
          });
        });
      },
    };
    return req;
  });

  const appQuit = vi.fn();
  const shellOpenPath = vi.fn(async (_path: string) => '');

  // Stand-in for Electron's built-in (Squirrel.Mac) autoUpdater: records the
  // feed handed to it and lets a test emit 'update-downloaded' / 'error'.
  const nativeListeners = new Map<string, Array<(arg?: unknown) => void>>();
  const nativeUpdater = {
    setFeedURL: vi.fn((_opts: { url: string; serverType?: string }) => undefined),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn((ev: string, cb: (arg?: unknown) => void) => {
      const list = nativeListeners.get(ev) ?? [];
      list.push(cb);
      nativeListeners.set(ev, list);
    }),
    removeAllListeners: vi.fn((ev: string) => { nativeListeners.delete(ev); }),
    emit: (ev: string, arg?: unknown) => {
      for (const cb of nativeListeners.get(ev) ?? []) cb(arg);
    },
  };

  vi.doMock('electron', () => ({
    autoUpdater: nativeUpdater,
    app: { getVersion: () => FAKE_VERSION, getPath: () => tempPathDir, quit: appQuit },
    ipcMain: {
      on: (ch: string, cb: (...a: unknown[]) => unknown) => { ipcListeners.set(ch, cb); },
      handle: (ch: string, cb: (...a: unknown[]) => unknown) => { ipcHandlers.set(ch, cb); },
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn(),
    },
    net: { request },
    shell: { openPath: shellOpenPath, openExternal: vi.fn() },
  }));

  const mod = await import('../AutoUpdater');
  return { AutoUpdater: mod.AutoUpdater, requestUrls, ipcHandlers, ipcListeners, request, appQuit, shellOpenPath, nativeUpdater };
}

describe('AutoUpdater platform gating', () => {
  it('win32: start() schedules a check that hits the exact win32 feed URL (byte-identical)', async () => {
    vi.useFakeTimers();
    const { AutoUpdater, requestUrls } = await loadForPlatform('win32');

    const updater = new AutoUpdater(() => null);
    updater.start();

    // First check fires 15s after start.
    await vi.advanceTimersByTimeAsync(15_000);

    expect(requestUrls).toContain(EXPECTED_WIN32_FEED);
    updater.stop();
  });

  it('win32: periodic timer keeps polling the win32 feed', async () => {
    vi.useFakeTimers();
    const { AutoUpdater, requestUrls } = await loadForPlatform('win32');

    const updater = new AutoUpdater(() => null);
    updater.start();
    await vi.advanceTimersByTimeAsync(15_000); // first check
    const afterFirst = requestUrls.length;
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000); // one interval
    expect(requestUrls.length).toBeGreaterThan(afterFirst);
    expect(requestUrls.every((u) => u === EXPECTED_WIN32_FEED)).toBe(true);
    updater.stop();
  });

  it('darwin-arm64: start() schedules a check that hits the darwin-arm64 feed URL', async () => {
    vi.useFakeTimers();
    const { AutoUpdater, requestUrls } = await loadForPlatform('darwin');

    const updater = new AutoUpdater(() => null);
    updater.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(requestUrls).toContain(EXPECTED_DARWIN_FEED);
    // Never the Windows feed: the two platforms' artifacts must not cross.
    expect(requestUrls).not.toContain(EXPECTED_WIN32_FEED);
    updater.stop();
  });

  it('darwin-arm64: UPDATE_CHECK reports checking (updater is active)', async () => {
    vi.useFakeTimers();
    const { AutoUpdater, ipcHandlers } = await loadForPlatform('darwin');

    const updater = new AutoUpdater(() => null);
    updater.start();

    const checkHandler = ipcHandlers.get(IPC.UPDATE_CHECK);
    if (typeof checkHandler !== 'function') throw new Error('UPDATE_CHECK handler was not registered');
    await expect(checkHandler()).resolves.toEqual({ status: 'checking' });

    updater.stop();
  });

  it.each(UNSUPPORTED)(
    '%s-%s: start() never schedules a check and never touches the network',
    async (platform, arch) => {
      vi.useFakeTimers();
      const { AutoUpdater, requestUrls } = await loadForPlatform(platform, undefined, arch);

      const updater = new AutoUpdater(() => null);
      updater.start();

      // Advance well past the first-check delay AND a full interval.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(requestUrls).toHaveLength(0);
      updater.stop();
    },
  );

  it.each(UNSUPPORTED)(
    '%s-%s: UPDATE_CHECK resolves not-available and UPDATE_INSTALL is an inert no-op',
    async (platform, arch) => {
      const { AutoUpdater, ipcHandlers, requestUrls } = await loadForPlatform(platform, undefined, arch);

      const updater = new AutoUpdater(() => null);
      updater.start();

      const checkHandler = ipcHandlers.get(IPC.UPDATE_CHECK);
      const installHandler = ipcHandlers.get(IPC.UPDATE_INSTALL);
      if (typeof checkHandler !== 'function' || typeof installHandler !== 'function') {
        throw new Error('UPDATE_CHECK / UPDATE_INSTALL handlers were not registered');
      }

      await expect(checkHandler()).resolves.toEqual({ status: 'not-available' });

      // Install must not fetch a manifest or download anything here.
      await installHandler();
      expect(requestUrls).toHaveLength(0);

      updater.stop();
    },
  );

  it('win32: UPDATE_CHECK reports checking (updater is active)', async () => {
    vi.useFakeTimers();
    const { AutoUpdater, ipcHandlers } = await loadForPlatform('win32');

    const updater = new AutoUpdater(() => null);
    updater.start();

    const checkHandler = ipcHandlers.get(IPC.UPDATE_CHECK);
    if (typeof checkHandler !== 'function') throw new Error('UPDATE_CHECK handler was not registered');
    await expect(checkHandler()).resolves.toEqual({ status: 'checking' });

    updater.stop();
  });
});

// #502 — Squirrel's installer crashes when run while the app is still alive,
// so "Restart to install" must actually restart: after launching the verified
// installer, the app quits (normal quit = detach; daemon + sessions persist).
// These tests drive the real two-step flow (feed → manifest → download →
// sha256 verify) through the mocked net layer, then invoke UPDATE_INSTALL.
describe('AutoUpdater #502 — quit after launching the installer', () => {
  const UPDATE_VERSION = '9.9.10';
  const INSTALLER_BYTES = Buffer.from('fake-installer-bytes-for-#502');
  const INSTALLER_SHA256 = createHash('sha256').update(INSTALLER_BYTES).digest('hex');
  const DOWNLOAD_URL = `https://github.com/openwong2kim/wmux/releases/download/v${UPDATE_VERSION}/wmux-${UPDATE_VERSION}.Setup.exe`;

  const downloadRoutes = (url: string) => {
    if (url === EXPECTED_WIN32_FEED) {
      return {
        statusCode: 200,
        body: Buffer.from(JSON.stringify({ name: `v${UPDATE_VERSION}`, notes: 'notes', url: DOWNLOAD_URL })),
      };
    }
    if (url.endsWith('/update-manifest.json')) {
      return {
        statusCode: 200,
        body: Buffer.from(JSON.stringify({
          version: UPDATE_VERSION,
          setupExe: `wmux-${UPDATE_VERSION}.Setup.exe`,
          sha256: INSTALLER_SHA256,
          url: DOWNLOAD_URL,
        })),
      };
    }
    if (url === DOWNLOAD_URL) return { statusCode: 200, body: INSTALLER_BYTES };
    return undefined;
  };

  /** Fake BrowserWindow that records every sendToRenderer payload. */
  function makeWin() {
    const sent: Array<{ channel: string; data: Record<string, unknown> }> = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, data: Record<string, unknown>) => { sent.push({ channel, data }); },
        isCrashed: () => false,
        executeJavaScript: async () => undefined,
      },
    };
    return { win, sent };
  }

  async function until(cond: () => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * Drive a background check() → auto-download → 'downloaded' with real timers.
   * A background (non-one-shot) check downloads WITHOUT auto-installing, so
   * these tests can drive UPDATE_INSTALL explicitly. IPC handlers are
   * registered directly (not via start()) so no stray 15s background-check
   * timer outlives the test.
   */
  async function downloadUpdateFor(loaded: Awaited<ReturnType<typeof loadForPlatform>>) {
    const { AutoUpdater, ipcHandlers } = loaded;
    const { win, sent } = makeWin();
    const updater = new AutoUpdater(() => win as never);
    (updater as unknown as { registerIpcHandlers: () => void }).registerIpcHandlers();

    const installHandler = ipcHandlers.get(IPC.UPDATE_INSTALL);
    if (typeof installHandler !== 'function') {
      throw new Error('UPDATE_INSTALL handler was not registered');
    }
    await (updater as unknown as { check: (oneShot?: boolean) => Promise<void> }).check();
    await until(() => sent.some((m) => m.channel === IPC.UPDATE_AVAILABLE && m.data.status === 'downloaded'));
    return { updater, installHandler, sent };
  }

  it('win32: UPDATE_INSTALL launches the verified installer, then quits the app', async () => {
    const loaded = await loadForPlatform('win32', downloadRoutes);
    const { installHandler } = await downloadUpdateFor(loaded);

    await installHandler();

    expect(loaded.shellOpenPath).toHaveBeenCalledTimes(1);
    const openedPath = String(loaded.shellOpenPath.mock.calls[0]![0]);
    expect(openedPath).toContain(`wmux-update-${UPDATE_VERSION}-`);
    expect(openedPath).toContain('.Setup.exe');
    // The quit is the fix: Squirrel must never run against a live instance.
    expect(loaded.appQuit).toHaveBeenCalledTimes(1);
  });

  it('win32: a failed installer launch reports UPDATE_ERROR and does NOT quit', async () => {
    const loaded = await loadForPlatform('win32', downloadRoutes);
    const { installHandler, sent } = await downloadUpdateFor(loaded);

    loaded.shellOpenPath.mockResolvedValueOnce('access denied');
    await installHandler();

    expect(sent.some((m) => m.channel === IPC.UPDATE_ERROR)).toBe(true);
    // Quitting after a failed launch would close the app with no installer
    // running — the user would just find wmux gone.
    expect(loaded.appQuit).not.toHaveBeenCalled();
  });

  it('win32: UPDATE_INSTALL with no downloaded installer neither launches nor quits', async () => {
    const loaded = await loadForPlatform('win32'); // 204 feed — nothing downloads
    const { AutoUpdater, ipcHandlers } = loaded;
    const updater = new AutoUpdater(() => null);
    (updater as unknown as { registerIpcHandlers: () => void }).registerIpcHandlers();

    const installHandler = ipcHandlers.get(IPC.UPDATE_INSTALL);
    if (typeof installHandler !== 'function') throw new Error('UPDATE_INSTALL handler was not registered');
    await installHandler();

    expect(loaded.shellOpenPath).not.toHaveBeenCalled();
    expect(loaded.appQuit).not.toHaveBeenCalled();
  });
});

// macOS install path — the verified ZIP is handed to Squirrel.Mac through a
// loopback JSON feed (Squirrel refuses file:// feeds). These tests drive the
// real detection→manifest→download→verify flow, then invoke UPDATE_INSTALL.
describe('AutoUpdater darwin-arm64 install (Squirrel.Mac loopback feed)', () => {
  const UPDATE_VERSION = '9.9.10';
  const ZIP_BYTES = Buffer.from('fake-darwin-zip-bytes');
  const ZIP_SHA256 = createHash('sha256').update(ZIP_BYTES).digest('hex');
  const ZIP_NAME = `wmux-darwin-arm64-${UPDATE_VERSION}.zip`;
  const DOWNLOAD_URL = `https://github.com/openwong2kim/wmux/releases/download/v${UPDATE_VERSION}/${ZIP_NAME}`;

  const darwinRoutes = (url: string) => {
    if (url === EXPECTED_DARWIN_FEED) {
      return {
        statusCode: 200,
        body: Buffer.from(JSON.stringify({ name: `v${UPDATE_VERSION}`, notes: 'notes', url: DOWNLOAD_URL })),
      };
    }
    if (url.endsWith('/update-manifest-darwin-arm64.json')) {
      return {
        statusCode: 200,
        body: Buffer.from(JSON.stringify({
          version: UPDATE_VERSION,
          file: ZIP_NAME,
          sha256: ZIP_SHA256,
          url: DOWNLOAD_URL,
        })),
      };
    }
    if (url === DOWNLOAD_URL) return { statusCode: 200, body: ZIP_BYTES };
    return undefined;
  };

  async function until(cond: () => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Run a background check (downloads + verifies, never auto-installs) and return the install handler. */
  async function downloadOnDarwin() {
    const loaded = await loadForPlatform('darwin', darwinRoutes);
    const sent: Array<{ channel: string; data: Record<string, unknown> }> = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, data: Record<string, unknown>) => { sent.push({ channel, data }); },
        isCrashed: () => false,
        executeJavaScript: async () => undefined,
      },
    };
    const updater = new loaded.AutoUpdater(() => win as never);
    (updater as unknown as { registerIpcHandlers: () => void }).registerIpcHandlers();
    await (updater as unknown as { check: (oneShot?: boolean) => Promise<void> }).check();
    await until(() => sent.some((m) => m.channel === IPC.UPDATE_AVAILABLE && m.data.status === 'downloaded'));
    const installHandler = loaded.ipcHandlers.get(IPC.UPDATE_INSTALL);
    if (typeof installHandler !== 'function') throw new Error('UPDATE_INSTALL handler was not registered');
    return { loaded, installHandler, sent };
  }

  it('downloads the manifest-named .zip (not a Windows .Setup.exe)', async () => {
    const { loaded } = await downloadOnDarwin();
    expect(loaded.requestUrls).toContain(DOWNLOAD_URL);
    expect(loaded.requestUrls.some((u) => u.endsWith('/update-manifest-darwin-arm64.json'))).toBe(true);
    expect(loaded.requestUrls.some((u) => u.endsWith('/update-manifest.json'))).toBe(false);
  });

  it('UPDATE_INSTALL points Squirrel.Mac at a loopback JSON feed, then quitAndInstall on update-downloaded', async () => {
    const { loaded, installHandler } = await downloadOnDarwin();

    await installHandler();
    await until(() => loaded.nativeUpdater.setFeedURL.mock.calls.length > 0);

    const feedArg = loaded.nativeUpdater.setFeedURL.mock.calls[0]![0] as { url: string; serverType?: string };
    expect(feedArg.serverType).toBe('json');
    expect(feedArg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\/feed\.json$/);
    expect(loaded.nativeUpdater.checkForUpdates).toHaveBeenCalled();
    // No Windows install verbs on this path.
    expect(loaded.shellOpenPath).not.toHaveBeenCalled();
    expect(loaded.appQuit).not.toHaveBeenCalled();

    loaded.nativeUpdater.emit('update-downloaded');
    expect(loaded.nativeUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('a Squirrel code-signature error fails closed with an actionable message', async () => {
    const { loaded, installHandler, sent } = await downloadOnDarwin();

    await installHandler();
    await until(() => loaded.nativeUpdater.setFeedURL.mock.calls.length > 0);
    loaded.nativeUpdater.emit('error', new Error('Could not get code signature for running application'));

    const err = sent.find((m) => m.channel === IPC.UPDATE_ERROR);
    expect(err).toBeDefined();
    expect(String(err!.data.message)).toContain('not code-signed');
    expect(String(err!.data.message)).toContain('releases');
    expect(loaded.nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
