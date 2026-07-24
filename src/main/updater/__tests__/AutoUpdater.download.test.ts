/**
 * Two-step auto-updater flow (win32): detection auto-downloads + verifies, then
 * UPDATE_INSTALL launches the already-verified local file. fs is mocked so no
 * real installer is written; crypto is real so the SHA-256 gate is exercised.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { IPC } from '../../../shared/constants';

const FAKE_VERSION = '9.9.9';
const NEW_VERSION = '9.9.10';
const DL_URL = `https://github.com/openwong2kim/wmux/releases/download/v${NEW_VERSION}/wmux-${NEW_VERSION}.Setup.exe`;
const INSTALLER_BODY = Buffer.from('FAKE-INSTALLER-BYTES');
const GOOD_SHA = createHash('sha256').update(INSTALLER_BODY).digest('hex');

const realPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.resetModules();
  vi.useRealTimers();
});

interface Sent { channel: string; data: Record<string, unknown>; }

/** Load AutoUpdater (win32) with a URL-routing net mock, fs mocked, window capture. */
async function loadWin32({ sha = GOOD_SHA }: { sha?: string } = {}) {
  vi.resetModules();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  const requestUrls: string[] = [];
  const ipcHandlers = new Map<string, (...a: unknown[]) => unknown>();
  const openPath = vi.fn(async (_p: string) => '');

  // Route net.request by URL: feed → update JSON, manifest → manifest JSON,
  // download → 200 with Content-Length + body chunk.
  const request = vi.fn((url: string) => {
    requestUrls.push(url);
    const cbs: Record<string, (arg: unknown) => void> = {};
    const req = {
      on(ev: string, cb: (arg: unknown) => void) { cbs[ev] = cb; return req; },
      end() {
        Promise.resolve().then(() => {
          if (url.includes('update.electronjs.org')) {
            respondJson(cbs, { name: NEW_VERSION, notes: 'notes', url: DL_URL });
          } else if (url.includes('update-manifest.json')) {
            respondJson(cbs, { version: NEW_VERSION, setupExe: `wmux-${NEW_VERSION}.Setup.exe`, sha256: sha, url: DL_URL });
          } else {
            respondBody(cbs, INSTALLER_BODY);
          }
        });
      },
    };
    return req;
  });

  function respondJson(cbs: Record<string, (a: unknown) => void>, obj: unknown) {
    const dataCbs: Record<string, (a: unknown) => void> = {};
    const resp = { statusCode: 200, headers: {}, on(ev: string, cb: (a: unknown) => void) { dataCbs[ev] = cb; return resp; } };
    cbs['response']?.(resp);
    Promise.resolve().then(() => {
      dataCbs['data']?.(Buffer.from(JSON.stringify(obj)));
      dataCbs['end']?.(undefined);
    });
  }
  function respondBody(cbs: Record<string, (a: unknown) => void>, body: Buffer) {
    const dataCbs: Record<string, (a: unknown) => void> = {};
    const resp = { statusCode: 200, headers: { 'content-length': [String(body.length)] }, on(ev: string, cb: (a: unknown) => void) { dataCbs[ev] = cb; return resp; } };
    cbs['response']?.(resp);
    Promise.resolve().then(() => {
      dataCbs['data']?.(body);
      dataCbs['end']?.(undefined);
    });
  }

  const sent: Sent[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { isCrashed: () => false, send: (channel: string, data: Record<string, unknown>) => sent.push({ channel, data }), executeJavaScript: vi.fn(async () => undefined) },
  };

  // Mock fs so no real installer file is written; capture the streamed bytes.
  vi.doMock('node:fs', () => ({
    createWriteStream: () => ({ write: vi.fn(), end: (cb?: () => void) => cb && cb(), destroy: vi.fn(), on: () => undefined }),
  }));
  vi.doMock('node:fs/promises', () => ({ unlink: vi.fn(async () => undefined) }));

  // #502: UPDATE_INSTALL now calls app.quit() after a successful launch so
  // Squirrel never installs against a live instance — the mock must provide it.
  const quit = vi.fn();
  vi.doMock('electron', () => ({
    autoUpdater: {},
    app: { getVersion: () => FAKE_VERSION, getPath: () => '/tmp', quit },
    ipcMain: {
      on: vi.fn(),
      handle: (ch: string, cb: (...a: unknown[]) => unknown) => { ipcHandlers.set(ch, cb); },
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn(),
    },
    net: { request },
    shell: { openPath, openExternal: vi.fn() },
  }));

  const mod = await import('../AutoUpdater');
  return { AutoUpdater: mod.AutoUpdater, requestUrls, ipcHandlers, sent, openPath, quit, win };
}

/** Flush queued microtasks so the chained net responses (feed→manifest→download) settle. */
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

