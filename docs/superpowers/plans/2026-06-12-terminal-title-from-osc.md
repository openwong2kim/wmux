# Terminal Tab Title from OSC 0/2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a shell-set window title (OSC 0/2, e.g. Claude Code's `/rename`) update the terminal tab title, matching VS Code, with manual renames taking precedence.

**Architecture:** Mirror the existing `CWD_CHANGED` transport in BOTH PTY modes. A new pure `sanitizeTitle()` cleans the untrusted payload; the OSC handler in local-mode `PTYBridge` and daemon-mode `DaemonPTYBridge` emit it; it crosses the daemon→main boundary as a `title.changed` `DaemonEvent` exactly like `cwd.changed`; `pty.handler` forwards it to the renderer over a new `TERMINAL_TITLE_CHANGED` IPC; the renderer sets `surface.title` by ptyId unless the surface is `titleLocked`.

**Tech Stack:** Electron (main + daemon IPC), TypeScript, React/Zustand (renderer), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-terminal-title-from-osc-design.md`

---

## File Structure

- **Create** `src/main/pty/titleDetect.ts` — pure `sanitizeTitle()` + `TERMINAL_TITLE_MAX` (Electron-free, unit-testable; sibling of `cwdDetect.ts`).
- **Modify** `src/shared/constants.ts` — add `TERMINAL_TITLE_CHANGED` IPC channel.
- **Modify** `src/shared/rpc.ts:292-313` — add `'title.changed'` to the `DaemonEvent.type` union.
- **Modify** `src/shared/types.ts:36-47` — add `titleLocked?: boolean` to `Surface`.
- **Modify** `src/main/pty/PTYBridge.ts` — OSC switch: handle codes 0/2 (local mode).
- **Modify** `src/daemon/DaemonPTYBridge.ts:98-118` — OSC handler: emit `'title'` for codes 0/2.
- **Modify** `src/daemon/DaemonSessionManager.ts:353-360` — re-emit `'session:title'`.
- **Modify** `src/daemon/index.ts:1040-1047` — broadcast `DaemonEvent {type:'title.changed'}`.
- **Modify** `src/main/DaemonClient.ts:456-461` — re-emit `'session:title'` on `'title.changed'`.
- **Modify** `src/main/ipc/handlers/pty.handler.ts:179-201` — `onDaemonTitle` forwarder → `TERMINAL_TITLE_CHANGED`.
- **Modify** `src/preload/preload.ts` — `notification.onTitleChanged`.
- **Modify** `src/renderer/stores/slices/surfaceSlice.ts:22,167-194` — `updateSurfaceTitleByPty`; lock on `updateSurfaceTitle`.
- **Modify** `src/renderer/hooks/useNotificationListener.ts:282-295` — subscribe.
- **Tests:** `src/main/pty/__tests__/titleDetect.test.ts` (new); extend `src/renderer/stores/slices/__tests__/surfaceSlice.test.ts`.

---

## Task 1: `sanitizeTitle` pure helper

**Files:**
- Create: `src/main/pty/titleDetect.ts`
- Test: `src/main/pty/__tests__/titleDetect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/pty/__tests__/titleDetect.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeTitle, TERMINAL_TITLE_MAX } from '../titleDetect';

