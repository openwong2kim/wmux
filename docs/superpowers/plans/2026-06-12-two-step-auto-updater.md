# Two-Step Auto-Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Settings updater deadlock by auto-downloading + verifying an update on detection, streaming progress, then offering a "Restart to install" button.

**Architecture:** Main-process driven. `AutoUpdater.check()` detects an update, emits `available`, then internally runs `downloadUpdate()` which fetches the CI manifest, downloads + SHA-256-verifies the installer (streaming progress over the `UPDATE_DOWNLOAD` channel), and emits `downloaded`. `UPDATE_INSTALL` shrinks to launching the already-verified local file. The renderer is purely reactive: `available → downloading(%) → downloaded → install`.

**Tech Stack:** Electron (main `net`/`shell`, IPC), TypeScript, React (renderer), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-two-step-auto-updater-design.md`

---

## File Structure

- **Modify** `src/main/updater/AutoUpdater.ts` — add `downloadedPath`/`isDownloading` state, `downloadUpdate()`, progress in `downloadAndVerify()`, auto-trigger from `check()`, shrink `UPDATE_INSTALL` to a launcher.
- **Modify** `src/preload/preload.ts:394-417` — add `onUpdateProgress` to the `updater` object.
- **Modify** `src/renderer/components/Settings/SettingsPanel.tsx:802-898` — `UpdateStatus`: percent state, progress subscription, `downloading` status text + progress bar, "Restart to install" button.
- **Create** `src/main/updater/__tests__/AutoUpdater.download.test.ts` — two-step flow tests (auto-download, progress, downloaded, install-launches-local, sha256-mismatch fail-closed).
- **Unchanged** `src/main/updater/__tests__/AutoUpdater.platform.test.ts` — must stay green (feed returns 204 → no download triggered).
- **Unchanged** `src/shared/constants.ts` — `UPDATE_DOWNLOAD: 'update:download'` already exists (line 38).

> Note: spec said "extend AutoUpdater.platform.test.ts". We instead add a focused `AutoUpdater.download.test.ts` (separation by responsibility: platform-gating vs. download flow) and leave the platform test untouched. Same coverage, cleaner files.

---

## Task 1: Auto-download triggers on detection (win32) + emits `downloaded`

**Files:**
- Test: `src/main/updater/__tests__/AutoUpdater.download.test.ts` (create)
- Modify: `src/main/updater/AutoUpdater.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/updater/__tests__/AutoUpdater.download.test.ts`:

```ts
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
  const openPath = vi.fn(async () => '');

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
    webContents: { isCrashed: () => false, send: (channel: string, data: Record<string, unknown>) => sent.push({ channel, data }), executeJavaScript: vi.fn(async () => {}) },
  };

  // Mock fs so no real installer file is written; capture the streamed bytes.
  vi.doMock('node:fs', () => ({
    createWriteStream: () => ({ write: vi.fn(), end: (cb?: () => void) => cb && cb(), destroy: vi.fn(), on: () => {} }),
  }));
  vi.doMock('node:fs/promises', () => ({ unlink: vi.fn(async () => {}) }));

  vi.doMock('electron', () => ({
    autoUpdater: {},
    app: { getVersion: () => FAKE_VERSION, getPath: () => '/tmp' },
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
  return { AutoUpdater: mod.AutoUpdater, requestUrls, ipcHandlers, sent, openPath, win };
}

/** Flush queued microtasks so the chained net responses (feed→manifest→download) settle. */
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

describe('AutoUpdater two-step flow (win32)', () => {
  it('detection auto-downloads, streams progress, and emits downloaded', async () => {
    const { AutoUpdater, ipcHandlers, sent, win } = await loadWin32();
    const updater = new AutoUpdater(() => win as never);
    updater.start();

    // Drive a manual check (synchronous handler kicks off check()).
    const checkHandler = ipcHandlers.get(IPC.UPDATE_CHECK)!;
    await checkHandler();
    await flush();

    const statuses = sent.map((s) => `${s.channel}:${s.data.status}`);
    expect(statuses).toContain(`${IPC.UPDATE_AVAILABLE}:available`);
    expect(statuses).toContain(`${IPC.UPDATE_DOWNLOAD}:downloading`);
    expect(statuses).toContain(`${IPC.UPDATE_AVAILABLE}:downloaded`);

    const progress = sent.find((s) => s.channel === IPC.UPDATE_DOWNLOAD)!;
    expect(progress.data.percent).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/updater/__tests__/AutoUpdater.download.test.ts`
Expected: FAIL — only `available` is emitted; no `downloading`/`downloaded` (current code never downloads on detection).

- [ ] **Step 3: Add state fields + auto-download trigger in `AutoUpdater.ts`**

In the class field block (after `private pendingUpdate: UpdateInfo | null = null;`, ~line 49) add:

```ts
  private downloadedPath: string | null = null;
  private isDownloading = false;
```

In `check()`, replace the `if (update) { ... }` block (~lines 102-108) with:

```ts
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
```

- [ ] **Step 4: Add the `downloadUpdate()` method**

Add this private method (place it right after `check()`, before `fetchUpdate()`):

```ts
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
```

- [ ] **Step 5: Add progress reporting to `downloadAndVerify()`**

Change the signature (~line 182) to accept an optional progress callback:

```ts
  private downloadAndVerify(
    manifest: UpdateManifest,
    onProgress?: (percent: number | null) => void,
  ): Promise<string> {
```

Inside `request.on('response', (response) => { ... })`, after the `statusCode !== 200` guard and before `response.on('data', ...)`, add progress bookkeeping and emit per chunk. Replace the existing `response.on('data', ...)` handler:

```ts
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/main/updater/__tests__/AutoUpdater.download.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/updater/AutoUpdater.ts src/main/updater/__tests__/AutoUpdater.download.test.ts
git commit -m "feat(updater): auto-download + verify on detection, stream progress"
```

---

## Task 2: `UPDATE_INSTALL` launches the verified local file (no re-download)

**Files:**
- Test: `src/main/updater/__tests__/AutoUpdater.download.test.ts` (extend)
- Modify: `src/main/updater/AutoUpdater.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe('AutoUpdater two-step flow (win32)', ...)` block:

```ts
  it('UPDATE_INSTALL launches the downloaded file without re-fetching the manifest', async () => {
    const { AutoUpdater, ipcHandlers, requestUrls, openPath, win } = await loadWin32();
    const updater = new AutoUpdater(() => win as never);
    updater.start();

    await ipcHandlers.get(IPC.UPDATE_CHECK)!();
    await flush();
    const urlsAfterDownload = requestUrls.length;

    await ipcHandlers.get(IPC.UPDATE_INSTALL)!();
    await flush();

    // Launched the local installer, and made NO new network request.
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath.mock.calls[0][0]).toContain('wmux-update-');
    expect(requestUrls.length).toBe(urlsAfterDownload);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/updater/__tests__/AutoUpdater.download.test.ts -t "without re-fetching"`
Expected: FAIL — current `UPDATE_INSTALL` re-fetches the manifest and re-downloads (extra net requests; openPath path is a fresh download, not the stashed one).

- [ ] **Step 3: Replace the `UPDATE_INSTALL` handler body**

Replace the entire `ipcMain.handle(IPC.UPDATE_INSTALL, async () => { ... })` block (~lines 245-300) with a launcher that uses the pre-verified `downloadedPath`:

```ts
    ipcMain.handle(IPC.UPDATE_INSTALL, async () => {
      if (!isUpdaterSupported) {
        // No in-app installer on this platform — never launch a Windows
        // .Setup.exe on macOS/Linux.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/updater/__tests__/AutoUpdater.download.test.ts -t "without re-fetching"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/updater/AutoUpdater.ts src/main/updater/__tests__/AutoUpdater.download.test.ts
git commit -m "feat(updater): UPDATE_INSTALL launches pre-verified local installer"
```

---

## Task 3: Fail-closed on SHA-256 mismatch

**Files:**
- Test: `src/main/updater/__tests__/AutoUpdater.download.test.ts` (extend)
- Modify: none (verifies existing fail-closed behavior end-to-end)

- [ ] **Step 1: Write the failing test**

Append inside the `describe` block:

```ts
  it('rejects on sha256 mismatch: emits error, no downloaded path, install is a no-op', async () => {
    const BAD_SHA = 'a'.repeat(64);
    const { AutoUpdater, ipcHandlers, sent, openPath, win } = await loadWin32({ sha: BAD_SHA });
    const updater = new AutoUpdater(() => win as never);
    updater.start();

    await ipcHandlers.get(IPC.UPDATE_CHECK)!();
    await flush();

    const statuses = sent.map((s) => `${s.channel}:${s.data.status}`);
    expect(statuses).toContain(`${IPC.UPDATE_ERROR}:error`);
    expect(statuses).not.toContain(`${IPC.UPDATE_AVAILABLE}:downloaded`);

    // No verified file → install launches nothing.
    await ipcHandlers.get(IPC.UPDATE_INSTALL)!();
    await flush();
    expect(openPath).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/main/updater/__tests__/AutoUpdater.download.test.ts -t "sha256 mismatch"`
Expected: PASS immediately (Task 1 already implemented fail-closed download). If it fails, the digest-mismatch path in `downloadUpdate`/`downloadAndVerify` is wrong — fix there, do not weaken the assertions.

- [ ] **Step 3: Run the FULL updater suite (regression gate)**

Run: `npx vitest run src/main/updater`
Expected: PASS — both `AutoUpdater.download.test.ts` and the untouched `AutoUpdater.platform.test.ts` (the platform test's 204 feed means no download is ever triggered there).

- [ ] **Step 4: Commit**

```bash
git add src/main/updater/__tests__/AutoUpdater.download.test.ts
git commit -m "test(updater): fail-closed on sha256 mismatch (no install)"
```

---

## Task 4: Preload — expose `onUpdateProgress`

**Files:**
- Modify: `src/preload/preload.ts:394-417`

- [ ] **Step 1: Add the progress subscription**

In the `updater` object, after the `onUpdateError` subscription (before the closing `},` at line 417), add:

```ts
    onUpdateProgress: (callback: (data: { status: string; percent: number | null }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { status: string; percent: number | null }) =>
        callback(data);
      ipcRenderer.on(IPC.UPDATE_DOWNLOAD, listener);
      return () => { ipcRenderer.removeListener(IPC.UPDATE_DOWNLOAD, listener); };
    },
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS (no type errors). `IPC.UPDATE_DOWNLOAD` already exists in constants.

- [ ] **Step 3: Commit**

```bash
git add src/preload/preload.ts
git commit -m "feat(updater): preload onUpdateProgress subscription"
```

---

## Task 5: Renderer — progress bar + "Restart to install" button

**Files:**
- Modify: `src/renderer/components/Settings/SettingsPanel.tsx:802-898`

- [ ] **Step 1: Subscribe to progress + track percent**

In `UpdateStatus()`, after `const [errorMsg, setErrorMsg] = useState<string>('');` (~line 810) add:

```ts
  const [percent, setPercent] = useState<number | null>(null);
```

In the `useEffect` (~line 814), add a progress subscription and include it in cleanup. Replace the effect body's subscription list so it reads:

```ts
  useEffect(() => {
    const removeAvailable = window.electronAPI.updater.onUpdateAvailable((data) => {
      if (data.status === 'downloaded') {
        setState('downloaded');
        if (data.releaseName) setReleaseName(data.releaseName);
      } else {
        setState('available');
      }
    });
    const removeProgress = window.electronAPI.updater.onUpdateProgress((data) => {
      setState('downloading');
      setPercent(typeof data.percent === 'number' ? data.percent : null);
    });
    const removeNotAvailable = window.electronAPI.updater.onUpdateNotAvailable(() => {
      setState('not-available');
    });
    const removeError = window.electronAPI.updater.onUpdateError((data) => {
      setState('error');
      setErrorMsg(data.message || '');
    });
    return () => { removeAvailable(); removeProgress(); removeNotAvailable(); removeError(); };
  }, []);
```

- [ ] **Step 2: Add the `downloading` status text**

In the `statusText` switch (~line 844), add a case before `case 'available':`:

```ts
      case 'downloading': return percent === null
        ? t('settings.checkUpdate') + '…'
        : `${t('settings.checkUpdate')}… ${percent}%`;
```

(Reuses the existing `settings.checkUpdate` label as the "downloading" verb to avoid adding i18n keys across all locales. A dedicated `settings.downloading` key is a follow-up.)

- [ ] **Step 3: Add the `downloading` color**

In the `statusColor` switch (~line 854), add:

```ts
      case 'downloading': return 'var(--accent-green)';
```

- [ ] **Step 4: Render a progress bar + fix the button gate**

Replace the returned JSX action area. The status `<p>` block stays; insert a progress bar after the `errorMsg` block (after line ~875), and change the button ternary (~lines 877-895) so the install button shows in `downloaded` and the check button is disabled while `checking`/`downloading`:

Insert after the `{state === 'error' && errorMsg && (...)}` block:

```tsx
        {state === 'downloading' && (
          <div className="mt-1.5 h-1 w-40 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-surface)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: percent === null ? '100%' : `${percent}%`,
                backgroundColor: 'var(--accent-green)',
                opacity: percent === null ? 0.4 : 1,
              }}
            />
          </div>
        )}
```

Replace the button ternary (`{state === 'downloaded' ? (...) : (...)}`) with:

```tsx
        {state === 'downloaded' ? (
          <Button
            onClick={handleInstall}
            style={{ backgroundColor: 'var(--accent-green)', color: 'var(--bg-base)', border: 'none' }}
          >
            {t('settings.updateReady')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={handleCheck}
            disabled={state === 'checking' || state === 'downloading'}
            style={{ border: 'none', opacity: state === 'checking' || state === 'downloading' ? 0.5 : 1 }}
          >
            {t('settings.checkUpdate')}
          </Button>
        )}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS. `UpdateState` already includes `'downloading'` and `'downloaded'` (line 804), so no type change is needed.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Settings/SettingsPanel.tsx
git commit -m "feat(updater): settings progress bar + restart-to-install button"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS (all suites, including `src/main/updater/*`).

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Lint the touched files**

Run: `npx eslint src/main/updater/AutoUpdater.ts src/preload/preload.ts "src/renderer/components/Settings/SettingsPanel.tsx"`
Expected: PASS (no errors).

- [ ] **Step 4: Manual smoke (renderer state machine)**

Because the updater only runs network checks on packaged win32 builds (`NODE_ENV !== 'development'` and `isUpdaterSupported`), the download flow can't fire in `npm start`. Verify the renderer wiring instead:
- Run `npm start`, open Settings → General → Updates.
- Confirm the widget renders `v<version>` with a "Check for updates" button and no console errors referencing `onUpdateProgress`.
- (Full end-to-end download is exercised by the Vitest suite in Task 1-3.)

- [ ] **Step 5: Final commit (if any lint/format fixups were needed)**

```bash
git add -A
git commit -m "chore(updater): lint/format fixups for two-step updater"
```

---

## Self-Review Notes (author checklist — completed)

- **Spec coverage:** auto-download both manual+background (Task 1, triggered from `check()` which serves both paths) ✓; percentage progress (Task 1 Step 5 + Task 5) ✓; downloaded→install launcher (Task 2) ✓; fail-closed verify (Task 3) ✓; Settings-only surface (Task 5, no global badge) ✓; win32 gating preserved (Tasks 1-2 keep `isUpdaterSupported` guards; platform test green in Task 3) ✓; preload progress (Task 4) ✓.
- **Type consistency:** `downloadUpdate()`, `downloadedPath`, `isDownloading`, `onProgress(percent: number | null)`, `UPDATE_DOWNLOAD` payload `{status:'downloading', percent}` used identically across main, preload, renderer, and tests.
- **No placeholders:** every code step shows full code; commands include expected output.
```
