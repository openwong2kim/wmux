# Two-Step Auto-Updater (download → restart to install)

**Date:** 2026-06-12
**Status:** Approved design, ready for implementation plan
**Area:** `src/main/updater`, `src/preload`, `src/renderer/components/Settings`

## Problem

In Settings → General, clicking "Check for updates" reports that an update is
available but offers no way to install it. The user sees the text "Update
available" while the only button stays "Check for updates", so the update never
installs.

### Root cause (confirmed)

A state-machine deadlock between the main process and the Settings UI:

- **Main** (`AutoUpdater.ts`) emits only `UPDATE_AVAILABLE { status: 'available' }`
  when an update is found (line ~104). It **never** emits a `'downloaded'`
  status. The actual download + SHA-256 verify + launch happens lazily inside
  the `UPDATE_INSTALL` handler.
- **Renderer** (`SettingsPanel.tsx`, `UpdateStatus`) renders the actionable
  install button **only** when `state === 'downloaded'`:

  ```tsx
  {state === 'downloaded' ? <InstallButton/> : <CheckButton/>}
  ```

Because main never sends `'downloaded'`, the renderer is stuck in `'available'`,
where the only button is "Check for updates". `installUpdate()` is unreachable.
A codebase-wide search confirms `'downloaded'` exists **only** in the renderer —
nothing emits it.

## Goal

Replace the dead `available → (nothing)` path with a two-step flow:

1. On detection, **automatically download and verify** the update in the
   background, showing a percentage progress bar.
2. When the verified installer is ready, show a **"Restart to install"** button
   that launches it.

Auto-download applies to **both** manual "Check for updates" clicks and the
background 30-minute checks. The "Restart to install" affordance lives **only**
in the Settings panel for now (no global badge/toast).

## Non-goals (YAGNI)

- No out-of-Settings indicator (badge/dot/toast) when an update is ready.
- No macOS/Linux in-app update path — the win32-only gating
  (`isUpdaterSupported`) is preserved unchanged.
- No change to the update feed, manifest format, or SHA-256 verification policy.

## Architecture

Main-process driven. The renderer is purely reactive: it reflects status events
and exposes two actions (`checkForUpdates`, `installUpdate`). All orchestration
stays in `AutoUpdater`.

### State machine (renderer)

```
idle → checking → available → downloading(percent) → downloaded → (install → relaunch)
                     │                                    
          not-available / error  (terminal, from any check/download step)
```

### Main process — `src/main/updater/AutoUpdater.ts`

- **New field:** `private downloadedPath: string | null = null` — the verified,
  on-disk installer for the current pending update.
- **New field:** `private isDownloading = false` — re-entrancy guard.
- **`check()` change:** after `fetchUpdate()` returns an update and
  `pendingUpdate` is stored and `UPDATE_AVAILABLE { status: 'available', ... }`
  is emitted (unchanged), `check()` calls the new `downloadUpdate()` (fire and
  forget; its own errors are surfaced via `UPDATE_ERROR`).
- **New private `downloadUpdate()`:** moves the download orchestration that
  currently lives in the `UPDATE_INSTALL` handler:
  1. Guard: return if `!isUpdaterSupported`, `isDownloading`, no `pendingUpdate`,
     or `downloadedPath` already set for this pending version.
  2. `fetchManifest()` → `validateManifest(raw, pendingUpdate.name)` (fail-closed
     on rejection, as today).
  3. `downloadAndVerify(manifest, onProgress)` — see below.
  4. On success: set `downloadedPath = tempPath`, emit
     `UPDATE_AVAILABLE { status: 'downloaded', releaseName: pendingUpdate.name }`.
  5. On any failure: emit `UPDATE_ERROR { status: 'error', message }`, best-effort
     `unlink` of any partial temp file, leave `downloadedPath = null`. Reset
     `isDownloading` in a `finally`.
- **`downloadAndVerify(manifest, onProgress?)` change:** gains an optional
  `onProgress: (percent: number | null) => void`. It reads `Content-Length` from
  the response headers; for each chunk it accumulates received bytes and calls
  `onProgress(Math.round(received / total * 100))`. If `Content-Length` is absent
  or unparseable, it calls `onProgress(null)` once (renderer shows an
  indeterminate spinner). The existing streaming hash + digest check are
  unchanged. `onProgress` forwards over `UPDATE_DOWNLOAD`
  (`'update:download'`, already declared in `constants.ts`) as
  `{ status: 'downloading', percent }`.
- **`UPDATE_INSTALL` handler shrinks to a launcher:**
  1. Off-win32 / no `downloadedPath` → inert no-op (preserves the platform test).
  2. Run the existing session-save step (dispatch `beforeunload`, 500 ms wait).
  3. `shell.openPath(downloadedPath)`; on a non-empty error string, emit
     `UPDATE_ERROR`. No manifest fetch, no re-download.
