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

/**
 * Quit hooks every AutoUpdater requires (see AutoUpdaterHooks).
 *
 * `getDaemonPid` returns 4243, which is one of the two pids the mocked
 * enumeration reports. That is deliberate: it is what lets a test see the
 * daemon being EXCLUDED from the force-kill list (it gets the graceful
 * shutdown instead). A null here would silently pass the exclusion assertion
 * by never exercising it.
 */
function quitHooks() {
  return {
    onBeforeInstallQuit: vi.fn(),
    onInstallQuitAborted: vi.fn(),
    onInstallRequiresFullShutdown: vi.fn(),
    getDaemonPid: vi.fn((): number | null => 4243),
  };
}

const realPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.resetModules();
  vi.useRealTimers();
});

interface Sent { channel: string; data: Record<string, unknown>; }

/** A file parked in the fake temp dir (#995 adoption paths). */
interface TempFile { body: Buffer; mtimeMs?: number }

/** Load AutoUpdater (win32) with a URL-routing net mock, fs mocked, window capture. */
async function loadWin32(
  { sha = GOOD_SHA, tempFiles = {} }: { sha?: string; tempFiles?: Record<string, TempFile> } = {},
) {
  vi.resetModules();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  // Mutable so a test can bump the offered release mid-run (supersede paths).
  const feed = { version: NEW_VERSION };
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
            respondJson(cbs, { name: feed.version, notes: 'notes', url: DL_URL });
          } else if (url.includes('update-manifest.json')) {
            respondJson(cbs, { version: feed.version, setupExe: `wmux-${feed.version}.Setup.exe`, sha256: sha, url: DL_URL });
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
  // `once('close')` fires synchronously on destroy so the fail-path cleanup
  // (unlink of a partial/mismatched download) runs inside the test.
  //
  // The read side backs the fake temp dir `tempFiles` describes: readdir/stat
  // list it and createReadStream replays a parked artifact's bytes, which is
  // what the adoption path (#995) hashes.
  const baseName = (p: string) => String(p).split(/[\\/]/).pop() ?? '';
  vi.doMock('node:fs', () => ({
    createWriteStream: () => {
      const closeCbs: Array<() => void> = [];
      return {
        write: vi.fn(),
        end: (cb?: () => void) => cb && cb(),
        destroy: () => { for (const cb of closeCbs.splice(0)) cb(); },
        on: () => undefined,
        once: (ev: string, cb: () => void) => { if (ev === 'close') closeCbs.push(cb); },
      };
    },
    createReadStream: (p: string) => {
      const entry = tempFiles[baseName(p)];
      const cbs: Record<string, (a?: unknown) => void> = {};
      const stream = { on(ev: string, cb: (a?: unknown) => void) { cbs[ev] = cb; return stream; } };
      Promise.resolve().then(() => {
        if (!entry) { cbs['error']?.(new Error(`ENOENT: ${p}`)); return; }
        cbs['data']?.(entry.body);
        cbs['end']?.();
      });
      return stream;
    },
  }));
  const unlinkMock = vi.fn(async (path: string) => { delete tempFiles[baseName(path)]; });
  vi.doMock('node:fs/promises', () => ({
    unlink: unlinkMock,
    readdir: async (_dir: string) => Object.keys(tempFiles),
    stat: async (p: string) => {
      const entry = tempFiles[baseName(p)];
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return { mtimeMs: entry.mtimeMs ?? Date.now() };
    },
  }));

  // #866: the install path enumerates and force-kills every process under the
  // install root, which is derived from process.execPath. Under test that is
  // the node binary, so the real implementation would kill unrelated node
  // processes — it took out this suite's own worker before this mock existed.
  // Stubbed here so the ORDER and the refusal branches stay observable; the
  // real thing is exercised against a sandbox in installTeardown.runtime.test.
  const teardown = {
    collectInstallRootPids: vi.fn((_root: string): number[] => [4242, 4243]),
    terminatePids: vi.fn((pids: readonly number[]): number[] => [...pids]),
    spawnInstallWaiter: vi.fn((_plan: { setupExePath: string }): string | null =>
      'C:\\Temp\\waiter\\wait-and-install.ps1'),
    freeSpaceShortfall: vi.fn(() => null),
    probeVolume: vi.fn(() => ({ volume: 'C:\\', freeBytes: 9e12 })),
    readDaemonPid: vi.fn((): number | null => 4243),
    // Boot-time refused-install notice: default to "nothing to report" so it
    // never leaks an UPDATE_ERROR into tests about other flows.
    readAbortMarker: vi.fn((): string | null => null),
    clearAbortMarker: vi.fn(),
    INSTALL_ABORT_MARKER: 'update-install-aborted.txt',
  };
  vi.doMock('../installTeardown', () => teardown);

  // #502: UPDATE_INSTALL now calls app.quit() after a successful launch so
  // Squirrel never installs against a live instance — the mock must provide it.
  const quit = vi.fn();
  vi.doMock('electron', () => ({
    autoUpdater: {},
    app: { getVersion: () => FAKE_VERSION, getPath: () => '/tmp', quit, isPackaged: true },
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
  return { AutoUpdater: mod.AutoUpdater, requestUrls, ipcHandlers, sent, openPath, quit, win, feed, unlinkMock, teardown, tempFiles };
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
    const updater = new AutoUpdater(() => win as never, quitHooks());
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
    const { AutoUpdater, ipcHandlers, openPath, quit, win, teardown } = await loadWin32();
    const updater = new AutoUpdater(() => win as never, quitHooks());
    updater.start();

    // The manual "check for updates" button routes through UPDATE_CHECK — a
    // one-shot "update now": no second click needed to install.
    await ipcHandlers.get(IPC.UPDATE_CHECK)!();
    // performInstall runs fire-and-forget with a real 500ms session-save delay.
    await until(() => teardown.spawnInstallWaiter.mock.calls.length > 0);

    // #866: the installer is handed to a waiter, never launched from here —
    // launching it directly is what deletes the install root out from under a
    // live daemon.
    expect(openPath).not.toHaveBeenCalled();
    expect(teardown.spawnInstallWaiter).toHaveBeenCalledTimes(1);
    const plan = teardown.spawnInstallWaiter.mock.calls[0][0] as { setupExePath: string };
    expect(plan.setupExePath).toContain('wmux-update-');
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('UPDATE_INSTALL hands off the downloaded file without re-fetching the manifest, then quits', async () => {
    const { AutoUpdater, ipcHandlers, requestUrls, openPath, quit, win, teardown } = await loadWin32();
    const updater = new AutoUpdater(() => win as never, quitHooks());
    updater.start();

    await backgroundCheck(updater);
    await flush();
    const urlsAfterDownload = requestUrls.length;

    await ipcHandlers.get(IPC.UPDATE_INSTALL)!();
    await flush();

    // Handed the local installer to the waiter, and made NO new network request.
    expect(openPath).not.toHaveBeenCalled();
    expect(teardown.spawnInstallWaiter).toHaveBeenCalledTimes(1);
    expect(requestUrls.length).toBe(urlsAfterDownload);
    // #502 + #866: quit so Squirrel installs against a dead instance — and the
    // daemon has to go with us, so the full-shutdown branch is requested first.
    expect(quit).toHaveBeenCalledTimes(1);
    // The daemon is spared the force-kill; it gets the graceful shutdown.
    expect(teardown.terminatePids).toHaveBeenCalledWith([4242]);
  });

  it('rejects on sha256 mismatch: emits error, no downloaded path, install is a no-op', async () => {
    const BAD_SHA = 'a'.repeat(64);
    const { AutoUpdater, ipcHandlers, sent, openPath, quit, win } = await loadWin32({ sha: BAD_SHA });
    const updater = new AutoUpdater(() => win as never, quitHooks());
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
    const { AutoUpdater, openPath, quit, win, teardown } = await loadWin32();
    const updater = new AutoUpdater(() => win as never, quitHooks());
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
    await until(() => teardown.spawnInstallWaiter.mock.calls.length > 0);
    expect(openPath).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('a failed one-shot fast-path install clears the intent (no unattended restart later)', async () => {
    const { AutoUpdater, quit, win, teardown } = await loadWin32();
    // #866: the failure mode is now "the waiter could not be prepared". When
    // that happens the install must be ABANDONED — falling back to launching
    // Setup.exe directly is the bug this change exists to remove.
    teardown.spawnInstallWaiter.mockReturnValueOnce(null);
    const updater = new AutoUpdater(() => win as never, quitHooks());
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

    // Manual press → fast path → performInstall, whose handoff fails.
    await internals.check(true);
    await until(() => teardown.spawnInstallWaiter.mock.calls.length > 0);
    await flush();

    // A refused handoff must NOT quit (the user keeps a working app), and must
    // have cleared the intent so a later background download can't auto-restart.
    expect(quit).not.toHaveBeenCalled();
    expect(internals.oneShotInstall).toBe(false);
  });

  it('a failed one-shot download does not restart the app (install intent cleared)', async () => {
    const BAD_SHA = 'a'.repeat(64);
    const { AutoUpdater, ipcHandlers, openPath, quit, win } = await loadWin32({ sha: BAD_SHA });
    const updater = new AutoUpdater(() => win as never, quitHooks());
    updater.start();

    // User pressed the button, but the download fails verification: the app
    // must stay open rather than quit with nothing installing.
    await ipcHandlers.get(IPC.UPDATE_CHECK)!();
    await flush();

    expect(openPath).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('removes the partial temp file when verification fails (no tampered artifact left in temp)', async () => {
    const BAD_SHA = 'a'.repeat(64);
    const { AutoUpdater, unlinkMock, win } = await loadWin32({ sha: BAD_SHA });
    const updater = new AutoUpdater(() => win as never, quitHooks());
    updater.start();

    await backgroundCheck(updater);
    await flush();

    // The sha-mismatched download must be unlinked — both by the stream's
    // fail-path cleanup and the caller's catch (idempotent best-effort).
    expect(unlinkMock).toHaveBeenCalled();
    expect(String(unlinkMock.mock.calls[0][0])).toContain('wmux-update-');
  });

  it('a newer release supersedes a downloaded one: old artifact unlinked, new one downloaded', async () => {
    const { AutoUpdater, feed, sent, unlinkMock, win } = await loadWin32();
    const updater = new AutoUpdater(() => win as never, quitHooks());
    updater.start();

    // First poll downloads + verifies 9.9.10.
    await backgroundCheck(updater);
    await flush();
    expect(sent.map((s) => `${s.channel}:${s.data.status}`)).toContain(`${IPC.UPDATE_AVAILABLE}:downloaded`);
    const downloadsBefore = sent.filter((s) => s.channel === IPC.UPDATE_AVAILABLE && s.data.status === 'downloaded').length;

    // A newer release appears before the user restarted.
    feed.version = '9.9.11';
    await backgroundCheck(updater);
    await flush();

    // The stale 9.9.10 artifact is deleted (not left to pile up in temp) and
    // the new version goes through the full download+verify cycle again.
    expect(unlinkMock.mock.calls.some((c) => String(c[0]).includes(`wmux-update-${NEW_VERSION}`))).toBe(true);
    const downloadsAfter = sent.filter((s) => s.channel === IPC.UPDATE_AVAILABLE && s.data.status === 'downloaded').length;
    expect(downloadsAfter).toBe(downloadsBefore + 1);
  });
});

/**
 * #995 — `downloadedPath` is in-memory, so a restart (or an aborted install)
 * used to throw away a perfectly good ~150 MB installer and fetch it again.
 * The artifact's name plus the manifest hash is the record that lets the next
 * run pick it back up — and re-verification is what makes that safe.
 */
describe('AutoUpdater temp artifact reuse (win32)', () => {
  const backgroundCheck = (updater: unknown) =>
    (updater as { check: (oneShot?: boolean) => Promise<void> }).check();
  const parkedName = `wmux-update-${NEW_VERSION}-4242-wmux-${NEW_VERSION}.Setup.exe`;

  it('reuses a verified installer left in temp instead of downloading it again', async () => {
    const { AutoUpdater, requestUrls, sent, win } = await loadWin32({
      tempFiles: { [parkedName]: { body: INSTALLER_BODY } },
    });
    const updater = new AutoUpdater(() => win as never, quitHooks());

    await backgroundCheck(updater);
    await flush();

    // The manifest is still fetched (that is where the hash to verify against
    // comes from) — the 150 MB installer download is what must not happen.
    expect(requestUrls.some((u) => u.includes('update-manifest.json'))).toBe(true);
    expect(requestUrls).not.toContain(DL_URL);
    expect(sent.map((s) => `${s.channel}:${s.data.status}`)).toContain(`${IPC.UPDATE_AVAILABLE}:downloaded`);
  });

  it('re-verifies before reusing: a tampered artifact is discarded and the installer downloaded', async () => {
    const { AutoUpdater, requestUrls, sent, unlinkMock, win } = await loadWin32({
      tempFiles: { [parkedName]: { body: Buffer.from('TAMPERED'), mtimeMs: Date.now() - 10 * 60_000 } },
    });
    const updater = new AutoUpdater(() => win as never, quitHooks());

    await backgroundCheck(updater);
    await flush();

    expect(unlinkMock.mock.calls.some((c) => String(c[0]).includes(parkedName))).toBe(true);
    expect(requestUrls).toContain(DL_URL);
    expect(sent.map((s) => `${s.channel}:${s.data.status}`)).toContain(`${IPC.UPDATE_AVAILABLE}:downloaded`);
  });

  it('leaves a just-written mismatching artifact alone — that is another instance downloading', async () => {
    const { AutoUpdater, unlinkMock, win } = await loadWin32({
      tempFiles: { [parkedName]: { body: Buffer.from('PARTIAL'), mtimeMs: Date.now() } },
    });
    const updater = new AutoUpdater(() => win as never, quitHooks());

    await backgroundCheck(updater);
    await flush();

    expect(unlinkMock.mock.calls.some((c) => String(c[0]).includes(parkedName))).toBe(false);
  });

  it('the startup sweep keeps an installer for a newer version and drops one for the running version', async () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const pending = `wmux-update-${NEW_VERSION}-1-wmux-${NEW_VERSION}.Setup.exe`;
    const alreadyInstalled = `wmux-update-${FAKE_VERSION}-1-wmux-${FAKE_VERSION}.Setup.exe`;
    const { AutoUpdater, unlinkMock, win } = await loadWin32({
      tempFiles: {
        [pending]: { body: INSTALLER_BODY, mtimeMs: threeDaysAgo },
        [alreadyInstalled]: { body: INSTALLER_BODY, mtimeMs: threeDaysAgo },
      },
    });
    const updater = new AutoUpdater(() => win as never, quitHooks());

    updater.start();
    await flush();

    const swept = unlinkMock.mock.calls.map((c) => String(c[0]));
    expect(swept.some((p) => p.includes(alreadyInstalled))).toBe(true);
    expect(swept.some((p) => p.includes(pending))).toBe(false);
  });
});
