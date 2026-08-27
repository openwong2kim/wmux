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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC } from '../../../shared/constants';

const FAKE_VERSION = '9.9.9';
const EXPECTED_WIN32_FEED = `https://update.electronjs.org/openwong2kim/wmux/win32/${FAKE_VERSION}`;
const EXPECTED_DARWIN_FEED = `https://update.electronjs.org/openwong2kim/wmux/darwin-arm64/${FAKE_VERSION}`;

/**
 * Quit hooks every AutoUpdater needs. Required, not optional: the macOS install
 * hang existed because the main process's quit signal silently never arrived,
 * so a construction that forgets to wire it must not compile.
 */
function quitHooks() {
  return {
    onBeforeInstallQuit: vi.fn(),
    onInstallQuitAborted: vi.fn(),
    onInstallRequiresFullShutdown: vi.fn(),
    getDaemonPid: vi.fn((): number | null => null),
  };
}

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
  { isPackaged = true }: { isPackaged?: boolean } = {},
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

  // #866: the win32 install path enumerates and force-kills every process
  // under the install root, which it derives from process.execPath. Under test
  // that is the node binary, so the real implementation would target unrelated
  // node processes. Stubbed so the handoff stays observable; the real thing is
  // exercised against a sandbox in installTeardown.runtime.test.
  const teardown = {
    collectInstallRootProcesses: vi.fn((_root: string) => ({
      pids: [4242],
      ownTree: new Set<number>(),
    })),
    terminatePids: vi.fn((pids: readonly number[]): number[] => [...pids]),
    spawnInstallWaiter: vi.fn((_plan: { setupExePath: string; pids: number[] }): string | null =>
      'C:\\Temp\\waiter\\wait-and-install.ps1'),
    freeSpaceShortfall: vi.fn(() => null),
    probeVolume: vi.fn(() => ({ volume: 'C:\\', freeBytes: 9e12 })),
    readDaemonPid: vi.fn((): number | null => null),
    readAbortMarker: vi.fn((): string | null => null),
    clearAbortMarker: vi.fn(),
    // #1056 — resolves true by default so existing tests exercise the same
    // happy path as before this check existed; the dedicated test below
    // overrides it to prove the refusal branch.
    waitForWaiterHeartbeat: vi.fn(async (): Promise<boolean> => true),
    INSTALL_ABORT_MARKER: 'update-install-aborted.txt',
    INSTALL_READY_MARKER: 'update-install-ready.tmp',
  };
  vi.doMock('../installTeardown', () => teardown);

  vi.doMock('electron', () => ({
    autoUpdater: nativeUpdater,
    app: { getVersion: () => FAKE_VERSION, getPath: () => tempPathDir, quit: appQuit, isPackaged },
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
  return { AutoUpdater: mod.AutoUpdater, requestUrls, ipcHandlers, ipcListeners, request, appQuit, shellOpenPath, nativeUpdater, teardown, tempPathDir };
}

describe('AutoUpdater platform gating', () => {
  it('win32: start() schedules a check that hits the exact win32 feed URL (byte-identical)', async () => {
    vi.useFakeTimers();
    const { AutoUpdater, requestUrls } = await loadForPlatform('win32');

    const updater = new AutoUpdater(() => null, quitHooks());
    updater.start();

    // First check fires 15s after start.
    await vi.advanceTimersByTimeAsync(15_000);

    expect(requestUrls).toContain(EXPECTED_WIN32_FEED);
    updater.stop();
  });

  it('win32: periodic timer keeps polling the win32 feed', async () => {
    vi.useFakeTimers();
    const { AutoUpdater, requestUrls } = await loadForPlatform('win32');

    const updater = new AutoUpdater(() => null, quitHooks());
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

    const updater = new AutoUpdater(() => null, quitHooks());
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

    const updater = new AutoUpdater(() => null, quitHooks());
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

      const updater = new AutoUpdater(() => null, quitHooks());
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

      const updater = new AutoUpdater(() => null, quitHooks());
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

    const updater = new AutoUpdater(() => null, quitHooks());
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
  async function downloadUpdateFor(
    loaded: Awaited<ReturnType<typeof loadForPlatform>>,
    // #980 — the daemon pid reaches the updater through the HOOKS, not through
    // the teardown module, so a test about which pids get force-killed has to
    // be able to say what it is.
    hooks: ReturnType<typeof quitHooks> = quitHooks(),
  ) {
    const { AutoUpdater, ipcHandlers } = loaded;
    const { win, sent } = makeWin();
    const updater = new AutoUpdater(() => win as never, hooks);
    (updater as unknown as { registerIpcHandlers: () => void }).registerIpcHandlers();

    const installHandler = ipcHandlers.get(IPC.UPDATE_INSTALL);
    if (typeof installHandler !== 'function') {
      throw new Error('UPDATE_INSTALL handler was not registered');
    }
    await (updater as unknown as { check: (oneShot?: boolean) => Promise<void> }).check();
    await until(() => sent.some((m) => m.channel === IPC.UPDATE_AVAILABLE && m.data.status === 'downloaded'));
    return { updater, installHandler, sent };
  }

  it('win32: UPDATE_INSTALL hands the verified installer to the waiter, then quits the app', async () => {
    const loaded = await loadForPlatform('win32', downloadRoutes);
    const { installHandler } = await downloadUpdateFor(loaded);

    await installHandler();

    // #866: the installer is never started from here. Setup.exe deletes the
    // install root as its first action, so it has to be launched by something
    // that outlives us and can confirm the tree is dead first.
    expect(loaded.shellOpenPath).not.toHaveBeenCalled();
    expect(loaded.teardown.spawnInstallWaiter).toHaveBeenCalledTimes(1);
    const plan = loaded.teardown.spawnInstallWaiter.mock.calls[0]![0] as { setupExePath: string };
    expect(plan.setupExePath).toContain(`wmux-update-${UPDATE_VERSION}-`);
    expect(plan.setupExePath).toContain('.Setup.exe');
    // #502 + #866: quit so Squirrel never runs against a live instance, and ask
    // for the full shutdown so the daemon goes down with us.
    expect(loaded.appQuit).toHaveBeenCalledTimes(1);
  });

  it('win32: the kill list is what nothing else ends — not our helpers, not the daemon (#980)', async () => {
    const loaded = await loadForPlatform('win32', downloadRoutes);
    // 4242 is a stranger's MCP server; 4243 is the daemon; 4244/4245 are our
    // own renderer and GPU process, which are the same wmux.exe under the same
    // root and so are indistinguishable by path alone.
    loaded.teardown.collectInstallRootProcesses.mockReturnValue({
      pids: [4242, 4243, 4244, 4245],
      ownTree: new Set([4244, 4245]),
    });
    const hooks = { ...quitHooks(), getDaemonPid: vi.fn(() => 4243 as number | null) };
    const { installHandler } = await downloadUpdateFor(loaded, hooks);

    await installHandler();

    // Only the foreign process is killed. Killing our own renderer is what
    // broke this path: the very next step is a quit whose before-quit handler
    // awaits a session save in that renderer, and the quit then never
    // completed — leaving the main process holding the install root open.
    expect(loaded.teardown.terminatePids).toHaveBeenCalledWith([4242]);

    // The WAIT list stays broader than the kill list on purpose: our helpers
    // and the daemon still have to be gone before Setup.exe may run, they just
    // get there by app.quit() and by the graceful shutdown instead.
    const plan = loaded.teardown.spawnInstallWaiter.mock.calls[0]![0] as { pids: number[] };
    expect(plan.pids).toEqual([4242, 4243, 4244, 4245]);
  });

  it('win32: an unknown daemon pid still fails safe when the daemon is not ours (#980)', async () => {
    const loaded = await loadForPlatform('win32', downloadRoutes);
    loaded.teardown.collectInstallRootProcesses.mockReturnValue({
      pids: [4242, 4243],
      ownTree: new Set<number>(),
    });
    // The pid file was unreadable (quitHooks' getDaemonPid returns null).
    // Sparing a daemon we cannot identify would leave the root locked;
    // force-killing it costs a scrollback flush, which is the cheaper failure.
    const { installHandler } = await downloadUpdateFor(loaded);

    await installHandler();

    expect(loaded.teardown.terminatePids).toHaveBeenCalledWith([4242, 4243]);
  });

  it('win32: a quit that never happens is reported and unlatched, not silent (#980)', async () => {
    const loaded = await loadForPlatform('win32', downloadRoutes);
    const { updater, installHandler, sent } = await downloadUpdateFor(loaded);
    vi.useFakeTimers();
    try {
      const install = installHandler();
      await vi.advanceTimersByTimeAsync(1_000); // performInstall's session-save wait
      await install;
      expect(loaded.appQuit).toHaveBeenCalledTimes(1);
      // Nothing is claimed while the quit could still be in flight.
      expect(sent.filter((m) => m.channel === IPC.UPDATE_ERROR)).toHaveLength(0);

      // Still alive well past the deadline: the quit was refused. Nothing else
      // can notice — the waiter is blocked on OUR process handle, and the UI is
      // still showing "Install now".
      await vi.advanceTimersByTimeAsync(30_000);

      const err = sent.find((m) => m.channel === IPC.UPDATE_ERROR);
      expect(err).toBeDefined();
      expect(String(err!.data.message)).toContain('restart wmux');
      // And the latch is clear, so the next press is not answered with
      // "an update install is already in progress" forever.
      expect((updater as unknown as { isInstalling: boolean }).isInstalling).toBe(false);

      // The retry is ALLOWED to spawn a second waiter — the first one may
      // still be inside its budget, and the collision between the two is
      // resolved by the waiter's own single-instance mutex (a live incumbent
      // wins, the newcomer exits 5), not by refusing the retry here. Refusing
      // would trade a solved race for an unretryable updater, which is the
      // state this watchdog exists to end.
      const retry = installHandler();
      await vi.advanceTimersByTimeAsync(1_000);
      await retry;
      expect(loaded.teardown.spawnInstallWaiter).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('win32: the waiter reason wins over our guess when it left one (#980)', async () => {
    const loaded = await loadForPlatform('win32', downloadRoutes);
    const { installHandler, sent } = await downloadUpdateFor(loaded);
    // The waiter already refused and said which way. It knows what we do not.
    loaded.teardown.readAbortMarker.mockReturnValue('install-aborted: install root still locked');
    vi.useFakeTimers();
    try {
      const install = installHandler();
      await vi.advanceTimersByTimeAsync(1_000);
      await install;
      await vi.advanceTimersByTimeAsync(30_000);

      const err = sent.find((m) => m.channel === IPC.UPDATE_ERROR);
      expect(String(err?.data.message)).toContain('install root still locked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('win32: a handoff that cannot be prepared reports UPDATE_ERROR and does NOT quit', async () => {
    const loaded = await loadForPlatform('win32', downloadRoutes);
    const { installHandler, sent } = await downloadUpdateFor(loaded);

    loaded.teardown.spawnInstallWaiter.mockReturnValueOnce(null);
    await installHandler();

    expect(sent.some((m) => m.channel === IPC.UPDATE_ERROR)).toBe(true);
    // Two things must NOT happen here. Quitting would close the app with no
    // installer running — the user just finds wmux gone. And falling back to
    // starting Setup.exe ourselves is the #866 bug, so the installer must stay
    // untouched when the safe path is unavailable.
    expect(loaded.appQuit).not.toHaveBeenCalled();
    expect(loaded.shellOpenPath).not.toHaveBeenCalled();
  });

  it('win32 (#1056): a waiter that never signals it started reports UPDATE_ERROR and does NOT quit or tear anything down', async () => {
    // Event-log evidence from a real machine: the waiter's PowerShell engine
    // started and then went silent forever, in the same second the app called
    // app.quit() -- consistent with a detached child dying with an outer Job
    // Object the parent belongs to (Node's `detached: true` on Windows never
    // requests CREATE_BREAKAWAY_FROM_JOB). This proves the app-side half: the
    // heartbeat check runs BEFORE the daemon shutdown and the force-kill, so a
    // dead-on-arrival waiter costs nothing instead of quitting into a hang.
    const loaded = await loadForPlatform('win32', downloadRoutes);
    const hooks = quitHooks();
    const { installHandler, sent } = await downloadUpdateFor(loaded, hooks);

    loaded.teardown.waitForWaiterHeartbeat.mockResolvedValueOnce(false);
    await installHandler();

    const err = sent.find((m) => m.channel === IPC.UPDATE_ERROR);
    expect(err).toBeDefined();
    expect(String(err?.data.message)).toContain('did not start');
    expect(loaded.appQuit).not.toHaveBeenCalled();
    expect(loaded.shellOpenPath).not.toHaveBeenCalled();
    // Nothing irreversible ran: no daemon shutdown, no force-kill. Order is
    // the whole point -- this check sits between spawning the waiter and
    // committing to either. A regression that called onInstallRequiresFullShutdown
    // before this check would pass every assertion above (coderabbit, #1057).
    expect(loaded.teardown.terminatePids).not.toHaveBeenCalled();
    expect(hooks.onInstallRequiresFullShutdown).not.toHaveBeenCalled();
  });

  it('win32 (#1057, coderabbit): a stale ready-marker that cannot be cleared refuses instead of risking a false "waiter is alive"', async () => {
    // waitForWaiterHeartbeat is mocked in this suite, so it cannot itself prove
    // the fail-closed path -- the real risk is upstream, in the best-effort
    // unlink that is supposed to clear a previous attempt's marker before the
    // real heartbeat check ever runs. A directory at that exact path makes the
    // unlink fail with a real, non-ENOENT error (EPERM/EISDIR) with no mocking
    // of fs itself.
    const loaded = await loadForPlatform('win32', downloadRoutes);
    const readyMarkerPath = join(loaded.tempPathDir, loaded.teardown.INSTALL_READY_MARKER);
    mkdirSync(readyMarkerPath);
    const { installHandler, sent } = await downloadUpdateFor(loaded);

    await installHandler();

    const err = sent.find((m) => m.channel === IPC.UPDATE_ERROR);
    expect(err).toBeDefined();
    expect(loaded.appQuit).not.toHaveBeenCalled();
    expect(loaded.shellOpenPath).not.toHaveBeenCalled();
    // The heartbeat check must never even run against an unproven marker.
    expect(loaded.teardown.waitForWaiterHeartbeat).not.toHaveBeenCalled();
    expect(loaded.teardown.terminatePids).not.toHaveBeenCalled();
  });

  it('win32: refuses to install from an unpackaged build instead of killing stray processes', async () => {
    // The teardown derives the install root from process.execPath. Unpackaged
    // that is the runtime binary, so enumerate-and-kill would target unrelated
    // processes under it — this suite lost its own worker to exactly that
    // before the guard existed.
    const loaded = await loadForPlatform('win32', downloadRoutes, 'x64', { isPackaged: false });
    const { installHandler, sent } = await downloadUpdateFor(loaded);

    await installHandler();

    expect(loaded.teardown.collectInstallRootProcesses).not.toHaveBeenCalled();
    expect(loaded.teardown.terminatePids).not.toHaveBeenCalled();
    expect(loaded.teardown.spawnInstallWaiter).not.toHaveBeenCalled();
    expect(loaded.appQuit).not.toHaveBeenCalled();
    expect(sent.some((m) => m.channel === IPC.UPDATE_ERROR)).toBe(true);
  });

  it('win32: UPDATE_INSTALL with no downloaded installer neither launches nor quits', async () => {
    const loaded = await loadForPlatform('win32'); // 204 feed — nothing downloads
    const { AutoUpdater, ipcHandlers } = loaded;
    const updater = new AutoUpdater(() => null, quitHooks());
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
    const hooks = quitHooks();
    const updater = new loaded.AutoUpdater(() => win as never, hooks);
    (updater as unknown as { registerIpcHandlers: () => void }).registerIpcHandlers();
    await (updater as unknown as { check: (oneShot?: boolean) => Promise<void> }).check();
    await until(() => sent.some((m) => m.channel === IPC.UPDATE_AVAILABLE && m.data.status === 'downloaded'));
    const installHandler = loaded.ipcHandlers.get(IPC.UPDATE_INSTALL);
    if (typeof installHandler !== 'function') throw new Error('UPDATE_INSTALL handler was not registered');
    return { loaded, installHandler, sent, hooks, updater };
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
    // The report waits on the abort hook (which may have to rebuild a window),
    // so it lands a microtask later.
    await until(() => sent.some((m) => m.channel === IPC.UPDATE_ERROR));

    const err = sent.find((m) => m.channel === IPC.UPDATE_ERROR);
    expect(String(err!.data.message)).toContain('not code-signed');
    expect(String(err!.data.message)).toContain('releases');
    expect(loaded.nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  // Regression, macOS install hang: quitAndInstall() closes every window and
  // only installs once the window list empties, so the main process has to be
  // told to stop intercepting closes FIRST. Asserting quitAndInstall was called
  // is not enough — that assertion passed for the entire life of the bug. The
  // ordering is the contract.
  it('prepares the install-quit at the handoff — after staging, before quitAndInstall', async () => {
    const { loaded, installHandler, hooks } = await downloadOnDarwin();

    await installHandler();
    await until(() => loaded.nativeUpdater.setFeedURL.mock.calls.length > 0);

    // Staging is Squirrel downloading and unpacking ~120 MB. Preparing the quit
    // here would leave the app closable and the broker stopped for all of it.
    expect(hooks.onBeforeInstallQuit).not.toHaveBeenCalled();

    loaded.nativeUpdater.emit('update-downloaded');

    expect(hooks.onBeforeInstallQuit).toHaveBeenCalledTimes(1);
    expect(hooks.onInstallQuitAborted).not.toHaveBeenCalled();
    const preparedAt = hooks.onBeforeInstallQuit.mock.invocationCallOrder[0]!;
    const quitAt = loaded.nativeUpdater.quitAndInstall.mock.invocationCallOrder[0]!;
    expect(preparedAt).toBeLessThan(quitAt);
  });

  it('a late Squirrel event after a failed attempt cannot re-trigger the install', async () => {
    const { loaded, installHandler, sent, hooks } = await downloadOnDarwin();

    await installHandler();
    await until(() => loaded.nativeUpdater.setFeedURL.mock.calls.length > 0);
    loaded.nativeUpdater.emit('error', new Error('boom'));
    await until(() => sent.some((m) => m.channel === IPC.UPDATE_ERROR));

    // Squirrel finishing late must not call quitAndInstall now: the abort has
    // already restored the quit flag, so the close intercept is live again and
    // the install would wedge exactly as it did before this fix.
    loaded.nativeUpdater.emit('update-downloaded');
    loaded.nativeUpdater.emit('error', new Error('late second error'));

    expect(loaded.nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(hooks.onBeforeInstallQuit).not.toHaveBeenCalled();
    expect(sent.filter((m) => m.channel === IPC.UPDATE_ERROR)).toHaveLength(1);
  });

  it('a handoff that never restarts the app unwinds: abort, retryable, reported', async () => {
    // The download runs on real timers (the poll helper needs them); only the
    // install handoff is put on fake ones so the 30s deadline is reachable.
    const { loaded, installHandler, sent, hooks, updater } = await downloadOnDarwin();
    vi.useFakeTimers();
    try {
      const install = installHandler();
      await vi.advanceTimersByTimeAsync(1_000); // performInstall's session-save wait
      await install;
      expect(loaded.nativeUpdater.setFeedURL).toHaveBeenCalled();

      // Squirrel staged and called quitAndInstall, but the process is still
      // alive — exactly the wedge that left ShipIt waiting forever.
      loaded.nativeUpdater.emit('update-downloaded');
      expect(hooks.onInstallQuitAborted).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);

      // The quit flag is undone, so the app is reachable again...
      expect(hooks.onInstallQuitAborted).toHaveBeenCalledTimes(1);
      // ...before the failure is reported, or the error lands on a process the
      // user cannot bring to the front.
      const abortedAt = hooks.onInstallQuitAborted.mock.invocationCallOrder[0]!;
      expect(abortedAt).toBeGreaterThan(hooks.onBeforeInstallQuit.mock.invocationCallOrder[0]!);

      const err = sent.find((m) => m.channel === IPC.UPDATE_ERROR);
      expect(err).toBeDefined();
      expect(String(err!.data.message)).toContain('did not restart wmux');
      expect(String(err!.data.message)).toContain('releases');

      // And the install guard is clear, so pressing the button again works.
      expect((updater as unknown as { isInstalling: boolean }).isInstalling).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('staging is given minutes, not the handoff deadline', async () => {
    const { loaded, installHandler, sent, hooks } = await downloadOnDarwin();
    vi.useFakeTimers();
    try {
      const install = installHandler();
      await vi.advanceTimersByTimeAsync(1_000);
      await install;

      // A slow disk or an antivirus scan can make Squirrel take this long to
      // unpack ~120 MB. Aborting here would break healthy updates.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sent.filter((m) => m.channel === IPC.UPDATE_ERROR)).toHaveLength(0);
      expect(hooks.onInstallQuitAborted).not.toHaveBeenCalled();

      // ...but a stage that never finishes is still reported rather than silent.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      const err = sent.find((m) => m.channel === IPC.UPDATE_ERROR);
      expect(String(err?.data.message)).toContain('did not finish preparing');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the deadline stops once the install fails, so it cannot fire twice', async () => {
    const { loaded, installHandler, sent } = await downloadOnDarwin();
    vi.useFakeTimers();
    try {
      const install = installHandler();
      await vi.advanceTimersByTimeAsync(1_000);
      await install;
      loaded.nativeUpdater.emit('error', new Error('boom'));

      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

      expect(sent.filter((m) => m.channel === IPC.UPDATE_ERROR)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AutoUpdater — the auto-update toggle gates background polls only', () => {
  it('toggle off: background polls stop, but a manual UPDATE_CHECK still hits the feed', async () => {
    vi.useFakeTimers();
    const { AutoUpdater, requestUrls, ipcHandlers, ipcListeners } = await loadForPlatform('win32');

    // Capture renderer events so the test can assert the check RAN TO
    // COMPLETION, not merely that a request left the building.
    const sent: Array<{ channel: string; data: Record<string, unknown> }> = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, data: Record<string, unknown>) => { sent.push({ channel, data }); },
      },
    };
    const updater = new AutoUpdater(() => win as never, quitHooks());
    updater.start();

    // User turns auto-update OFF before the first scheduled check fires.
    ipcListeners.get(IPC.AUTO_UPDATE_ENABLED)!(null, false);

    // Neither the 15s first check nor a full 30-min interval may touch the network.
    await vi.advanceTimersByTimeAsync(15_000 + 30 * 60 * 1000);
    expect(requestUrls).toHaveLength(0);

    // A manual "check for updates" press is an explicit request: it must work
    // with the toggle off — otherwise the toggle bricks the only update path.
    const reply = await ipcHandlers.get(IPC.UPDATE_CHECK)!();
    expect(reply).toEqual({ status: 'checking' });
    // The unrouted feed URL answers 204 (up to date): the check must complete
    // and report not-available — a check that fired and then died would leave
    // no terminal event and fail here.
    await vi.waitFor(() => {
      expect(sent.some((m) => m.channel === IPC.UPDATE_NOT_AVAILABLE)).toBe(true);
    });
    expect(requestUrls).toContain(EXPECTED_WIN32_FEED);
    expect(sent.some((m) => m.channel === IPC.UPDATE_ERROR)).toBe(false);

    updater.stop();
  });

  it('toggle back on: background polling resumes at the next interval', async () => {
    vi.useFakeTimers();
    const { AutoUpdater, requestUrls, ipcListeners } = await loadForPlatform('win32');

    const updater = new AutoUpdater(() => null, quitHooks());
    updater.start();
    ipcListeners.get(IPC.AUTO_UPDATE_ENABLED)!(null, false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(requestUrls).toHaveLength(0);

    ipcListeners.get(IPC.AUTO_UPDATE_ENABLED)!(null, true);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(requestUrls).toContain(EXPECTED_WIN32_FEED);

    updater.stop();
  });
});

describe('AutoUpdater #866 — a refused install is reported on the next boot', () => {
  // The renderer PULLS this. The push-on-a-timer version it replaced sent
  // UPDATE_ERROR into a window whose only listener lived in the Settings
  // panel — mounted only while Settings is open — so with Settings closed the
  // notice went nowhere AND the marker was cleared anyway. Live dogfood:
  // marker planted, app booted, main logged the refusal, marker gone, nothing
  // shown. These tests pin the take contract instead.
  const takeHandler = (loaded: Awaited<ReturnType<typeof loadForPlatform>>) => {
    const h = loaded.ipcHandlers.get(IPC.UPDATE_TAKE_REFUSED_INSTALL);
    if (!h) throw new Error('UPDATE_TAKE_REFUSED_INSTALL handler was never registered');
    return h;
  };

  it('win32: hands the reason to the renderer that asks, and clears the marker only then', async () => {
    const loaded = await loadForPlatform('win32');
    loaded.teardown.readAbortMarker.mockReturnValueOnce(
      'install-aborted: install root still locked',
    );

    const updater = new loaded.AutoUpdater(() => null, quitHooks());
    updater.start();

    // Registering the handler must not consume the marker on its own.
    expect(loaded.teardown.clearAbortMarker).not.toHaveBeenCalled();

    const reason = await takeHandler(loaded)();
    expect(reason).toBe('install-aborted: install root still locked');
    expect(loaded.teardown.clearAbortMarker).toHaveBeenCalledTimes(1);

    updater.stop();
  });

  it('win32: answers null and clears nothing when no install was refused', async () => {
    const loaded = await loadForPlatform('win32');
    // readAbortMarker defaults to null in the stub — nothing was refused.

    const updater = new loaded.AutoUpdater(() => null, quitHooks());
    updater.start();

    expect(await takeHandler(loaded)()).toBeNull();
    expect(loaded.teardown.clearAbortMarker).not.toHaveBeenCalled();

    updater.stop();
  });

  it('the handler exists even where in-app updates are unsupported, so the invoke never rejects', async () => {
    const loaded = await loadForPlatform('linux');
    const updater = new loaded.AutoUpdater(() => null, quitHooks());
    updater.start();

    expect(await takeHandler(loaded)()).toBeNull();
    updater.stop();
  });

  it('registers the handler at CONSTRUCTION, before start() — the renderer asks first', async () => {
    // start() runs at the end of the ready sequence, which waits on the daemon
    // bootstrap (39s on a cold boot in dogfood). The renderer mounts and asks
    // at ~0.7s, so a handler registered in start() is not there yet and the
    // invoke rejects — which is exactly how this notice went missing live.
    const loaded = await loadForPlatform('win32');
    loaded.teardown.readAbortMarker.mockReturnValueOnce('install-aborted: install root still locked');

    const updater = new loaded.AutoUpdater(() => null, quitHooks());
    // No start() call anywhere in this test.
    expect(await takeHandler(loaded)()).toBe('install-aborted: install root still locked');
  });
});
