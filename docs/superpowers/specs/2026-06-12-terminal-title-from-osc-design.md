# Terminal Tab Title from OSC 0/2 (shell-set window title)

**Date:** 2026-06-12
**Status:** Approved design, ready for implementation plan
**Area:** `src/main/pty`, `src/main/ipc/handlers`, `src/preload`, `src/renderer`

## Problem

Running `/rename` inside the Claude Code CLI (or any shell that sets its window
title) emits a terminal "set window title" escape sequence — **OSC 0** (icon +
window title) or **OSC 2** (window title). VS Code's terminal reads this and
renames the tab. wmux parses OSC sequences but the `oscParser.onOsc()` switch in
`PTYBridge.ts` only handles codes 7, 9, 99, 777, 7727, 133 — **codes 0 and 2 are
silently dropped**. So a `/rename` title never reaches the UI, and the terminal
tab keeps showing the default shell name (e.g. "PowerShell").

## Goal

Read OSC 0/2 from the PTY and use it to set the terminal tab title
(`surface.title`), matching VS Code. A manual rename (double-click the tab) wins
over shell-set titles.

## Non-goals (YAGNI)

- No setting to toggle the behavior on/off (always on; a future toggle is a
  follow-up if shell title-spam proves noisy).
- No writing OSC titles *to* the PTY (we only read; we do not push wmux names
  down to the shell).
- No change to OSC 1 (icon-name-only) — ignored.
- No title on browser/editor surfaces.

## Architecture

The transport mirrors the existing `CWD_CHANGED` path exactly: parse the
sequence, send `(ptyId, value)` to the renderer over a dedicated IPC channel,
and a renderer listener updates the matching surface field. This keeps the new
code aligned with a proven, tested pattern.

**Both PTY modes must be wired**, exactly as cwd is. wmux runs terminals either
in-process (`PTYBridge`, local mode) or in a separate daemon (`DaemonPTYBridge`,
the default). The cwd signal travels two parallel paths, and the title must
follow both:
- **Local:** `PTYBridge` OSC handler → `IPC.TERMINAL_TITLE_CHANGED`.
- **Daemon:** `DaemonPTYBridge` OSC handler → `'title'` → `DaemonSessionManager`
  `'session:title'` → `daemon/index.ts` broadcasts `DaemonEvent {type:'title.changed'}`
  → `DaemonClient` re-emits `'session:title'` → `pty.handler` forwards
  `IPC.TERMINAL_TITLE_CHANGED`. This is the byte-for-byte analog of the
  `cwd`/`session:cwd`/`cwd.changed` chain.

```
shell emits OSC 0/2  →  OscParser strips bytes, emits {code,data}
  →  PTYBridge switch case 0/2: sanitizeTitle(data)
     →  IPC.TERMINAL_TITLE_CHANGED (ptyId, title)
        →  preload onTitleChanged
           →  useNotificationListener handler
              →  store.updateSurfaceTitleByPty(ptyId, title)
                 →  surface.title set (unless titleLocked)
                    →  SurfaceTabs renders s.title  (no display change needed)
```

## Components

### 1. Main — capture & sanitize (`src/main/pty/PTYBridge.ts`)

Add `case 0:` and `case 2:` (falling through to one block) to the
`oscParser.onOsc()` switch (currently ~line 259). The handler:

1. Computes `const title = sanitizeTitle(event.data)`.
2. If `title` is non-empty, `win.webContents.send(IPC.TERMINAL_TITLE_CHANGED, ptyId, title)`.
3. Empty/whitespace titles are dropped (no event) — a shell clearing the title
   leaves the existing tab title in place rather than blanking it.

OSC 1 (icon name only) is **not** added — it is not a window-title set.

`sanitizeTitle` is a new pure function. Per the design's "untrusted shell output"
requirement it must strip control characters and cap length. Place it where it
can be unit-tested without Electron — alongside the other pure PTY parsers in a
new `src/main/pty/titleDetect.ts` (sibling to `cwdDetect.ts`):

```ts
// src/main/pty/titleDetect.ts
/** Max tab-title length, matching the pane-label cap (PANE_METADATA_LABEL_MAX). */
export const TERMINAL_TITLE_MAX = 64;

/**
 * Sanitize an OSC 0/2 window-title payload (untrusted shell output) into a
 * safe tab title: strip C0/C1 control chars (incl. CR/LF/TAB and the ST/BEL
 * terminators that may survive parsing), collapse internal whitespace, trim,
 * and cap to TERMINAL_TITLE_MAX. Returns '' when nothing printable remains.
 */
export function sanitizeTitle(raw: string): string {
  const stripped = raw
    // Strip C0 controls, DEL, and C1 controls (covers CR/LF/TAB, BEL \x07,
    // and any ST/BEL terminator bytes that survive OSC parsing).
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > TERMINAL_TITLE_MAX
    ? stripped.slice(0, TERMINAL_TITLE_MAX)
    : stripped;
}
```

