/**
 * Phase A (cross-platform) — platform invariants for AutoUpdater.
 *
 * The in-app updater is Windows-only today: the feed URL, the temp installer
 * filename, and the launch verb are all Squirrel.Windows-shaped. This suite
 * pins two invariants BEFORE the later (Phase E) platformChoice refactor:
 *
 *   1. win32 is byte-for-byte unchanged — start() schedules a check that hits
 *      the EXACT update.electronjs.org/<repo>/win32/<version> feed URL.
 *   2. off win32 the updater is inert — no auto-check timer, UPDATE_CHECK
 *      resolves not-available, and UPDATE_INSTALL never touches the network
 *      (so a macOS/Linux client can never download/launch a .Setup.exe even
 *      when all OSes share one GitHub release's assets).
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

const realPlatform = process.platform;
const tempDirs: string[] = [];

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
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
) {
  vi.resetModules();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

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

  vi.doMock('electron', () => ({
    autoUpdater: {},
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
  return { AutoUpdater: mod.AutoUpdater, requestUrls, ipcHandlers, ipcListeners, request, appQuit, shellOpenPath };
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

  it.each(['darwin', 'linux'] as const)(
    '%s: start() never schedules a check and never touches the network',
    async (platform) => {
      vi.useFakeTimers();
      const { AutoUpdater, requestUrls } = await loadForPlatform(platform);

      const updater = new AutoUpdater(() => null);
      updater.start();

      // Advance well past the first-check delay AND a full interval.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(requestUrls).toHaveLength(0);
      updater.stop();
    },
  );

  it.each(['darwin', 'linux'] as const)(
    '%s: UPDATE_CHECK resolves not-available and UPDATE_INSTALL is an inert no-op',
    async (platform) => {
      const { AutoUpdater, ipcHandlers, requestUrls } = await loadForPlatform(platform);

      const updater = new AutoUpdater(() => null);
      updater.start();

      const checkHandler = ipcHandlers.get(IPC.UPDATE_CHECK);
      const installHandler = ipcHandlers.get(IPC.UPDATE_INSTALL);
      if (typeof checkHandler !== 'function' || typeof installHandler !== 'function') {
        throw new Error('UPDATE_CHECK / UPDATE_INSTALL handlers were not registered');
      }

      await expect(checkHandler()).resolves.toEqual({ status: 'not-available' });

      // Install must not fetch a manifest or download anything off win32.
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
   * Drive check() → auto-download → 'downloaded' with real timers. IPC
   * handlers are registered directly (not via start()) so no stray 15s
   * background-check timer outlives the test.
   */
  async function downloadUpdateFor(loaded: Awaited<ReturnType<typeof loadForPlatform>>) {
    const { AutoUpdater, ipcHandlers } = loaded;
    const { win, sent } = makeWin();
    const updater = new AutoUpdater(() => win as never);
    (updater as unknown as { registerIpcHandlers: () => void }).registerIpcHandlers();

    const checkHandler = ipcHandlers.get(IPC.UPDATE_CHECK);
    const installHandler = ipcHandlers.get(IPC.UPDATE_INSTALL);
    if (typeof checkHandler !== 'function' || typeof installHandler !== 'function') {
      throw new Error('UPDATE_CHECK / UPDATE_INSTALL handlers were not registered');
    }
    await checkHandler();
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
