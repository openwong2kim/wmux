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
import { IPC } from '../../../shared/constants';

const FAKE_VERSION = '9.9.9';
const EXPECTED_WIN32_FEED = `https://update.electronjs.org/openwong2kim/wmux/win32/${FAKE_VERSION}`;

const realPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.resetModules();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/**
 * (Re)load AutoUpdater with process.platform overridden and electron mocked.
 * Returns the class plus probes: every net.request URL, and the captured
 * ipcMain handlers so tests can invoke UPDATE_CHECK / UPDATE_INSTALL directly.
 */
async function loadForPlatform(platform: NodeJS.Platform) {
  vi.resetModules();
  // start() bails early when NODE_ENV === 'development', so pin a non-dev value.
  // Otherwise these win32 invariants silently no-op when the suite is run from a
  // shell that exports NODE_ENV=development (e.g. inside wmux's own dev session).
  vi.stubEnv('NODE_ENV', 'production');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  const requestUrls: string[] = [];
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcListeners = new Map<string, (...args: unknown[]) => unknown>();

  // Minimal net.request that records the URL and emits a 204 (no update).
  const request = vi.fn((url: string) => {
    requestUrls.push(url);
    const cbs: Record<string, (arg: unknown) => void> = {};
    const req = {
      on(ev: string, cb: (arg: unknown) => void) { cbs[ev] = cb; return req; },
      end() {
        // Async 204 response so check()'s promise settles like the real path.
        Promise.resolve().then(() => {
          const resp = { statusCode: 204, on: () => resp };
          cbs['response']?.(resp);
        });
      },
    };
    return req;
  });

  vi.doMock('electron', () => ({
    autoUpdater: {},
    app: { getVersion: () => FAKE_VERSION, getPath: () => '/tmp' },
    ipcMain: {
      on: (ch: string, cb: (...a: unknown[]) => unknown) => { ipcListeners.set(ch, cb); },
      handle: (ch: string, cb: (...a: unknown[]) => unknown) => { ipcHandlers.set(ch, cb); },
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn(),
    },
    net: { request },
    shell: { openPath: vi.fn(), openExternal: vi.fn() },
  }));

  const mod = await import('../AutoUpdater');
  return { AutoUpdater: mod.AutoUpdater, requestUrls, ipcHandlers, ipcListeners, request };
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