`PTYBridge.ts` imports `sanitizeTitle` from `./titleDetect`.

### 2. IPC channel (`src/shared/constants.ts`)

Add to the IPC map: `TERMINAL_TITLE_CHANGED: 'terminal:title-changed'`. Direction
is main → renderer (send), same as `CWD_CHANGED` (`'cwd:changed'`).

### 3. Preload (`src/preload/preload.ts`)

Add an `onTitleChanged` subscription to the `notification` object, mirroring
`onCwdChanged`:

```ts
onTitleChanged: (callback: (ptyId: string, title: string) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, ptyId: string, title: string) =>
    callback(ptyId, title);
  ipcRenderer.on(IPC.TERMINAL_TITLE_CHANGED, listener);
  return () => { ipcRenderer.removeListener(IPC.TERMINAL_TITLE_CHANGED, listener); };
},
```

### 4. Renderer store (`src/renderer/stores/slices/surfaceSlice.ts`)

- Add a `titleLocked?: boolean` field to the `Surface` type (`src/shared/types.ts`),
  defaulting unset (falsy = unlocked).
- Add `updateSurfaceTitleByPty(ptyId: string, title: string)`: find the terminal
  surface whose `ptyId === ptyId`; if found, its `surfaceType` is terminal (or
  unset), and `titleLocked` is not true, set `surface.title = title`. Mirrors the
  existing `updateSurfaceCwd(ptyId, cwd)` lookup.
- Modify the existing manual-rename action `updateSurfaceTitle(surfaceId, title)`
  (called from the double-click rename in `SurfaceTabs.tsx`) to also set
  `titleLocked = true` on that surface, so subsequent OSC titles are ignored.

### 5. Renderer listener (`src/renderer/hooks/useNotificationListener.ts`)

Alongside the existing `onCwdChanged` subscription (~line 282), add:

```ts
const removeTitle = window.electronAPI.notification.onTitleChanged((ptyId, title) => {
  useStore.getState().updateSurfaceTitleByPty(ptyId, title);
});
```

…and include `removeTitle()` in the effect cleanup.

### 6. Display

No change. `SurfaceTabs.tsx` already renders `s.title || t('surface.terminal')`,
so an updated `surface.title` shows immediately.

## Data flow & precedence rules

- **Default (unlocked):** OSC 0/2 → `surface.title` updates live. `/rename`
  works out of the box.
- **Manual rename:** double-click rename sets `titleLocked = true`; future OSC
  titles are ignored for that surface. (Matches VS Code: a user name sticks.)
- **Empty OSC title:** dropped in main; tab keeps its prior title.
- **Non-terminal surface / unknown ptyId:** `updateSurfaceTitleByPty` is a no-op.

## Error handling

- Title is sanitized in main (control-char strip + 64-char cap) before crossing
  IPC, so a malicious/garbled sequence cannot inject control bytes or an
  oversized string into the UI.
- Listener lookups that miss (pty gone, browser surface) are silent no-ops.

## Testing

- **`src/main/pty/__tests__/titleDetect.test.ts` (new):** `sanitizeTitle` strips
  control chars (incl. CR/LF, BEL `\x07`, C1 range), collapses whitespace, trims,
  caps at 64 chars, and returns `''` for control-only/empty input.
- **`src/main/pty/__tests__/OscParser.test.ts` or `PTYBridge` suite:** OSC 0 and
  OSC 2 payloads reach the handler (currently they are dropped); assert a
  `TERMINAL_TITLE_CHANGED` send with the sanitized title, and that an
  empty-title sequence sends nothing.
- **`src/renderer/stores/slices/__tests__/surfaceSlice.test.ts`:**
  `updateSurfaceTitleByPty` sets the title for a matching terminal surface;
  is a no-op for a browser surface and for an unknown ptyId; and is ignored when
  `titleLocked` is true. `updateSurfaceTitle` (manual) sets `titleLocked`.

## Out of scope / related

- **Split CWD inheritance** (the user's other report) is **already implemented**
  in v3.0.0+ (`splitInheritsCwd`, default on; commit 890e388). The user observed
  it missing on v2.18.0, which predates the feature. No code change here; the fix
  is updating to 3.1.1. If it still misbehaves on 3.1.1 in a specific workflow,
  that is a separate debugging task.
