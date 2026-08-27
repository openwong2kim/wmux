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
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { lstat, readdir, stat, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { IPC } from '../../shared/constants';
import {
  artifactTempName,
  digestsEqual,
  isAllowedDownloadUrl,
  isVersionNewer,
  normalizeVersion,
  parseArtifactName,
  sanitizeArtifactFileName,
  TEMP_ARTIFACT_PREFIX,
  validateManifest,
  type UpdateManifest,
} from './verifyUpdate';
import { LocalUpdateFeed } from './LocalUpdateFeed';
import {
  collectInstallRootProcesses,
  clearAbortMarker,
  freeSpaceShortfall,
  INSTALL_ABORT_MARKER,
  INSTALL_READY_MARKER,
  probeVolume,
  readAbortMarker,
  spawnInstallWaiter,
  terminatePids,
  waitForWaiterHeartbeat,
} from './installTeardown';
import { findInstallIntegrityGap } from './installIntegrity';

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

// Once quitAndInstall() is called, terminating this process is Squirrel's job
// and takes about a second. If we are still running after this, ShipIt is
// waiting on a process that will never die — unwind instead of leaving the UI
// silent forever (#update-hang).
const INSTALL_HANDOFF_TIMEOUT_MS = 30_000;

// #866 install-teardown budgets. The size figures come from a real 3.40.2
// install: the expanded app directory is ~361 MB and Squirrel's package cache
// holds a ~143 MB nupkg, so a clean install needs roughly 500 MB in the root.
// Setup.exe additionally unpacks its embedded nupkg into SquirrelTemp on the
// staging volume. Both are rounded up: refusing an update that would have just
// fit costs the user a retry, while running out of room mid-install is the
// half-deleted installation this whole change exists to prevent.
const INSTALL_ROOT_HEADROOM_BYTES = 700 * 1024 * 1024;
const INSTALL_STAGING_HEADROOM_BYTES = 200 * 1024 * 1024;
// How long the waiter keeps re-checking the install root for locks before it
// refuses. Generous on purpose: a daemon flushing large RingBuffers on shutdown
// can hold files for a while, and waiting is free while refusing costs the user
// their update.
const INSTALL_LOCK_BUDGET_MS = 60_000;
// #980 — how long we give our own quit before concluding it did not happen.
// Longer than main's before-quit hard deadline (20 s), so on any path where
// that deadline is armed the process is already gone and this never fires. It
// exists for the paths where it is NOT armed — a quit that never reaches a
// before-quit handler at all leaves nothing else to notice.
const INSTALL_QUIT_WATCHDOG_MS = 30_000;
// #1056 — how long to wait for the waiter's heartbeat before concluding the
// spawn itself did not survive (see waitForWaiterHeartbeat). Short on purpose:
// unlike the lock budget, this is not waiting on anything that legitimately
// takes time — a live process writes one file in well under a second, so a
// few seconds of silence already means it is gone, not just busy.
const WAITER_HEARTBEAT_BUDGET_MS = 3_000;
// Squirrel downloading and unpacking a ~120 MB bundle before it reports
// 'update-downloaded'. Generous on purpose: a slow disk or an antivirus scan
// makes this minutes, and aborting a healthy update is worse than waiting.
const INSTALL_STAGING_TIMEOUT_MS = 10 * 60 * 1000;

// Verified installers are named `wmux-update-<version>-<pid>-<artifact>` (see
// artifactTempName). A stage-then-stall leaves one behind (only the supersede
// and error paths unlink), so they accumulate at ~120 MB each. Swept at
// startup; the age floor keeps a concurrent instance's in-flight download safe.
const TEMP_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// #995: an artifact for a version NEWER than the one running is not garbage —
// it is the installer for an update we have not taken yet, and the next check
// re-verifies and adopts it instead of pulling ~150 MB down again. Sweeping it
// on the 24 h floor is what made every aborted install cost a fresh download.
// It still expires, just far later: if auto-update is off the poll that would
// consume it never runs, and nothing should sit in temp forever.
const TEMP_ARTIFACT_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// An artifact whose bytes fail the hash is either a corrupted leftover or
// another instance's download in flight. Only age tells them apart, and the
// age that means "nobody is writing this" is the sweep's own floor — a shorter
// one would delete a slow download out from under the instance that owns it,
// which on POSIX leaves that instance verifying a file whose path is gone.
const TEMP_ARTIFACT_MISMATCH_DELETE_AFTER_MS = TEMP_ARTIFACT_MAX_AGE_MS;

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

/**
 * Main-process state the updater cannot reach on its own, but which decides
 * whether an install can actually happen.
 *
 * `quitAndInstall()` asks Electron to close every window and only installs once
 * the window list empties. A hide-to-tray `close` intercept cancels that close,
 * so the install never runs and ShipIt waits on us forever. The main process
 * therefore has to be told an install-quit is starting BEFORE we hand off — and
 * told to undo it if the handoff stalls, or it is left with no window and a
 * quit flag that makes it ignore Dock clicks and relaunch.
 *
 * Both hooks are required, not optional: the bug this interface exists to
 * prevent was a quit signal that silently never arrived.
 */
export interface AutoUpdaterHooks {
  /**
   * Invoked synchronously immediately before Squirrel is told to install. Must
   * let windows actually close, and must flush any state the normal quit path
   * would have flushed — that path is skipped entirely on this route.
   */
  onBeforeInstallQuit: () => void;
  /**
   * Undo `onBeforeInstallQuit` after a handoff that never terminated us: clear
   * the quit flag, restore anything the prepare tore down, and bring a window
   * back. Without this the recovery path is worse than the failure it recovers
   * from. Resolve only once the restored window can receive IPC — the updater
   * waits on this before reporting, so the error is not sent into a renderer
   * that has not attached its listeners yet.
   */
  onInstallQuitAborted: () => void | Promise<void>;
  /**
   * Windows install path only (#866). Ask the main process to take the FULL
   * shutdown branch on the coming quit — daemon.shutdown with the pid-kill
   * backstop — instead of the default detach.
   *
   * Detaching is right for a normal quit and wrong here: the daemon runs out of
   * `<root>\app-X.Y.Z\wmux.exe`, so leaving it alive means the installer can
   * never delete the directory it has to replace. Sessions do not survive this
   * install; that is the cost of the install completing at all.
   */
  onInstallRequiresFullShutdown: () => void;
  /**
   * The daemon's pid, or null when it cannot be determined.
   *
   * Injected rather than read here so this module stays free of the daemon
   * config import: pulling `daemon/config` into the updater crashed the
   * electron-mocked unit tests at module load, and the updater has no other
   * reason to know where `~/.wmux` lives.
   *
   * Used only to EXCLUDE the daemon from the force-kill list — it gets the
   * graceful shutdown so it can flush scrollback. A null therefore fails safe:
   * the daemon is force-killed like anything else, costing a flush but not the
   * install.
   */
  getDaemonPid: () => number | null;
}

export class AutoUpdater {
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private getWindow: () => BrowserWindow | null;
  private hooks: AutoUpdaterHooks;
  private isChecking = false;
  private enabled = true;
  private pendingUpdate: UpdateInfo | null = null;
  private downloadedPath: string | null = null;
  // The digest `downloadedPath` was accepted under. Kept so the bytes can be
  // re-checked immediately before they are executed: verification happens when
  // the update is found, the install happens when the user presses Restart —
  // which can be days later, in a temp dir any process running as this user can
  // write to. Verifying once and then trusting a path is not verifying.
  private downloadedSha: string | null = null;
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

  constructor(getWindow: () => BrowserWindow | null, hooks: AutoUpdaterHooks) {
    this.getWindow = getWindow;
    this.hooks = hooks;
    // #866. Registered HERE, not in start(): start() runs at the end of the
    // ready sequence, which waits on the daemon bootstrap — measured at 39s on
    // a cold boot. The renderer mounts and asks for a refused install at
    // ~0.7s, so a handler registered in start() is not there yet and the
    // invoke rejects with "no handler registered", which is how this notice
    // silently went missing in live dogfood. The constructor runs during
    // module evaluation, before the window exists at all.
    ipcMain.handle(IPC.UPDATE_TAKE_REFUSED_INSTALL, () => this.takeRefusedInstall());
    ipcMain.handle(IPC.UPDATE_GET_PENDING_INSTALL, () => this.getPendingInstall());
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

    void this.sweepStaleArtifacts();

    // #866: if the last install was refused because the install root never
    // cleared, the waiter left a marker instead of running Setup.exe. The
    // renderer TAKES that reason once it is mounted (UPDATE_TAKE_REFUSED_INSTALL,
    // registered above) — main does not push it here. Without the notice the
    // user pressed "Restart to install", watched wmux quit and come back on
    // the SAME version, and has nothing to go on, which is how this class of
    // failure stays invisible until someone files a bug about icons instead.

    // 앱 시작 후 15초 뒤 첫 번째 확인 (시작 부하 방지)
    setTimeout(() => this.check(), 15_000);

    // 이후 주기적 확인
    this.checkTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  /**
   * Hand a refused install's reason to the renderer, once (#866).
   *
   * PULL, not push. Pushing this on a timer at boot assumed a listener was
   * attached by then; the only listener lived in the Settings panel, which is
   * mounted only while the user has Settings OPEN. With Settings closed — the
   * default — the notice went nowhere AND the marker was cleared anyway, so
   * the refusal stayed exactly as invisible as before this feature existed.
   *
   * The renderer therefore asks when it is mounted and can show something.
   * Taking the reason is what clears the marker, so a notice that was never
   * collected (renderer crashed, window closed early) survives to the next
   * boot rather than being consumed by the attempt to deliver it. Once taken
   * it does not come back: a sticky warning about a since-succeeded update
   * would be worse than none.
   */
  private takeRefusedInstall(): string | null {
    const markerPath = join(app.getPath('userData'), INSTALL_ABORT_MARKER);
    const reason = readAbortMarker(markerPath);
    if (!reason) return null;
    console.warn(`[AutoUpdater] previous install was refused: ${reason}`);
    // #1055 — when the installation is broken RIGHT NOW (Update.exe missing),
    // the warnOnInstallIntegrityGap boot notice already owns this user and
    // says "reinstall from Setup.exe". Delivering the marker's generic "left
    // untouched — try again" toast on the same boot would be a second,
    // contradictory instruction. And the marker must still be consumed: it
    // lives in userData, which Setup.exe never touches, so left in place it
    // would greet the FIRST boot after the reinstall it asked for with the
    // same stale advice. Structural, not a substring match on the marker —
    // the marker is written by the PRE-upgrade build's waiter, so its
    // wording can never be trusted across a version boundary.
    let brokenNow = false;
    try {
      // Strict probe (coderabbit, #1058): the DEFAULT exists-callback inside
      // findInstallIntegrityGap swallows an fs failure into `false`, which
      // reads as "Update.exe missing" — an inconclusive probe would consume
      // the marker and suppress the notice. Passing existsSync raw lets a
      // throw propagate to the probe's own catch, which treats it as
      // present — cannot-verify must deliver the marker, not eat it.
      brokenNow = findInstallIntegrityGap(process.execPath, (p) => existsSync(p)) !== null;
    } catch { /* cannot judge — deliver the marker as before */ }
    clearAbortMarker(markerPath);
    if (brokenNow) {
      console.warn('[AutoUpdater] suppressing the refused-install toast: the install-integrity boot notice owns this state');
      return null;
    }
    return reason;
  }

  /**
   * The update that is downloaded, verified, and waiting for the user to say go.
   *
   * PULLED, not pushed, and for the same reason `takeRefusedInstall` is (#866):
   * `UPDATE_AVAILABLE{downloaded}` fires once, at the moment the background
   * download finishes, and the only listener is the Settings panel — which is
   * mounted only while the user has Settings OPEN, i.e. almost never. So the
   * app would sit on a verified installer and never say so. Two reporters and
   * the maintainer hit exactly that on #897: "it downloads but nothing happens
   * unless I press Check for updates".
   *
   * Note what is NOT changed here: a background poll still does not install by
   * itself. Installing quits the app and every pane goes with it (see
   * performInstall), so it stays a decision the user makes. The bug was never
   * that we wait for them — it was that we never told them we were waiting.
   *
   * Unlike takeRefusedInstall this is a READ, not a take: the state is still
   * true after you look at it, and stays true until the install happens.
   */
  private getPendingInstall(): { version: string; currentVersion: string } | null {
    if (!this.downloadedPath || !this.pendingUpdate) return null;
    return {
      version: this.pendingUpdate.name,
      currentVersion: app.getVersion(),
    };
  }

  /**
   * Drop verified installers left in temp by an install that staged but never
   * completed. Best-effort and never blocks startup: a failure here costs disk,
   * not correctness. Only files older than TEMP_ARTIFACT_MAX_AGE_MS are removed
   * so a second instance downloading right now keeps its artifact.
   *
   * #995: an artifact whose version is NEWER than the running app is held far
   * longer, because it is the one thing adoptExistingArtifact can reuse. The
   * old rule deleted it at 24 h and the next check paid for the same 150 MB
   * again — on the #980 failure loop, three times over.
   */
  private async sweepStaleArtifacts(): Promise<void> {
    const tempDir = app.getPath('temp');
    let names: string[];
    try {
      names = await readdir(tempDir);
    } catch {
      return;
    }
    const now = Date.now();
    const current = app.getVersion();
    // Only the single newest pending version is worth keeping. wmux ships every
    // few days, so a user who postpones restarting collects one ~150 MB
    // installer per release — and the older ones can never be installed anyway,
    // because a check always offers the latest. Without this, replacing the
    // 24 h floor with a 7-day one removes the only bound on that pile.
    let newestPending: string | null = null;
    for (const name of names) {
      if (!name.startsWith(TEMP_ARTIFACT_PREFIX)) continue;
      const parsed = parseArtifactName(name);
      if (!parsed || !isVersionNewer(parsed.version, current)) continue;
      if (newestPending === null || isVersionNewer(parsed.version, newestPending)) {
        newestPending = parsed.version;
      }
    }
    for (const name of names) {
      if (!name.startsWith(TEMP_ARTIFACT_PREFIX)) continue;
      const parsed = parseArtifactName(name);
      const isPendingInstaller =
        parsed !== null &&
        newestPending !== null &&
        normalizeVersion(parsed.version) === normalizeVersion(newestPending);
      const maxAge = isPendingInstaller ? TEMP_ARTIFACT_PENDING_MAX_AGE_MS : TEMP_ARTIFACT_MAX_AGE_MS;
      const full = join(tempDir, name);
      try {
        const info = await stat(full);
        if (info.mtimeMs >= now - maxAge) continue;
        await unlink(full);
        console.log(`[AutoUpdater] swept stale update artifact ${name}`);
      } catch {
        /* best-effort — another instance may own it, or it vanished mid-sweep */
      }
    }
  }

  /**
   * Reuse an installer this machine already downloaded and verified (#995).
   *
   * `downloadedPath` is in-memory only, so a quit-for-install that aborted (or
   * simply a restart) leaves a perfectly good ~150 MB Setup.exe in temp with
   * nothing pointing at it, and the next check downloads it all over again.
   * The file name carries the version, so the artifact plus the freshly fetched
   * manifest hash is all the record needed — no new state on disk.
   *
   * NEVER trusted on its name: the file sat in a world-writable temp dir across
   * a restart, so the SHA-256 is re-computed and compared to the manifest exactly
   * as a fresh download's is — and again immediately before the install, because
   * this check and that install are separated by however long the user takes to
   * press Restart (see verifyArtifactStillMatches).
   *
   * A mismatch is only deleted once it is older than the sweep's own floor:
   * anything newer may be an in-flight download owned by another instance, and
   * unlinking that would leave its owner verifying a path that no longer exists.
   */
  private async adoptExistingArtifact(manifest: UpdateManifest): Promise<string | null> {
    const tempDir = app.getPath('temp');
    let names: string[];
    try {
      names = await readdir(tempDir);
    } catch {
      return null;
    }
    const wantVersion = normalizeVersion(manifest.version);
    const wantFile = sanitizeArtifactFileName(manifest.fileName);
    for (const name of names) {
      const parsed = parseArtifactName(name);
      if (!parsed) continue;
      if (normalizeVersion(parsed.version) !== wantVersion) continue;
      if (parsed.fileName !== wantFile) continue;
      const full = join(tempDir, name);
      try {
        // lstat, not stat: a symlink planted under one of these names would
        // otherwise be hashed through and then handed to the installer as if
        // it were the verified artifact — and a symlink can be re-pointed
        // atomically afterwards, without rewriting 150 MB. Only a regular file
        // is a candidate.
        const info = await lstat(full);
        if (!info.isFile()) {
          console.warn(`[AutoUpdater] ignoring temp entry ${name}: not a regular file`);
          continue;
        }
        const actual = await this.hashFile(full);
        if (digestsEqual(actual, manifest.sha256)) {
          console.log(`[AutoUpdater] reusing verified installer already in temp (${name}) — skipping download`);
          return full;
        }
        if (info.mtimeMs < Date.now() - TEMP_ARTIFACT_MISMATCH_DELETE_AFTER_MS) {
          await unlink(full);
          console.warn(`[AutoUpdater] discarded temp artifact ${name}: sha256 does not match the manifest`);
        } else {
          console.warn(`[AutoUpdater] ignoring temp artifact ${name}: sha256 does not match (too recent to delete — may be another instance's download)`);
        }
      } catch {
        /* unreadable or vanished mid-scan — fall through to a fresh download */
      }
    }
    return null;
  }

  /**
   * Re-check an artifact against the digest it was accepted under, immediately
   * before it is executed. Fail-closed in every direction: an unreadable file,
   * a non-regular one, or a missing recorded digest all answer false.
   */
  private async verifyArtifactStillMatches(artifactPath: string): Promise<boolean> {
    const expected = this.downloadedSha;
    if (!expected) {
      console.error('[AutoUpdater] refusing install: no recorded digest for the staged installer');
      return false;
    }
    try {
      const info = await lstat(artifactPath);
      if (!info.isFile()) {
        console.error('[AutoUpdater] refusing install: staged installer is not a regular file');
        return false;
      }
      const actual = await this.hashFile(artifactPath);
      if (digestsEqual(actual, expected)) return true;
      console.error('[AutoUpdater] refusing install: staged installer no longer matches its verified digest');
      return false;
    } catch (err) {
      console.error('[AutoUpdater] refusing install: staged installer could not be re-verified:', err);
      return false;
    }
  }

  /** Stream a file through SHA-256. Streamed, not read: these artifacts are ~150 MB. */
  private hashFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
      stream.on('error', (err: Error) => reject(err));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
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
    // The auto-update toggle silences BACKGROUND polls only. A manual
    // "check for updates" press (oneShot) is an explicit user request and
    // must work with the toggle off — otherwise the toggle bricks the only
    // update path short of reinstalling.
    if (!this.enabled && !oneShot) return;
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
        if (isNewVersion && this.downloadedPath) {
          // A newer update supersedes any prior download — drop the stale
          // artifact from disk too, or every release leaves one behind in temp.
          void unlink(this.downloadedPath).catch(() => { /* best-effort cleanup */ });
          this.downloadedPath = null;
          this.downloadedSha = null;
        }
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
      // #995: this machine may already hold a verified installer for exactly
      // this version (an aborted install, or a restart before the user pressed
      // Restart). Re-verify it against the manifest we just fetched and reuse
      // it rather than pulling the same ~150 MB down again.
      tempPath = await this.adoptExistingArtifact(validated.manifest);
      if (!tempPath) {
        tempPath = await this.downloadAndVerify(validated.manifest, (percent) => {
          this.sendToRenderer(IPC.UPDATE_DOWNLOAD, { status: 'downloading', percent });
        });
      }
      if (this.pendingUpdate?.name !== pending.name) {
        // A newer release superseded this download mid-flight (check() replaced
        // pendingUpdate). Committing it would let a one-shot install restart the
        // app into the OLD version — discard and fetch the current one instead.
        console.log(`[AutoUpdater] download of ${pending.name} superseded by ${this.pendingUpdate?.name ?? 'none'} — discarding`);
        await unlink(tempPath).catch(() => { /* best-effort cleanup */ });
        tempPath = null;
        // Re-dispatch AFTER the finally below clears isDownloading — calling
        // synchronously here would let finally clobber the new run's guard.
        queueMicrotask(() => void this.downloadUpdate());
        return;
      }
      this.downloadedPath = tempPath;
      this.downloadedSha = validated.manifest.sha256;
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
      this.downloadedSha = null;
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
      const dest = join(app.getPath('temp'), artifactTempName(manifest.version, process.pid, manifest.fileName));
      const hash = createHash('sha256');
      const out = createWriteStream(dest);
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        // The caller only learns the temp path on resolve, so a failed or
        // sha-mismatched partial download must be removed HERE or it stays on
        // disk forever (and a tampered artifact would linger in temp). Wait for
        // 'close' — unlinking while the handle is still open fails on Windows.
        out.once('close', () => { void unlink(dest).catch(() => { /* best-effort */ }); });
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
    // Both guards below used to return with only a console.log. Nothing reached
    // the renderer, so a press that hit one of them looked identical to a press
    // that did nothing at all — which is exactly how a stalled install
    // presented: silent, and silent again on every retry. Every refusal now
    // says so on UPDATE_ERROR, the one channel the UI already renders.
    const tempPath = this.downloadedPath;
    if (!tempPath) {
      console.log('[AutoUpdater] install ignored — no verified installer downloaded yet.');
      this.sendToRenderer(IPC.UPDATE_ERROR, {
        status: 'error',
        source: 'install',
        message: 'No verified installer is ready yet. Check for updates again to download one.',
      });
      return;
    }
    if (this.isInstalling) {
      console.log('[AutoUpdater] install already in progress — ignoring re-entrant call.');
      this.sendToRenderer(IPC.UPDATE_ERROR, {
        status: 'error',
        source: 'install',
        code: 'in-progress',
        message: 'An update install is already in progress. If nothing happens, restart wmux and try again.',
      });
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

    // Verify the bytes AGAIN, as late as possible, against the digest they were
    // accepted under. Everything before this happened when the update was
    // FOUND: minutes ago for a background download, potentially days for an
    // adopted artifact — and all of it in a directory any process running as
    // this user can write to. Hashing once and then launching a path is not a
    // check, it is a window; this closes it for both paths at the cost of one
    // read of an already-warm file.
    if (!(await this.verifyArtifactStillMatches(tempPath))) {
      this.isInstalling = false;
      this.downloadedPath = null;
      this.downloadedSha = null;
      this.sendToRenderer(IPC.UPDATE_ERROR, {
        status: 'error',
        source: 'install',
        message: 'The staged installer no longer matches the release it was verified against, so it was not run. Check for updates again to fetch a fresh copy.',
      });
      return;
    }

    if (isDarwin) {
      await this.installDarwin(tempPath);
      return;
    }

    // #866 — Setup.exe is a first-INSTALL program, not an updater: its first
    // action is a recursive delete of the whole install root. Launching it from
    // here and quitting afterwards (what this function used to do) starts that
    // delete while our own processes still hold the tree open, the delete
    // throws, and the install aborts with the root already half-gone: no
    // Update.exe, no stub, no launcher to retry from.
    //
    // That is not a race a faster quit could win. `app.quit()` takes the DETACH
    // branch, which keeps the daemon alive by design, and the daemon's process
    // image IS `<root>\app-X.Y.Z\wmux.exe`. A running image cannot be unlinked
    // on Windows, so the delete is guaranteed to fail while it runs.
    //
    // So the installer is now started by a detached waiter that only proceeds
    // once every process under the install root is confirmed gone AND the root
    // is confirmed unlocked. See installTeardown.ts for why both checks are
    // needed (the pid list cannot close the window in which an agent's MCP host
    // spawns a fresh server into the directory we are about to delete).
    // Packaged-only, and the guard is load-bearing rather than cosmetic. The
    // teardown derives BOTH the image name and the install root from
    // `process.execPath`; in an unpackaged run that is the node/electron binary,
    // so the enumerate-and-kill would target unrelated processes that happen to
    // live under the runtime's directory. (Caught by the unit suite, which lost
    // its own worker to exactly that.) A dev build has no Squirrel install to
    // update anyway.
    if (!app.isPackaged) {
      this.isInstalling = false;
      this.sendToRenderer(IPC.UPDATE_ERROR, {
        status: 'error',
        source: 'install',
        message: 'In-app install is only available in an installed build. Download the latest release manually.',
      });
      return;
    }

    const installRoot = resolve(dirname(process.execPath), '..');
    const abortMarkerPath = join(app.getPath('userData'), INSTALL_ABORT_MARKER);
    const readyMarkerPath = join(app.getPath('userData'), INSTALL_READY_MARKER);
    // A stale heartbeat from a previous attempt would make the check below
    // pass without the new waiter ever having run. ENOENT — nothing there to
    // clear — is the expected, common case. Anything else means we cannot
    // prove the marker is gone, so a stale heartbeat could go on to authorize
    // the daemon shutdown and force-kill below for a waiter that never ran
    // this time. That is exactly the failure #1056 exists to catch, so this
    // fails closed instead of falling back to "same as if we had never added
    // the check" (coderabbit, #1057).
    try {
      await unlink(readyMarkerPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.isInstalling = false;
        this.sendToRenderer(IPC.UPDATE_ERROR, {
          status: 'error',
          source: 'install',
          message: 'Could not prepare the installer safely. The update was not started and your installation is unchanged.',
        });
        return;
      }
    }

    // Pre-flight: refuse BEFORE anything is written rather than dying halfway.
    // Budgeted per volume — the staging download and the install root can live
    // on different disks, so one aggregate number would be meaningless.
    const shortfall = freeSpaceShortfall(
      [
        { dir: dirname(tempPath), neededBytes: INSTALL_STAGING_HEADROOM_BYTES },
        { dir: installRoot, neededBytes: INSTALL_ROOT_HEADROOM_BYTES },
      ],
      probeVolume,
    );
    if (shortfall) {
      this.isInstalling = false;
      const needMb = Math.ceil(shortfall.neededBytes / 1024 / 1024);
      const freeMb = Math.floor(shortfall.freeBytes / 1024 / 1024);
      this.sendToRenderer(IPC.UPDATE_ERROR, {
        status: 'error',
        source: 'install',
        message: `Not enough free space on ${shortfall.volume} to install safely: ${needMb} MB needed, ${freeMb} MB free. Nothing was changed.`,
      });
      return;
    }

    // #980 — the WAIT list and the KILL list are different sets on purpose, and
    // conflating them is what broke this path:
    //
    //   wait : everything under the root. Nothing may hold the tree open when
    //          Setup.exe starts, regardless of who is responsible for ending it.
    //   kill : only what nothing else ends — the MCP servers, which run out of
    //          the install root but are owned by agent hosts rather than by us.
    //
    // Our own Electron helpers (renderer, GPU, utility) are the same wmux.exe
    // under the same root, so the old "everything except the daemon" filter
    // force-killed them too — and the very next thing this function does is
    // quit, into a before-quit handler that awaits a session save IN THE
    // RENDERER it had just killed. They exit with `app.quit()`; they stay on the
    // wait list, so sparing them cannot let the installer start early.
    //
    // The daemon is spared for its own, older reason: the full-shutdown branch
    // flushes its scrollback first. A null daemon pid still fails safe — it is
    // force-killed like anything else foreign, costing a flush but not the
    // install — unless it is one of our descendants, in which case app.quit()
    // is already taking it down.
    const survey = collectInstallRootProcesses(installRoot);
    const pids = survey.pids;
    const daemonPid = this.hooks.getDaemonPid();
    const forceKillPids = pids.filter((p) => p !== daemonPid && !survey.ownTree.has(p));

    // ORDER MATTERS, and it is the reverse of the obvious one.
    //
    // The waiter starts FIRST, while everything is still alive: it captures a
    // handle per pid up front, so it observes the processes we are about to end.
    // Only once it exists do we mutate anything.
    //
    // Doing it the other way round leaves wreckage on the failure path. Both
    // `onInstallRequiresFullShutdown` (a one-way latch — a later ordinary Quit
    // would then tear the daemon down and close every session) and the
    // force-kill are irreversible; if the waiter then failed to spawn we would
    // have killed the user's agent tooling and armed a destructive quit for an
    // install that never happened.
    const waiterPath = spawnInstallWaiter({
      pids,
      setupExePath: tempPath,
      installRoot,
      abortMarkerPath,
      readyMarkerPath,
      lockBudgetMs: INSTALL_LOCK_BUDGET_MS,
    });
    if (!waiterPath) {
      // No waiter means no safe way to start the installer. Falling back to
      // launching it directly is exactly the bug — refuse instead, with nothing
      // killed and no quit state armed.
      this.isInstalling = false;
      this.sendToRenderer(IPC.UPDATE_ERROR, {
        status: 'error',
        source: 'install',
        message: 'Could not prepare the installer safely. The update was not started and your installation is unchanged.',
      });
      return;
    }

    // #1056 — confirm the waiter's PowerShell process actually ran its first
    // line before doing anything that cannot be walked back. A real machine
    // showed the spawned process go completely silent, with none of the abort
    // paths in the script ever reached — nothing here proves WHY (see
    // installTeardown.ts for the leading theory), only THAT it happened, which
    // is enough to stop before the daemon shutdown and the force-kill below
    // instead of quitting into a hang nothing can explain afterward.
    const waiterAlive = await waitForWaiterHeartbeat(readyMarkerPath, WAITER_HEARTBEAT_BUDGET_MS);
    if (!waiterAlive) {
      this.isInstalling = false;
      console.error(`[AutoUpdater] waiter=${waiterPath} never signaled it started — refusing to quit`);
      this.sendToRenderer(IPC.UPDATE_ERROR, {
        status: 'error',
        source: 'install',
        message: 'The installer did not start. The update was not started and your installation is unchanged. Please try again.',
      });
      return;
    }

    // Committed now: bring the daemon down gracefully (it flushes scrollback)
    // and force-kill what nothing else owns — the MCP servers belong to agent
    // hosts, so a quit leaves them holding the tree open forever.
    this.hooks.onInstallRequiresFullShutdown();
    const killed = terminatePids(forceKillPids);

    // Which path ran, and against what — the first question anyone asks when an
    // update goes wrong, and the log is the only place to answer it from.
    console.log(
      `[AutoUpdater] install handoff: waiter=${waiterPath} watching ${pids.length} process(es) under ${installRoot}; ` +
      `force-killed ${killed.length}/${forceKillPids.length} foreign, ` +
      `${survey.ownTree.size} of our own left to app.quit(), ` +
      `daemon pid ${daemonPid ?? 'unknown'} left to the graceful shutdown`,
    );

    // Sessions do NOT survive this install. The daemon holds the install root
    // open, so it has to go down before Setup.exe can run — the old
    // "sessions persist in the daemon" line was false on this path and is the
    // reason the failure looked so surprising.
    console.log('[AutoUpdater] quitting for install — the daemon goes down with us so the installer runs against a dead tree');
    app.quit();
    this.armInstallQuitWatchdog(abortMarkerPath);
  }

  /**
   * #980 — `app.quit()` is a request, and on this path nothing else notices when
   * it is refused.
   *
   * Everything downstream assumes we die: the waiter is blocked on our own
   * process handles, so a surviving wmux holds the install root open until the
   * lock budget expires and the installer is refused. Meanwhile `isInstalling`
   * stays latched — it is deliberately never cleared on the success path,
   * because on the success path there is no process left to clear it in — so
   * every retry answers "an update install is already in progress" and the UI
   * keeps offering an "Install now" that can no longer do anything. That
   * combination is what turned one failed install into a permanently stuck
   * updater in the field, recoverable only by restarting the app by hand.
   *
   * Still being here at the deadline IS the failure signal. Report it, and
   * unlatch so the next attempt is at least possible. No attempt is made to
   * put the app back together: unlike the macOS path, by this point
   * `before-quit` has already stopped the pipe server, destroyed the tray and
   * disposed the IPC handlers, so "recovery" would hand the user a hollow
   * window. Say what happened and name the restart instead of pretending.
   */
  private armInstallQuitWatchdog(abortMarkerPath: string): void {
    const timer = setTimeout(() => {
      // The waiter may already have refused and left a reason; prefer it over
      // our own guess, since it knows WHICH process would not let go.
      const reason = readAbortMarker(abortMarkerPath);
      this.isInstalling = false;
      console.error(
        `[AutoUpdater] still running ${INSTALL_QUIT_WATCHDOG_MS}ms after quitting for install — ` +
        `the installer never started${reason ? ` (${reason})` : ''}`,
      );
      this.sendToRenderer(IPC.UPDATE_ERROR, {
        status: 'error',
        source: 'install',
        message: reason
          ? `The update did not install (${reason}). Your current version is unchanged — restart wmux and try again.`
          : 'The update did not install: wmux could not shut down to let the installer run. Your current version is unchanged — restart wmux and try again.',
      });
    }, INSTALL_QUIT_WATCHDOG_MS);
    // A healthy quit is long gone before this fires, and an unref'd timer must
    // never be the reason the process stays up.
    timer.unref();
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
   *
   * Two phases, each with its own deadline, because they fail differently:
   *
   *   setFeedURL ─> checkForUpdates ─── staging (Squirrel downloads + unpacks
   *        │                            120 MB over loopback) ──> update-downloaded
   *        └── arm STAGING deadline ────────────────────────────────┐
   *                                                                 │ (cleared)
   *                        onBeforeInstallQuit ─> quitAndInstall ────┤
   *                             └── arm HANDOFF deadline ───┐        │
   *                                                         ▼        ▼
   *                                      still alive? ─> unwind   process exits
   *                                      (abort quit, restore window, report)
   *
   * The quit is prepared as late as possible — immediately before
   * quitAndInstall, not before staging. Staging can legitimately take minutes on
   * a slow disk or behind antivirus, and a tight deadline covering it would abort
   * healthy updates; it also keeps the app in the dangerous "quitting" state
   * (windows closable, broker stopped) for the shortest possible window.
   *
   * Every exit from an attempt runs through settleAttempt(), which detaches the
   * Squirrel listeners. Without that, a late event from a torn-down attempt can
   * re-enter — a stray 'error' double-reports, and a stray 'update-downloaded'
   * calls quitAndInstall AFTER the abort restored the quit flag, re-creating the
   * exact hang this fix exists to remove.
   */
  private async installDarwin(zipPath: string): Promise<void> {
    const feed = new LocalUpdateFeed();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let quitPrepared = false;
    let settled = false;

    const armDeadline = (ms: number, onExpiry: () => void) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; onExpiry(); }, ms);
    };

    /** Terminal for this attempt: no Squirrel callback may act after this. */
    const settleAttempt = () => {
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      autoUpdater.removeAllListeners('update-downloaded');
      autoUpdater.removeAllListeners('error');
      void feed.stop();
    };

    const failInstall = (message: string) => {
      if (settled) return; // already reported — a late Squirrel event, ignore it
      settleAttempt();
      // Order matters: put the app back within reach BEFORE reporting, or the
      // error lands on a process the user cannot bring to the front. The hook
      // resolves once its window can actually receive IPC — a freshly created
      // window has no listeners attached until its renderer has loaded, and
      // sending into it early would drop the error and keep the UI silent.
      const reachable = quitPrepared
        ? (() => {
          quitPrepared = false;
          try {
            return Promise.resolve(this.hooks.onInstallQuitAborted());
          } catch (err) {
            console.error('[AutoUpdater] onInstallQuitAborted threw — app may need a manual restart:', err);
            return Promise.resolve();
          }
        })()
        : Promise.resolve();

      this.isInstalling = false; // let the user retry
      console.error('[AutoUpdater] macOS install failed (fail-closed):', message);
      void reachable
        .catch((err) => { console.error('[AutoUpdater] install-quit abort failed:', err); })
        .then(() => { this.sendToRenderer(IPC.UPDATE_ERROR, { status: 'error', source: 'install', message }); });
    };

    try {
      const { feedUrl } = await feed.start(zipPath);
      autoUpdater.removeAllListeners('update-downloaded');
      autoUpdater.removeAllListeners('error');
      autoUpdater.on('update-downloaded', () => {
        if (settled) return; // late event from an attempt that already failed
        console.log('[AutoUpdater] Squirrel.Mac staged the verified update — restarting to install (sessions persist in the daemon)');
        // The ZIP and downloadedPath are deliberately KEPT here (#1058
        // review F2): if the handoff deadline below fires, failInstall
        // unlatches and the re-offered Install button must find a verified
        // installer — nulling the path first made that retry answer "No
        // verified installer is ready yet" and forced a fresh ~150 MB
        // download on the exact platform the tagged-error fix targets. On
        // success this process is gone before any cleanup could run; the
        // leftover temp ZIP is reclaimed by the next boot sweep (its
        // version then equals the running one, so the 24h floor applies,
        // not the 7-day pending hold).

        // Let the windows close (the hide-to-tray intercept would otherwise
        // cancel the close quitAndInstall waits on), then deadline the handoff:
        // from here Squirrel owns terminating us, and if it does not, ShipIt
        // waits forever on a process that will never exit.
        quitPrepared = true;
        this.hooks.onBeforeInstallQuit();
        armDeadline(INSTALL_HANDOFF_TIMEOUT_MS, () => {
          failInstall(
            `The update was downloaded and verified, but installing it did not restart wmux within ${Math.round(INSTALL_HANDOFF_TIMEOUT_MS / 1000)}s. ` +
            `Quit wmux completely and try again, or install the latest release manually from https://github.com/${REPO}/releases`,
          );
        });
        autoUpdater.quitAndInstall();
      });
      autoUpdater.on('error', (err: Error) => {
        failInstall(this.describeDarwinInstallError(err));
      });

      armDeadline(INSTALL_STAGING_TIMEOUT_MS, () => {
        failInstall(
          `The update was downloaded and verified, but macOS did not finish preparing it within ${Math.round(INSTALL_STAGING_TIMEOUT_MS / 60_000)} minutes. ` +
          `Try again, or install the latest release manually from https://github.com/${REPO}/releases`,
        );
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