describe('sanitizeTitle', () => {
  it('keeps a normal title unchanged', () => {
    expect(sanitizeTitle('my-session')).toBe('my-session');
  });

  it('strips control chars (CR/LF/TAB/BEL/C1) and collapses whitespace', () => {
    expect(sanitizeTitle('a\r\nb\tc\x07d\x9ae')).toBe('a b c d e');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeTitle('  spaced  ')).toBe('spaced');
  });

  it('caps length at TERMINAL_TITLE_MAX', () => {
    const long = 'x'.repeat(TERMINAL_TITLE_MAX + 50);
    expect(sanitizeTitle(long)).toHaveLength(TERMINAL_TITLE_MAX);
  });

  it('returns empty string for control-only or empty input', () => {
    expect(sanitizeTitle('\x07\x1b\x00')).toBe('');
    expect(sanitizeTitle('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/pty/__tests__/titleDetect.test.ts`
Expected: FAIL — `Cannot find module '../titleDetect'`.

- [ ] **Step 3: Implement `titleDetect.ts`**

Create `src/main/pty/titleDetect.ts`:

```ts
/**
 * Window-title detection helper for OSC 0/2 ("set window title") sequences.
 *
 * Pure (no Electron/Node deps) so the sanitizer that turns untrusted shell
 * output into a safe tab title has direct regression coverage — sibling to
 * cwdDetect.ts. Both feed renderer surface fields off the same PTY data path.
 */

/** Max tab-title length, matching the pane-label cap (PANE_METADATA_LABEL_MAX). */
export const TERMINAL_TITLE_MAX = 64;

/**
 * Sanitize an OSC 0/2 window-title payload (untrusted shell output) into a safe
 * tab title: replace C0 controls, DEL, and C1 controls (covers CR/LF/TAB, BEL
 * \x07, and any ST/BEL terminator bytes that survive OSC parsing) with spaces,
 * collapse runs of whitespace, trim, and cap to TERMINAL_TITLE_MAX. Returns ''
 * when nothing printable remains.
 */
export function sanitizeTitle(raw: string): string {
  const stripped = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > TERMINAL_TITLE_MAX
    ? stripped.slice(0, TERMINAL_TITLE_MAX)
    : stripped;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/pty/__tests__/titleDetect.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/pty/titleDetect.ts src/main/pty/__tests__/titleDetect.test.ts
git commit -m "feat(pty): sanitizeTitle helper for OSC 0/2 window titles"
```

---

## Task 2: Shared contracts (IPC channel, DaemonEvent type, Surface field)

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/rpc.ts:304`
- Modify: `src/shared/types.ts:46`

- [ ] **Step 1: Add the IPC channel**

In `src/shared/constants.ts`, add after the `CWD_CHANGED` entry (search for `CWD_CHANGED:`):

```ts
  TERMINAL_TITLE_CHANGED: 'terminal:title-changed',
```

- [ ] **Step 2: Extend the DaemonEvent union**

In `src/shared/rpc.ts`, in the `DaemonEvent.type` union (line ~304), add `'title.changed'` right after `'cwd.changed'`:

```ts
    | 'cwd.changed'
    | 'title.changed'
```

- [ ] **Step 3: Add the Surface field**

In `src/shared/types.ts`, in the `Surface` interface (line ~46), add after `scrollbackFile`:

```ts
  /** True once the user manually renamed this tab; blocks shell-set (OSC 0/2) titles. */
  titleLocked?: boolean;
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS (additions only; no consumers broken yet).

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants.ts src/shared/rpc.ts src/shared/types.ts
git commit -m "feat(updater): shared contracts for terminal title (IPC + daemon event + Surface.titleLocked)"
```

---

## Task 3: Local-mode capture (`PTYBridge`)

**Files:**
- Modify: `src/main/pty/PTYBridge.ts` (import + OSC switch ~line 259)

- [ ] **Step 1: Import the sanitizer**

At the top of `src/main/pty/PTYBridge.ts`, add to the existing local imports (near the `cwdDetect`/`OscParser` imports):

```ts
import { sanitizeTitle } from './titleDetect';
```

- [ ] **Step 2: Handle OSC 0/2 in the switch**

In the `oscParser.onOsc((event) => { ... switch (event.code) {` block, add a case before `case 7:`:

```ts
        case 0:
        case 2: {
          // OSC 0 (icon + window title) / OSC 2 (window title) — e.g. Claude
          // Code's `/rename`. OSC 1 (icon name only) is intentionally ignored.
          const title = sanitizeTitle(event.data);
          if (title) win.webContents.send(IPC.TERMINAL_TITLE_CHANGED, ptyId, title);
          break;
        }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the PTYBridge suite (no regressions)**

Run: `npx vitest run src/main/pty`
Expected: PASS (existing PTYBridge/OscParser suites green; title path has no dedicated main test — it's covered end-to-end by the renderer + sanitize unit tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/pty/PTYBridge.ts
git commit -m "feat(pty): local mode forwards OSC 0/2 window title to renderer"
```

---

## Task 4: Daemon-mode capture and relay

**Files:**
- Modify: `src/daemon/DaemonPTYBridge.ts:98-118`
- Modify: `src/daemon/DaemonSessionManager.ts:353-360`
- Modify: `src/daemon/index.ts:1040-1047`
- Modify: `src/main/DaemonClient.ts:456-461`

- [ ] **Step 1: Emit `'title'` from the daemon bridge**

In `src/daemon/DaemonPTYBridge.ts`, add the import near the top (with the other `../main/pty` imports):

```ts
import { sanitizeTitle } from '../main/pty/titleDetect';
```

In the `oscParser.onOsc((event) => { ... })` block (line ~98), add before the `if (event.code === 7)` check:

```ts
      if (event.code === 0 || event.code === 2) {
        // OSC 0/2 window title (e.g. Claude Code `/rename`). OSC 1 (icon-only)
        // is ignored. Sanitized here so the daemon→main payload is already safe.
        const title = sanitizeTitle(event.data);
        if (title) this.emit('title', { sessionId, title });
        return;
      }
```

- [ ] **Step 2: Re-emit `'session:title'` from the session manager**

In `src/daemon/DaemonSessionManager.ts`, after the `bridge.on('cwd', ...)` block (line ~360), add:

```ts
    bridge.on('title', (payload: { sessionId: string; title: string }) => {
      // Forward across the daemon→main boundary so the renderer can set the
      // per-surface tab title (e.g. Claude Code `/rename`). Mirrors session:cwd.
      this.emit('session:title', payload);
    });
```

- [ ] **Step 3: Broadcast `title.changed` over the pipe**

In `src/daemon/index.ts`, after the `sessionManager.on('session:cwd', ...)` block (line ~1047), add:

```ts
  // Window-title change (OSC 0/2, detected in the daemon bridge). Broadcast so
  // main can forward it to the renderer as IPC.TERMINAL_TITLE_CHANGED — same
  // shape as cwd.changed above.
  sessionManager.on('session:title', (payload: { sessionId: string; title: string }) => {
    const event: DaemonEvent = {
      type: 'title.changed',
      sessionId: payload.sessionId,
      data: payload.title,
    };
    pipeServer.broadcast(event);
  });
```

- [ ] **Step 4: Re-emit in the main-side DaemonClient**

In `src/main/DaemonClient.ts`, in the event-type switch, after the `case 'cwd.changed':` block (line ~461), add:

```ts
        case 'title.changed':
          // OSC 0/2 window title detected daemon-side; surfaced to the renderer
          // (via pty.handler) as IPC.TERMINAL_TITLE_CHANGED. event.data is the
          // sanitized title string.
          this.emit('session:title', { sessionId: event.sessionId, title: event.data as string });
          break;
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS — `title.changed` is now a valid `DaemonEvent.type` (Task 2).

- [ ] **Step 6: Run the daemon suite (no regressions)**

Run: `npx vitest run src/daemon src/main`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/DaemonPTYBridge.ts src/daemon/DaemonSessionManager.ts src/daemon/index.ts src/main/DaemonClient.ts
git commit -m "feat(daemon): relay OSC 0/2 window title across daemon->main"
```

---

## Task 5: Main forwards daemon title to the renderer (`pty.handler`)

**Files:**
- Modify: `src/main/ipc/handlers/pty.handler.ts:179-201`

- [ ] **Step 1: Add the forwarder variable + subscription**

In `src/main/ipc/handlers/pty.handler.ts`, after the `onDaemonCwd` declaration (line ~179) add a sibling declaration:

```ts
  // Daemon-mode title forwarder. The daemon detects OSC 0/2 and emits
  // session:title; we relay it to the renderer as IPC.TERMINAL_TITLE_CHANGED,
  // matching what local-mode PTYBridge does inline.
  let onDaemonTitle: ((payload: { sessionId: string; title: string }) => void) | null = null;
```

Inside the `if (useDaemon && daemonClient) {` block, after the `daemonClient.on('session:cwd', onDaemonCwd);` line (~200), add:

```ts
    onDaemonTitle = (payload: { sessionId: string; title: string }) => {
      const win = getWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.TERMINAL_TITLE_CHANGED, payload.sessionId, payload.title);
      }
    };
    daemonClient.on('session:title', onDaemonTitle);
```

- [ ] **Step 2: Mirror cleanup if cwd has teardown**

Search the file for `daemonClient.off('session:cwd'` or `removeListener('session:cwd'` (cleanup of `onDaemonCwd`). If such a cleanup block exists, add the symmetric line right after it:

```ts
      if (onDaemonTitle) daemonClient.off('session:title', onDaemonTitle);
```

If no cwd cleanup exists in this file, skip this step (the listener lives for the handler's lifetime, same as `onDaemonCwd`).

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/handlers/pty.handler.ts
git commit -m "feat(pty): forward daemon session:title to renderer as TERMINAL_TITLE_CHANGED"
```

---

## Task 6: Preload subscription

**Files:**
- Modify: `src/preload/preload.ts` (the `notification` object, near `onCwdChanged`)

- [ ] **Step 1: Add `onTitleChanged`**

In `src/preload/preload.ts`, inside the `notification` object, after the `onCwdChanged` subscription, add:

```ts
    onTitleChanged: (callback: (ptyId: string, title: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ptyId: string, title: string) =>
        callback(ptyId, title);
      ipcRenderer.on(IPC.TERMINAL_TITLE_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.TERMINAL_TITLE_CHANGED, listener); };
    },
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/preload/preload.ts
git commit -m "feat(preload): notification.onTitleChanged subscription"
```

---

## Task 7: Renderer store — `updateSurfaceTitleByPty` + manual-rename lock

**Files:**
- Modify: `src/renderer/stores/slices/surfaceSlice.ts:22,167-194`
- Test: `src/renderer/stores/slices/__tests__/surfaceSlice.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/renderer/stores/slices/__tests__/surfaceSlice.test.ts`, append after the `surfaceSlice.updateSurfaceTitle` describe block (after line ~79):

```ts
describe('surfaceSlice.updateSurfaceTitleByPty', () => {
  it('sets the title of the terminal surface bound to a ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');

    slice.updateSurfaceTitleByPty('pty-1', 'claude: feature-x');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].title).toBe('claude: feature-x');
  });

  it('is a no-op for an unknown ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const before = (state.workspaces[0].rootPane as { surfaces: { title: string }[] }).surfaces[0].title;

    slice.updateSurfaceTitleByPty('ghost', 'nope');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].title).toBe(before);
  });

  it('is ignored once the surface title is locked by a manual rename', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.updateSurfaceTitle(surfaceId, 'my-name'); // manual rename → locks
    slice.updateSurfaceTitleByPty('pty-1', 'shell-set'); // must be ignored

    expect(pane.surfaces[0].title).toBe('my-name');
    expect(pane.surfaces[0].titleLocked).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/stores/slices/__tests__/surfaceSlice.test.ts`
Expected: FAIL — `slice.updateSurfaceTitleByPty is not a function`.

- [ ] **Step 3: Declare the action in the slice interface**

In `src/renderer/stores/slices/surfaceSlice.ts`, after the `updateSurfaceTitle` declaration (line ~22), add:

```ts
  updateSurfaceTitleByPty: (ptyId: string, title: string) => void;
```

- [ ] **Step 4: Lock the title on manual rename**

Replace the existing `updateSurfaceTitle` implementation (line ~167) so a manual rename also sets `titleLocked`:

```ts
  updateSurfaceTitle: (surfaceId, title) => set((state: StoreState) => {
    for (const ws of state.workspaces) {
      const updateInPane = (pane: Pane): boolean => {
        if (pane.type === 'leaf') {
          const surface = pane.surfaces.find((s) => s.id === surfaceId);
          if (surface) { surface.title = title; surface.titleLocked = true; return true; }
          return false;
        }
        return pane.children.some(updateInPane);
      };
      if (updateInPane(ws.rootPane)) return;
    }
  }),
```

- [ ] **Step 5: Implement `updateSurfaceTitleByPty`**

In `src/renderer/stores/slices/surfaceSlice.ts`, add directly after the `updateSurfaceCwd` implementation (after line ~194):

```ts
  updateSurfaceTitleByPty: (ptyId, title) => set((state: StoreState) => {
    if (!ptyId) return;
    for (const ws of state.workspaces) {
      const updateInPane = (pane: Pane): boolean => {
        if (pane.type === 'leaf') {
          const surface = pane.surfaces.find((s) => s.ptyId === ptyId);
          if (!surface) return false;
          // Terminal surfaces only, and never override a user's manual rename.
          if ((surface.surfaceType ?? 'terminal') === 'terminal' && !surface.titleLocked) {
            surface.title = title;
          }
          return true;
        }
        return pane.children.some(updateInPane);
      };
      if (updateInPane(ws.rootPane)) return;
    }
  }),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/renderer/stores/slices/__tests__/surfaceSlice.test.ts`
Expected: PASS (all `updateSurfaceCwd`, `updateSurfaceTitle`, `updateSurfaceTitleByPty` tests).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/stores/slices/surfaceSlice.ts src/renderer/stores/slices/__tests__/surfaceSlice.test.ts
git commit -m "feat(surface): updateSurfaceTitleByPty with manual-rename lock"
```

---

## Task 8: Renderer listener wiring

**Files:**
- Modify: `src/renderer/hooks/useNotificationListener.ts:282-295`

- [ ] **Step 1: Subscribe to title changes**

In `src/renderer/hooks/useNotificationListener.ts`, after the `const unsubCwd = ...` block (line ~295), add:

```ts
    const unsubTitle = window.electronAPI.notification.onTitleChanged((ptyId, title) => {
      // OSC 0/2 window title (e.g. Claude Code `/rename`) → the tab title,
      // unless the user manually renamed this surface (titleLocked).
      useStore.getState().updateSurfaceTitleByPty(ptyId, title);
    });
```

- [ ] **Step 2: Add to the effect cleanup**

Find the cleanup `return () => { ... }` of this effect (it calls `unsubNotif()`, `unsubCwd()`, `unsubMeta()`, …). Add `unsubTitle();` alongside them.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/hooks/useNotificationListener.ts
git commit -m "feat(renderer): apply OSC 0/2 window title to the terminal tab"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: PASS (all suites, including the new `titleDetect` and extended `surfaceSlice`).

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Lint touched files**

Run:
```bash
npx eslint src/main/pty/titleDetect.ts src/main/pty/PTYBridge.ts src/daemon/DaemonPTYBridge.ts src/daemon/DaemonSessionManager.ts src/daemon/index.ts src/main/DaemonClient.ts src/main/ipc/handlers/pty.handler.ts src/preload/preload.ts src/renderer/stores/slices/surfaceSlice.ts src/renderer/hooks/useNotificationListener.ts src/main/pty/__tests__/titleDetect.test.ts src/renderer/stores/slices/__tests__/surfaceSlice.test.ts
```
Expected: PASS for the new/changed code (the `no-control-regex` line carries an inline disable). Pre-existing warnings in untouched parts of these files are out of scope.

- [ ] **Step 4: Manual smoke (real app, daemon mode)**

Run `npm start`. In a PowerShell pane, set a title to confirm the tab follows:
```powershell
$Host.UI.RawUI.WindowTitle = "smoke-test-title"
```
(Or run Claude Code and `/rename`.) The terminal tab at the top of the pane should change to `smoke-test-title`. Then double-click the tab, rename it to `mine`, and re-run the command — the tab must stay `mine` (manual lock wins).

---

## Self-Review Notes (author checklist — completed)

- **Spec coverage:** OSC 0/2 capture + sanitize (Tasks 1, 3, 4) ✓; both PTY modes wired (local Task 3; daemon Tasks 4-5) ✓; IPC transport mirroring CWD_CHANGED (Tasks 2, 5, 6) ✓; surface.title update by ptyId (Task 7) ✓; manual-rename precedence via titleLocked (Tasks 2, 7) ✓; terminal-surfaces-only + empty-title-dropped + unknown-ptyId no-op (Tasks 3/4 drop empty in main; Task 7 guards type/lock/unknown) ✓; tests (Tasks 1, 7) ✓; display unchanged (SurfaceTabs already renders s.title) ✓.
- **Type consistency:** event/payload shapes are identical across the chain — daemon emits `{sessionId, title}`; `DaemonEvent {type:'title.changed', sessionId, data: title}`; `DaemonClient` re-emits `{sessionId, title}`; `pty.handler` sends `(sessionId, title)`; preload `onTitleChanged(ptyId, title)`; store `updateSurfaceTitleByPty(ptyId, title)`. IPC constant `TERMINAL_TITLE_CHANGED` and `Surface.titleLocked` used consistently.
- **No placeholders:** every code step shows full code; commands include expected output. (Task 5 Step 2 is conditional on a cwd-cleanup block existing — both branches are spelled out explicitly, not left vague.)
```