/** Poll until `cond` holds (for real-timer waits like performInstall's 500ms session-save). */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('AutoUpdater two-step flow (win32)', () => {
  /** Invoke the private background check() (not the one-shot UPDATE_CHECK handler). */
  const backgroundCheck = (updater: unknown) =>
    (updater as { check: (oneShot?: boolean) => Promise<void> }).check();

  it('a background check auto-downloads, streams progress, and emits downloaded (no auto-install)', async () => {
    const { AutoUpdater, sent, openPath, quit, win } = await loadWin32();
    const updater = new AutoUpdater(() => win as never);
    updater.start();

    // Background poll (not user-triggered): downloads + verifies, then STOPS.
    await backgroundCheck(updater);
    await flush();

    const statuses = sent.map((s) => `${s.channel}:${s.data.status}`);
    expect(statuses).toContain(`${IPC.UPDATE_AVAILABLE}:available`);
    expect(statuses).toContain(`${IPC.UPDATE_DOWNLOAD}:downloading`);
    expect(statuses).toContain(`${IPC.UPDATE_AVAILABLE}:downloaded`);

    const progress = sent.find((s) => s.channel === IPC.UPDATE_DOWNLOAD)!;
    expect(progress.data.percent).toBe(100);

    // A background download must never restart the app on its own — the user
    // still has to press "Restart to install".
    expect(openPath).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('a user-triggered check (UPDATE_CHECK) is one-shot: auto-installs once verified', async () => {
    const { AutoUpdater, ipcHandlers, openPath, quit, win } = await loadWin32();
    const updater = new AutoUpdater(() => win as never);
    updater.start();

    // The manual "check for updates" button routes through UPDATE_CHECK — a
    // one-shot "update now": no second click needed to install.
    await ipcHandlers.get(IPC.UPDATE_CHECK)!();
    // performInstall runs fire-and-forget with a real 500ms session-save delay.
    await until(() => openPath.mock.calls.length > 0);

    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath.mock.calls[0][0]).toContain('wmux-update-');
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('UPDATE_INSTALL launches the downloaded file without re-fetching the manifest, then quits', async () => {
    const { AutoUpdater, ipcHandlers, requestUrls, openPath, quit, win } = await loadWin32();
    const updater = new AutoUpdater(() => win as never);
    updater.start();

    await backgroundCheck(updater);
    await flush();
    const urlsAfterDownload = requestUrls.length;

    await ipcHandlers.get(IPC.UPDATE_INSTALL)!();
    await flush();

    // Launched the local installer, and made NO new network request.
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath.mock.calls[0][0]).toContain('wmux-update-');
    expect(requestUrls.length).toBe(urlsAfterDownload);
    // #502: quit after launch so Squirrel installs against a dead instance.
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('rejects on sha256 mismatch: emits error, no downloaded path, install is a no-op', async () => {
    const BAD_SHA = 'a'.repeat(64);
    const { AutoUpdater, ipcHandlers, sent, openPath, quit, win } = await loadWin32({ sha: BAD_SHA });
    const updater = new AutoUpdater(() => win as never);
    updater.start();

    await backgroundCheck(updater);
    await flush();

    const statuses = sent.map((s) => `${s.channel}:${s.data.status}`);
    expect(statuses).toContain(`${IPC.UPDATE_ERROR}:error`);
    expect(statuses).not.toContain(`${IPC.UPDATE_AVAILABLE}:downloaded`);

    // No verified file → install launches nothing.
    await ipcHandlers.get(IPC.UPDATE_INSTALL)!();
    await flush();
    expect(openPath).not.toHaveBeenCalled();
    // #502: no launch → no quit (the app must not close with nothing installing).
    expect(quit).not.toHaveBeenCalled();
  });

  it('a manual press mid-poll preserves the one-shot intent so the in-flight download installs', async () => {
    const { AutoUpdater, openPath, quit, win } = await loadWin32();
    const updater = new AutoUpdater(() => win as never);
    updater.start();

    const internals = updater as unknown as {
      isChecking: boolean;
      oneShotInstall: boolean;
      pendingUpdate: { name: string; notes: string; url: string } | null;
      check: (oneShot?: boolean) => Promise<void>;
      downloadUpdate: () => Promise<void>;
    };
    // A background poll is already in flight (downloading), so isChecking is true.
    internals.isChecking = true;
    internals.pendingUpdate = { name: NEW_VERSION, notes: 'n', url: DL_URL };

    // Manual press lands mid-poll: guarded out of a second check, but the intent
    // is recorded (set before the isChecking guard).
    await internals.check(true);
    expect(internals.oneShotInstall).toBe(true);

    // The in-flight poll now finishes its download → it honors the intent and installs.
    internals.isChecking = false;
    await internals.downloadUpdate();
    await until(() => openPath.mock.calls.length > 0);
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('a failed one-shot fast-path install clears the intent (no unattended restart later)', async () => {
    const { AutoUpdater, openPath, quit, win } = await loadWin32();
    openPath.mockResolvedValueOnce('launch failed'); // shell.openPath resolves with an error string, never throws
    const updater = new AutoUpdater(() => win as never);
    updater.start();

    const internals = updater as unknown as {
      oneShotInstall: boolean;
      downloadedPath: string | null;
      pendingUpdate: { name: string; notes: string; url: string } | null;
      check: (oneShot?: boolean) => Promise<void>;
    };
    // Pretend a background poll already downloaded + verified this version.
    internals.downloadedPath = 'C:/tmp/wmux-update-9.9.10.Setup.exe';
    internals.pendingUpdate = { name: NEW_VERSION, notes: 'n', url: DL_URL };

    // Manual press → fast path → performInstall, whose launch fails.
    await internals.check(true);
    await until(() => openPath.mock.calls.length > 0);
    await flush();

    // The failed launch must NOT quit, and must have cleared the intent so a
    // later background download can't auto-restart the app.
    expect(quit).not.toHaveBeenCalled();
    expect(internals.oneShotInstall).toBe(false);
  });

  it('a failed one-shot download does not restart the app (install intent cleared)', async () => {
    const BAD_SHA = 'a'.repeat(64);
    const { AutoUpdater, ipcHandlers, openPath, quit, win } = await loadWin32({ sha: BAD_SHA });
    const updater = new AutoUpdater(() => win as never);
    updater.start();

    // User pressed the button, but the download fails verification: the app
    // must stay open rather than quit with nothing installing.
    await ipcHandlers.get(IPC.UPDATE_CHECK)!();
    await flush();

    expect(openPath).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
});
