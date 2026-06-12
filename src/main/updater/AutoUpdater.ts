/**
 * AutoUpdater
 *
 * update.electronjs.org 기반 자동 업데이트 시스템.
 * Chromium의 net 모듈로 업데이트를 확인하고, Squirrel의 Update.exe로 설치.
 *
 * Electron 내장 autoUpdater(Squirrel의 .NET HttpWebRequest)는
 * GitHub의 다중 302 redirect + TLS 1.2에서 실패하므로 사용하지 않음.
 */

import { autoUpdater, app, type BrowserWindow, ipcMain, net, shell } from 'electron';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { IPC } from '../../shared/constants';
import { isAllowedDownloadUrl, digestsEqual, validateManifest, type UpdateManifest } from './verifyUpdate';

const REPO = 'openwong2kim/wmux';
const UPDATE_SERVER = `https://update.electronjs.org/${REPO}/win32/${app.getVersion()}`;
// CI publishes update-manifest.json (version + setupExe + sha256 + url) as a
// release asset; the "latest" alias always points at the newest release. The
// updater pins the Setup.exe SHA-256 against this before installing.
const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/update-manifest.json`;

// 업데이트 자동 확인 간격 (30분)
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

// In-app auto-update is Windows-only today. The update-server URL (line above),
// the temp installer filename, and the launch verb in this class are all
// Squirrel.Windows-shaped: macOS gains a signed-ZIP self-update path in a later
// phase, and Linux updates via the system package manager (no in-app updater).
// Gate every network/install action on this constant so a macOS/Linux client can
// NEVER fetch a manifest, download, or launch a Windows `.Setup.exe` — not even
// once all three OSes share a single GitHub release's assets.
const isUpdaterSupported = process.platform === 'win32';

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

  private async check(): Promise<void> {
    // Defense in depth: never poll the win32-only update feed off Windows, even
    // if a caller invokes check() directly.
    if (!isUpdaterSupported) return;
    if (!this.enabled || this.isChecking) return;
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
        // Two-step: auto-download + verify in the background, then emit 'downloaded'.
        void this.downloadUpdate();
      } else {
        this.sendToRenderer(IPC.UPDATE_NOT_AVAILABLE, { status: 'not-available' });
      }
    } catch (err) {
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
    } catch (err) {
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
      const dest = join(app.getPath('temp'), `wmux-update-${manifest.version}-${process.pid}.Setup.exe`);
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
      // Don't await — fire and forget, results come via IPC events
      this.check();
      return { status: 'checking' };
    });

    ipcMain.handle(IPC.UPDATE_INSTALL, async () => {
      if (!isUpdaterSupported) {
        // No in-app installer on this platform — never download/launch a
        // Windows .Setup.exe on macOS/Linux. The win32 install path below is
        // unreachable here.
        console.log(`[AutoUpdater] UPDATE_INSTALL ignored on ${process.platform} — no in-app installer for this platform.`);
        return;
      }
      const tempPath = this.downloadedPath;
      if (!tempPath) {
        // The UI only surfaces the install button after 'downloaded' fired, so
        // this is a defensive no-op (e.g. a prior download failed).
        console.log('[AutoUpdater] UPDATE_INSTALL ignored — no verified installer downloaded yet.');
        return;
      }

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

      // Launch the LOCAL, already-verified installer. Download + SHA-256 verify
      // happened during detection (downloadUpdate); we never launch an
      // unverified artifact.
      const openErr = await shell.openPath(tempPath);
      if (openErr) {
        this.sendToRenderer(IPC.UPDATE_ERROR, {
          status: 'error',
          message: `failed to launch verified installer: ${openErr}`,
        });
      }
    });
  }

  private sendToRenderer(channel: string, data: Record<string, unknown>): void {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}