- **`stop()`:** unchanged. `UPDATE_DOWNLOAD` is a main→renderer *send* (no
  `ipcMain` handler to remove), and `downloadedPath`/`isDownloading` die with the
  torn-down instance.

### Preload — `src/preload/preload.ts`

Add to the `updater` object:

```ts
onUpdateProgress: (callback: (data: { status: string; percent: number | null }) => void) => {
  const listener = (_e, data) => callback(data);
  ipcRenderer.on(IPC.UPDATE_DOWNLOAD, listener);
  return () => { ipcRenderer.removeListener(IPC.UPDATE_DOWNLOAD, listener); };
},
```

No other preload changes. `installUpdate()` / `checkForUpdates()` are unchanged.

### Renderer — `src/renderer/components/Settings/SettingsPanel.tsx` (`UpdateStatus`)

- Extend `UpdateState` usage so `downloading` carries a percent: add
  `const [percent, setPercent] = useState<number | null>(null)`.
- In the effect, subscribe to `onUpdateProgress` → `setState('downloading')` +
  `setPercent(data.percent)`. Keep existing `onUpdateAvailable`
  (`'available'` → `setState('available')`; `'downloaded'` → `setState('downloaded')`
  and store `releaseName`), `onUpdateNotAvailable`, `onUpdateError`. Remember to
  return the new unsubscribe from the effect cleanup.
- `statusText`: add `downloading` → e.g. "Downloading… 47%" (or "Downloading
  update…" when `percent === null`).
- Render a thin progress bar (filled to `percent`, or indeterminate when null)
  in the `downloading` state.
- Button logic: `downloaded` → "Restart to install" (`handleInstall`);
  `downloading`/`checking` → disabled; otherwise → "Check for updates"
  (`handleCheck`). This removal of the `available`-state dead end is the fix.

### IPC channels

| Channel | Direction | Payload | Status |
|---|---|---|---|
| `UPDATE_CHECK` (`update:check`) | renderer→main invoke | — | unchanged |
| `UPDATE_AVAILABLE` (`update:available`) | main→renderer | `{ status: 'available' \| 'downloaded', releaseName?, releaseNotes? }` | reused for `downloaded` |
| `UPDATE_DOWNLOAD` (`update:download`) | main→renderer | `{ status: 'downloading', percent: number \| null }` | newly used (constant already existed) |
| `UPDATE_NOT_AVAILABLE` / `UPDATE_ERROR` | main→renderer | unchanged | unchanged |
| `UPDATE_INSTALL` (`update:install`) | renderer→main invoke | — | behavior changes (launch only) |

## Data flow (happy path)

```
check() → fetchUpdate() → UPDATE_AVAILABLE{available}
  → downloadUpdate() → fetchManifest → validateManifest
     → downloadAndVerify(onProgress) → UPDATE_DOWNLOAD{downloading, %}…
        → sha256 match → downloadedPath set → UPDATE_AVAILABLE{downloaded}
  → user clicks "Restart to install" → UPDATE_INSTALL
     → session save → shell.openPath(downloadedPath) → Squirrel relaunches
```

## Error handling

- **Manifest rejected / transport error / sha256 mismatch:** fail-closed —
  `UPDATE_ERROR` to renderer, partial temp file unlinked, `downloadedPath` stays
  null, `isDownloading` reset. Renderer shows the error and reverts to a
  "Check for updates" button so the user can retry.
- **Background download while Settings closed:** events are still sent; the
  renderer simply isn't mounted. On next Settings open, `UpdateStatus` mounts in
  `idle` until the next check. (Acceptable for v1 — Settings-only scope. A future
  enhancement could query current state on mount.)
- **Re-entrancy:** `isDownloading` and the per-version `downloadedPath` guard
  prevent a background check from starting a second download of the same update.

## Testing

Extend `src/main/updater/__tests__/AutoUpdater.platform.test.ts`:

- **Off-win32 (existing):** `UPDATE_CHECK` resolves not-available and
  `UPDATE_INSTALL` is an inert no-op, never touching the network. Must stay green.
- **win32 (mocked net + manifest):**
  - After a successful `check()`, `downloadUpdate()` runs automatically:
    `UPDATE_DOWNLOAD` progress events are emitted and a final
    `UPDATE_AVAILABLE { status: 'downloaded' }` fires.
  - `UPDATE_INSTALL` launches the stored `downloadedPath` via `shell.openPath`
    and does **not** re-fetch the manifest (assert manifest fetch called once,
    during download).
  - Failure path: a sha256 mismatch emits `UPDATE_ERROR`, unlinks the temp file,
    and leaves no `downloadedPath` (subsequent `UPDATE_INSTALL` is a no-op).

## Rollout caveat

This fix ships in the next release (3.1.2+). A client on 3.1.1 (or the manually
installed build) still has the old deadlock, so the **first** update from 3.1.1
to a fixed build is still manual. Every update after that is automatic.
