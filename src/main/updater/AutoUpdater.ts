/**
 * AutoUpdater
 *
 * update.electronjs.org 기반 자동 업데이트 시스템.
 * Chromium의 net 모듈로 업데이트를 확인하고, Squirrel의 Update.exe로 설치.
 *
 * Electron 내장 autoUpdater(Squirrel의 .NET HttpWebRequest)는
 * GitHub의 다중 302 redirect + TLS 1.2에서 실패하므로 사용하지 않음.
 * On macOS the detection + SHA-256 verification still run through net/manifest,
 * and only the final install hands off to the built-in autoUpdater (Squirrel.Mac)
 * via a loopback feed serving the already-verified ZIP — see performInstall.
 */

import { autoUpdater, app, type BrowserWindow, ipcMain, net, shell } from 'electron';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { IPC } from '../../shared/constants';
import { isAllowedDownloadUrl, digestsEqual, validateManifest, type UpdateManifest } from './verifyUpdate';
import { LocalUpdateFeed } from './LocalUpdateFeed';

const REPO = 'openwong2kim/wmux';
// update.electronjs.org keys releases by platform-arch. Only the two arches we
// actually publish installers for are ever requested (see isUpdaterSupported).
const isDarwin = process.platform === 'darwin';
const UPDATE_PLATFORM = isDarwin ? 'darwin-arm64' : 'win32';
const UPDATE_SERVER = `https://update.electronjs.org/${REPO}/${UPDATE_PLATFORM}/${app.getVersion()}`;
// CI publishes a per-platform manifest (version + setupExe|file + sha256 + url)
// as a release asset; the "latest" alias always points at the newest release.
// The updater pins the artifact's SHA-256 against this before installing.
const MANIFEST_FILE = isDarwin ? 'update-manifest-darwin-arm64.json' : 'update-manifest.json';
const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/${MANIFEST_FILE}`;

// 업데이트 자동 확인 간격 (30분)
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

// In-app auto-update runs on Windows (Squirrel.Windows `.Setup.exe`) and on
// Apple Silicon macOS (Squirrel.Mac, signed+notarized ZIP). Everything else —
// Intel macOS (no build is produced) and Linux (users update via their package
// manager) — has no in-app updater. Gate every network/install action on this
// constant so an unsupported client can NEVER fetch a manifest, download, or
// launch an installer meant for another platform, even though all OSes share a
// single GitHub release's assets.
const isUpdaterSupported =
  process.platform === 'win32' || (isDarwin && process.arch === 'arm64');

interface UpdateInfo {
  name: string;
  notes: string;
  url: string;
}

export class AutoUpdater {
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private getWindow: () => BrowserWindow | null;
  private isChecking = false;
  private enabled = true;
  private pendingUpdate: UpdateInfo | null = null;
  private downloadedPath: string | null = null;
  private isDownloading = false;
  // When a user presses "check for updates" it reads as an "update now" intent:
  // once an update is detected + verified, install it (restart) automatically
  // instead of waiting for a second click. Background 30-min polls never set
  // this, so the auto-poll only ever downloads and surfaces a Restart button.
  private oneShotInstall = false;
  // Re-entrancy guard for performInstall: the one-shot path fire-and-forgets it
  // while UPDATE_INSTALL awaits its own call, so both can reach it. shell.openPath
  // resolves (never throws) on failure, so without this a second call would
  // launch the installer twice.
  private isInstalling = false;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  start(): void {
    // Register IPC handlers on every platform so the renderer's "check for
    // updates" UI resolves cleanly (it gets a not-available reply off win32),
    // but only schedule background checks on a supported platform.
    this.registerIpcHandlers();

    if (process.env.NODE_ENV === 'development') {
      return;
    }

    if (!isUpdaterSupported) {
      console.log(`[AutoUpdater] In-app updates are not supported on ${process.platform}; skipping auto-check (update via your package manager).`);
      return;
    }

    // 앱 시작 후 15초 뒤 첫 번째 확인 (시작 부하 방지)
    setTimeout(() => this.check(), 15_000);

    // 이후 주기적 확인
    this.checkTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log(`[AutoUpdater] ${enabled ? 'Enabled' : 'Disabled'}`);
  }

  stop(): void {
    if (this.checkTimer !== null) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    ipcMain.removeAllListeners(IPC.AUTO_UPDATE_ENABLED);
    ipcMain.removeHandler(IPC.UPDATE_CHECK);
    ipcMain.removeHandler(IPC.UPDATE_INSTALL);
  }

  /**
   * @param oneShot when true (a user-triggered "check for updates" press),
   *   auto-install the update once it's detected + verified instead of leaving
   *   a Restart button — a single click that means "update now". Background
   *   polls pass false, so they only ever download and surface the button.
   */
  private async check(oneShot = false): Promise<void> {
    // Defense in depth: never poll the update feed on an unsupported platform,
    // even if a caller invokes check() directly.
    if (!isUpdaterSupported) return;
    if (!this.enabled) return;
    // Record the one-shot intent BEFORE the isChecking guard: if a background
    // poll is already downloading, its downloadUpdate completion will honor the
    // intent and install, so a manual press mid-poll still updates in one click.
    if (oneShot) this.oneShotInstall = true;
    if (this.isChecking) return;
    this.isChecking = true;
    this.sendToRenderer(IPC.UPDATE_CHECK, { status: 'checking' });

    try {
      const update = await this.fetchUpdate();
      if (update) {
        const isNewVersion = this.pendingUpdate?.name !== update.name;
        this.pendingUpdate = update;
        if (isNewVersion) this.downloadedPath = null; // a newer update supersedes any prior download
        this.sendToRenderer(IPC.UPDATE_AVAILABLE, {
          status: 'available',
          releaseName: update.name,
          releaseNotes: update.notes,
        });
        if (this.oneShotInstall && this.downloadedPath) {
          // A background poll already downloaded + verified this exact version:
          // skip straight to install rather than re-downloading. Clear the
          // intent BEFORE launching (mirrors the downloadUpdate path) so a
          // failed shell.openPath can't leave it set for a later background
          // poll to act on — that would restart the app with no user action.
          this.oneShotInstall = false;
          void this.performInstall();
        } else {
          // Two-step: auto-download + verify, then emit 'downloaded' (which
          // triggers performInstall when oneShotInstall is set).
          void this.downloadUpdate();
        }
      } else {
        this.oneShotInstall = false; // up to date — nothing to install
        this.sendToRenderer(IPC.UPDATE_NOT_AVAILABLE, { status: 'not-available' });
      }
    } catch (err) {
      this.oneShotInstall = false; // don't leave a stale install intent after a failed check
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[AutoUpdater] check error:', message);
      this.sendToRenderer(IPC.UPDATE_ERROR, { status: 'error', message });
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Two-step phase 2 — download the pending update's installer, SHA-256-verify
   * it, and stash the local path. Streams progress over UPDATE_DOWNLOAD and
   * emits UPDATE_AVAILABLE{downloaded} on success. Fail-closed: any error
   * surfaces UPDATE_ERROR, cleans up the temp file, and leaves no downloadedPath.
   */
  private async downloadUpdate(): Promise<void> {
    if (!isUpdaterSupported) return;
    const pending = this.pendingUpdate;
    if (!pending) return;
    if (this.isDownloading) return;
    if (this.downloadedPath) return; // already have a verified installer for this version
    this.isDownloading = true;

    let tempPath: string | null = null;
    try {
      const manifestRaw = await this.fetchManifest();
      const validated = validateManifest(manifestRaw, pending.name);
      if (!validated.ok) {
        throw new Error(`update manifest rejected: ${validated.reason}`);
      }
      tempPath = await this.downloadAndVerify(validated.manifest, (percent) => {
        this.sendToRenderer(IPC.UPDATE_DOWNLOAD, { status: 'downloading', percent });
      });
      this.downloadedPath = tempPath;
      console.log('[AutoUpdater] Update downloaded + verified (sha256 match) — ready to install');
      this.sendToRenderer(IPC.UPDATE_AVAILABLE, {
        status: 'downloaded',
        releaseName: pending.name,
      });
      // One-shot (user pressed "check for updates" as "update now"): the
      // verified installer is ready — restart into it now. The 'downloaded'
      // event above still fires first, so the UI briefly shows the Restart
      // state during performInstall's session-save delay.
      if (this.oneShotInstall) {
        this.oneShotInstall = false;
        void this.performInstall();
      }
    } catch (err) {
      this.oneShotInstall = false; // failed download → drop any pending install intent
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AutoUpdater] download aborted (fail-closed):', message);
      if (tempPath) {
        await unlink(tempPath).catch(() => { /* best-effort cleanup */ });
      }
      this.downloadedPath = null;
      this.sendToRenderer(IPC.UPDATE_ERROR, {
        status: 'error',
        message: `Update could not be downloaded or verified: ${message}`,
      });
    } finally {
      this.isDownloading = false;
    }
  }

  private fetchUpdate(): Promise<UpdateInfo | null> {
    return new Promise((resolve, reject) => {
      const request = net.request(UPDATE_SERVER);
      let body = '';

      request.on('response', (response) => {
        // 204 = no update available
        if (response.statusCode === 204) {
          resolve(null);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Update server returned ${response.statusCode}`));
          return;
        }
        response.on('data', (chunk) => { body += chunk.toString(); });
        response.on('end', () => {
          try {
            const data = JSON.parse(body) as UpdateInfo;
            resolve(data);
          } catch {
            reject(new Error('Invalid JSON from update server'));
          }
        });
      });

      request.on('error', (err) => reject(err));
      request.end();
    });
  }

  /** Fetch the CI-published update manifest (raw JSON; validated by caller). */
  private fetchManifest(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = net.request(MANIFEST_URL);
      let body = '';
      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`update manifest server returned ${response.statusCode}`));
          return;
        }
        response.on('data', (chunk) => { body += chunk.toString(); });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('invalid JSON in update manifest'));
          }
        });
      });
      request.on('error', (err) => reject(err));
      request.end();
    });
  }

  /**
   * Download manifest.url to a temp file, streaming through a SHA-256 hash, and
   * verify it matches manifest.sha256. Resolves the temp path on a verified
   * match; rejects on any transport error or digest mismatch (caller cleans up
   * and aborts — fail-closed).
   */
  private downloadAndVerify(
    manifest: UpdateManifest,
    onProgress?: (percent: number | null) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Defense in depth: validateManifest already allowlist-checked the URL;
      // re-assert before opening the socket.
      if (!isAllowedDownloadUrl(manifest.url)) {
        reject(new Error(`download url not allowed: ${manifest.url}`));
        return;
      }
      // Keep the manifest's artifact name (sanitized) so the temp file carries
      // the right extension on every platform (.Setup.exe on Windows, .zip on
      // macOS) instead of a hardcoded Windows one.
      const safeName = manifest.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
      const dest = join(app.getPath('temp'), `wmux-update-${manifest.version}-${process.pid}-${safeName}`);
      const hash = createHash('sha256');
      const out = createWriteStream(dest);
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        out.destroy();
        reject(err);
      };

      const request = net.request(manifest.url);
      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          fail(new Error(`installer download returned ${response.statusCode}`));
          return;
        }
        const totalRaw = (response as { headers?: Record<string, string | string[]> }).headers?.['content-length'];
        const totalStr = Array.isArray(totalRaw) ? totalRaw[0] : totalRaw;
        const total = totalStr ? parseInt(String(totalStr), 10) : NaN;
        let received = 0;
        let sentIndeterminate = false;

        response.on('data', (chunk: Buffer) => {
          hash.update(chunk);
          out.write(chunk);
          received += chunk.length;
          if (onProgress) {
            if (Number.isFinite(total) && total > 0) {
              onProgress(Math.round((received / total) * 100));
            } else if (!sentIndeterminate) {
              sentIndeterminate = true;
              onProgress(null); // unknown size → renderer shows an indeterminate spinner
            }
          }
        });
        response.on('end', () => {
          out.end(() => {
            if (settled) return;
            const actual = hash.digest('hex');
            if (digestsEqual(actual, manifest.sha256)) {
              settled = true;
              resolve(dest);
            } else {
              fail(new Error(`sha256 mismatch: expected ${manifest.sha256}, got ${actual}`));
            }
          });
        });
        response.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      });
      request.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      out.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      request.end();
    });
  }

  private registerIpcHandlers(): void {
    ipcMain.on(IPC.AUTO_UPDATE_ENABLED, (_event, enabled: boolean) => {
      this.setEnabled(enabled);
    });

    ipcMain.handle(IPC.UPDATE_CHECK, async () => {
      if (process.env.NODE_ENV === 'development' || !isUpdaterSupported) {
        return { status: 'not-available' };
      }
      // Don't await — fire and forget, results come via IPC events. A manual
      // press is a one-shot "update now": auto-install once verified.
      this.check(true);
      return { status: 'checking' };
    });

    ipcMain.handle(IPC.UPDATE_INSTALL, async () => {
      // Explicit "Restart to install" button (surfaces after a background poll
      // downloaded an update). Shares performInstall with the one-shot path.
      await this.performInstall();
    });
  }

  /**
   * Install the LOCAL, already-verified artifact. On Windows: launch the
   * Setup.exe and quit so Squirrel installs against a dead instance. On macOS:
   * hand the verified ZIP to Squirrel.Mac through a loopback feed and let it
   * swap the bundle atomically on quit. Shared by the explicit "Restart to
   * install" button (UPDATE_INSTALL) and the one-shot user-triggered check.
   */
  private async performInstall(): Promise<void> {
    if (!isUpdaterSupported) {
      // No in-app installer on this platform — never download/launch an
      // installer built for another OS. The install paths below are
      // unreachable here.
      console.log(`[AutoUpdater] install ignored on ${process.platform} — no in-app installer for this platform.`);
      return;
    }
    const tempPath = this.downloadedPath;
    if (!tempPath) {
      // The UI only surfaces the install button after 'downloaded' fired, so
      // this is a defensive no-op (e.g. a prior download failed).
      console.log('[AutoUpdater] install ignored — no verified installer downloaded yet.');
      return;
    }
    if (this.isInstalling) {
      console.log('[AutoUpdater] install already in progress — ignoring re-entrant call.');
      return;
    }
    this.isInstalling = true;

    const win = this.getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isCrashed()) {
      try {
        await win.webContents.executeJavaScript(
          `try { window.dispatchEvent(new Event('beforeunload')); } catch(e) {}`
        );
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log('[AutoUpdater] Session save triggered before update install');
      } catch {
        console.warn('[AutoUpdater] Could not trigger session save before update');
      }
    }

    if (isDarwin) {
      await this.installDarwin(tempPath);
      return;
    }

    // Download + SHA-256 verify happened during detection (downloadUpdate); we
    // never launch an unverified artifact.
    const openErr = await shell.openPath(tempPath);
    if (openErr) {
      this.isInstalling = false; // launch failed — allow the user to retry
      this.sendToRenderer(IPC.UPDATE_ERROR, {
        status: 'error',
        message: `failed to launch verified installer: ${openErr}`,
      });
      return;
    }
    // #502: Squirrel's installer crashes when it runs against a live instance
    // (locked old-version files + a single-instance collision on the
    // post-install relaunch). "Restart to install" means restart: quit NOW — a
    // normal quit only detaches, so the daemon and every live session persist —
    // and the --squirrel-updated/-install hook relaunches the updated app once
    // the install completes.
    console.log('[AutoUpdater] Installer launched — quitting so Squirrel can install (sessions persist in the daemon)');
    app.quit();
  }

  /**
   * macOS install: Squirrel.Mac refuses `file://` feeds, so serve the verified
   * ZIP from 127.0.0.1 under a random token path and point the built-in
   * autoUpdater at it. Squirrel stages the new bundle and swaps it atomically
   * during quitAndInstall; the daemon is detached, so sessions survive the
   * relaunch exactly like on Windows.
   *
   * Fail-closed: any Squirrel error (most commonly "code signature" on a local
   * unsigned build) tears the feed down, clears the install guard, and surfaces
   * UPDATE_ERROR instead of leaving the UI stuck mid-install.
   */
  private async installDarwin(zipPath: string): Promise<void> {
    const feed = new LocalUpdateFeed();
    const cleanup = () => { void feed.stop(); };
    const failInstall = (message: string) => {
      cleanup();
      this.isInstalling = false; // let the user retry
      console.error('[AutoUpdater] macOS install failed (fail-closed):', message);
      this.sendToRenderer(IPC.UPDATE_ERROR, { status: 'error', message });
    };

    try {
      const { feedUrl } = await feed.start(zipPath);
      autoUpdater.removeAllListeners('update-downloaded');
      autoUpdater.removeAllListeners('error');
      autoUpdater.on('update-downloaded', () => {
        console.log('[AutoUpdater] Squirrel.Mac staged the verified update — restarting to install (sessions persist in the daemon)');
        cleanup();
        autoUpdater.quitAndInstall();
      });
      autoUpdater.on('error', (err: Error) => {
        failInstall(this.describeDarwinInstallError(err));
      });
      autoUpdater.setFeedURL({ url: feedUrl, serverType: 'json' });
      autoUpdater.checkForUpdates();
    } catch (err) {
      // setFeedURL throws synchronously on an unsigned/ad-hoc-signed build.
      failInstall(this.describeDarwinInstallError(err));
    }
  }

  /**
   * Squirrel.Mac hard-requires a Developer ID signature; a locally-made
   * unsigned build can never self-update. Say so instead of leaking a raw
   * "Could not get code signature" string the user cannot act on.
   */
  private describeDarwinInstallError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    if (/code sign/i.test(raw)) {
      return `This build is not code-signed, so it cannot update itself. Download the latest DMG from https://github.com/${REPO}/releases and install it manually. (${raw})`;
    }
    return `Update could not be installed: ${raw}`;
  }

  private sendToRenderer(channel: string, data: Record<string, unknown>): void {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}
