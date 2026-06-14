# Agent Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a removable bottom toolbar to wmux with five tools (Attach, File explorer, Snippets, Rich Input, New) that inject text/keys into the focused pane's terminal.

**Architecture:** First-party renderer UI + internal IPC only. A new `AgentToolbar` React component mounts at the bottom of the main column in `AppLayout`. All actions resolve the focused terminal's `ptyId` and write through the existing `pty.write` / `pastePtyChunked` plumbing. Two new main-side IPC handlers provide `git status --porcelain` and an OS file picker. State lives in a new Zustand `agentToolbarSlice`; non-sensitive prefs persist via `SessionData`. No AI transport, no credentials, no new public RPC.

**Tech Stack:** Electron 41, React 19, Zustand 5 (immer), xterm.js 6, Vitest. Spec: `docs/superpowers/specs/2026-06-14-agent-toolbar-design.md`.

---

## File structure

**New files**
- `src/shared/gitStatus.ts` — pure `git status --porcelain` parser + types
- `src/shared/__tests__/gitStatus.test.ts`
- `src/renderer/utils/focusedSurface.ts` — resolve the focused terminal `ptyId`
- `src/renderer/utils/__tests__/focusedSurface.test.ts`
- `src/renderer/stores/slices/agentToolbarSlice.ts` — toolbar state
- `src/renderer/stores/slices/__tests__/agentToolbarSlice.test.ts`
- `src/main/ipc/handlers/toolbar.handler.ts` — `git:status` + `dialog:pick-file`
- `src/renderer/components/AgentToolbar/AgentToolbar.tsx` — the bar + inject helpers
- `src/renderer/components/AgentToolbar/RichInput.tsx` — scratchpad popover
- `src/renderer/components/AgentToolbar/SnippetsMenu.tsx` — snippet dropdown
- `src/renderer/components/AgentToolbar/FileExplorerPopover.tsx` — repo tree + git badges
- `src/renderer/components/AgentToolbar/inject.ts` — shared PTY-inject helper
- `src/renderer/components/AgentToolbar/__tests__/inject.test.ts`

**Modified files**
- `src/shared/constants.ts` — add `GIT_STATUS`, `DIALOG_PICK_FILE` IPC channels
- `src/shared/electron.d.ts` — add `git` + `dialog` namespaces to the window type
- `src/preload/preload.ts` — expose `electronAPI.git.status`, `electronAPI.dialog.pickFile`
- `src/main/ipc/registerHandlers.ts` — register the toolbar handlers
- `src/renderer/stores/index.ts` — wire `agentToolbarSlice`
- `src/shared/types.ts` — add 3 optional fields to `SessionData`
- `src/renderer/components/Layout/AppLayout.tsx` — mount `<AgentToolbar/>`; persist prefs
- `src/renderer/stores/slices/workspaceSlice.ts` — read prefs in `loadSession`
- `src/renderer/components/Settings/SettingsPanel.tsx` — toggle + new-command field + snippet mgmt
- `src/renderer/i18n/locales/en.ts` and `ko.ts` — strings

---

## Task 1: Git porcelain parser (shared, pure)

**Files:**
- Create: `src/shared/gitStatus.ts`
- Test: `src/shared/__tests__/gitStatus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/__tests__/gitStatus.test.ts
import { describe, it, expect } from 'vitest';
import { parsePorcelain, type GitFileStatus } from '../gitStatus';

describe('parsePorcelain', () => {
  it('maps modified, added, deleted, untracked', () => {
    const out = ' M src/a.ts\nA  src/b.ts\n D src/c.ts\n?? src/d.ts\n';
    expect(parsePorcelain(out)).toEqual<GitFileStatus[]>([
      { path: 'src/a.ts', code: 'M' },
      { path: 'src/b.ts', code: 'A' },
      { path: 'src/c.ts', code: 'D' },
      { path: 'src/d.ts', code: 'U' },
    ]);
  });

  it('takes the new name for renames', () => {
    const out = 'R  old.ts -> new.ts\n';
    expect(parsePorcelain(out)).toEqual([{ path: 'new.ts', code: 'R' }]);
  });

  it('ignores blank lines and returns [] for empty input', () => {
    expect(parsePorcelain('')).toEqual([]);
    expect(parsePorcelain('\n\n')).toEqual([]);
  });

  it('prefers staged code, falls back to worktree code', () => {
    // "MM" — staged M and worktree M → M; "AM" → A (staged wins)
    expect(parsePorcelain('MM x\nAM y\n')).toEqual([
      { path: 'x', code: 'M' },
      { path: 'y', code: 'A' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/__tests__/gitStatus.test.ts`
Expected: FAIL — cannot find module `../gitStatus`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/gitStatus.ts
/** Single-letter status badge, VS-Code style. */
export type GitStatusCode = 'M' | 'A' | 'D' | 'U' | 'R';

export interface GitFileStatus {
  /** Repo-relative path (the new name for renames). */
  path: string;
  code: GitStatusCode;
}

/** Map a porcelain v1 XY pair to one display code. Staged (X) wins; '?'→U. */
function toCode(x: string, y: string): GitStatusCode | null {
  const pick = (c: string): GitStatusCode | null => {
    if (c === 'M') return 'M';
    if (c === 'A') return 'A';
    if (c === 'D') return 'D';
    if (c === 'R') return 'R';
    if (c === '?') return 'U';
    return null;
  };
  return pick(x) ?? pick(y);
}

/**
 * Parse `git status --porcelain` (v1) output into per-file display codes.
 * Format: two status chars, a space, then the path. Renames are
 * `R  old -> new`; we keep the new name. Lines we can't classify are dropped.
 */
export function parsePorcelain(output: string): GitFileStatus[] {
  const result: GitFileStatus[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    const code = toCode(x, y);
    if (!code) continue;
    let path = line.slice(3).trim();
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4).trim();
    if (path) result.push({ path, code });
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/__tests__/gitStatus.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/gitStatus.ts src/shared/__tests__/gitStatus.test.ts
git commit -m "feat(toolbar): git porcelain status parser"
```

---

## Task 2: Focused-terminal resolver (renderer util, pure)

Resolves the active workspace's active leaf pane → active surface → `ptyId`, returning `null` when the focused surface is not a terminal (so inject actions can disable).

**Files:**
- Create: `src/renderer/utils/focusedSurface.ts`
- Test: `src/renderer/utils/__tests__/focusedSurface.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/utils/__tests__/focusedSurface.test.ts
import { describe, it, expect } from 'vitest';
import { focusedTerminalPtyId } from '../focusedSurface';
import type { Workspace } from '../../../shared/types';

function leaf(id: string, surfaces: any[], activeSurfaceId: string) {
  return { id, type: 'leaf', surfaces, activeSurfaceId } as any;
}

function ws(rootPane: any, activePaneId: string): Workspace {
  return { id: 'w1', name: 'w', rootPane, activePaneId } as any;
}

describe('focusedTerminalPtyId', () => {
  it('returns the active terminal surface ptyId', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: 'pty-1', surfaceType: 'terminal' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBe('pty-1');
  });

  it('treats missing surfaceType as terminal', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: 'pty-9' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBe('pty-9');
  });

  it('returns null when the active surface is a browser/editor', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: '', surfaceType: 'browser' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBeNull();
  });

  it('descends a branch tree to the active leaf', () => {
    const child = leaf('p2', [{ id: 's2', ptyId: 'pty-2', surfaceType: 'terminal' }], 's2');
    const root = { id: 'b', type: 'branch', children: [child] } as any;
    expect(focusedTerminalPtyId(ws(root, 'p2'))).toBe('pty-2');
  });

  it('returns null for undefined workspace or empty ptyId', () => {
    expect(focusedTerminalPtyId(undefined)).toBeNull();
    const root = leaf('p1', [{ id: 's1', ptyId: '', surfaceType: 'terminal' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/utils/__tests__/focusedSurface.test.ts`
Expected: FAIL — cannot find module `../focusedSurface`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/renderer/utils/focusedSurface.ts
import type { Workspace, Pane, PaneLeaf } from '../../shared/types';

/** Find the leaf pane matching the workspace's activePaneId. */
export function findActiveLeaf(workspace: Workspace): PaneLeaf | null {
  const walk = (pane: Pane): PaneLeaf | null => {
    if (pane.type === 'leaf') return pane.id === workspace.activePaneId ? pane : null;
    for (const child of pane.children) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(workspace.rootPane);
}

/**
 * Resolve the ptyId of the focused terminal surface, or null when no terminal
 * is focused (no workspace, non-terminal surface, or unbound ptyId). Toolbar
 * inject actions use null to disable themselves.
 */
export function focusedTerminalPtyId(workspace: Workspace | undefined): string | null {
  if (!workspace) return null;
  const leaf = findActiveLeaf(workspace);
  if (!leaf) return null;
  const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  if (!surface) return null;
  const type = surface.surfaceType ?? 'terminal';
  if (type !== 'terminal') return null;
  return surface.ptyId ? surface.ptyId : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/utils/__tests__/focusedSurface.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/utils/focusedSurface.ts src/renderer/utils/__tests__/focusedSurface.test.ts
git commit -m "feat(toolbar): focused-terminal ptyId resolver"
```

---

## Task 3: agentToolbarSlice (state)

**Files:**
- Create: `src/renderer/stores/slices/agentToolbarSlice.ts`
- Test: `src/renderer/stores/slices/__tests__/agentToolbarSlice.test.ts`
- Modify: `src/renderer/stores/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/stores/slices/__tests__/agentToolbarSlice.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';

describe('agentToolbarSlice', () => {
  beforeEach(() => {
    useStore.setState({
      agentToolbarEnabled: true,
      toolbarSnippets: [],
      richDraftByPane: {},
      toolbarPopover: null,
      newConversationCommand: '/clear',
    });
  });

  it('toggles enabled', () => {
    useStore.getState().setAgentToolbarEnabled(false);
    expect(useStore.getState().agentToolbarEnabled).toBe(false);
  });

  it('adds, updates, removes snippets', () => {
    useStore.getState().addSnippet('Tests', 'write tests for this');
    let snips = useStore.getState().toolbarSnippets;
    expect(snips).toHaveLength(1);
    const id = snips[0].id;
    expect(snips[0]).toMatchObject({ label: 'Tests', text: 'write tests for this' });

    useStore.getState().updateSnippet(id, { text: 'updated' });
    expect(useStore.getState().toolbarSnippets[0].text).toBe('updated');

    useStore.getState().removeSnippet(id);
    expect(useStore.getState().toolbarSnippets).toHaveLength(0);
  });

  it('sets and clears per-pane rich drafts', () => {
    useStore.getState().setRichDraft('pty-1', 'hello');
    expect(useStore.getState().richDraftByPane['pty-1']).toBe('hello');
    useStore.getState().clearRichDraft('pty-1');
    expect(useStore.getState().richDraftByPane['pty-1']).toBeUndefined();
  });

  it('sets popover and new-conversation command', () => {
    useStore.getState().setToolbarPopover('rich');
    expect(useStore.getState().toolbarPopover).toBe('rich');
    useStore.getState().setNewConversationCommand('/reset');
    expect(useStore.getState().newConversationCommand).toBe('/reset');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/stores/slices/__tests__/agentToolbarSlice.test.ts`
Expected: FAIL — `setAgentToolbarEnabled is not a function` (slice not wired).

- [ ] **Step 3: Write the slice**

```ts
// src/renderer/stores/slices/agentToolbarSlice.ts
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { generateId } from '../../../shared/types';

export interface ToolbarSnippet {
  id: string;
  label: string;
  text: string;
}

export type ToolbarPopover = 'explorer' | 'snippets' | 'rich' | null;

export interface AgentToolbarSlice {
  /** Whether the bottom toolbar mounts. Persisted (default true). */
  agentToolbarEnabled: boolean;
  setAgentToolbarEnabled: (enabled: boolean) => void;

  /** User-saved reusable prompts. Persisted (user-authored). */
  toolbarSnippets: ToolbarSnippet[];
  addSnippet: (label: string, text: string) => void;
  updateSnippet: (id: string, patch: Partial<Pick<ToolbarSnippet, 'label' | 'text'>>) => void;
  removeSnippet: (id: string) => void;

  /** Rich-input draft per pane (ptyId → text). IN-MEMORY ONLY — never persisted. */
  richDraftByPane: Record<string, string>;
  setRichDraft: (ptyId: string, text: string) => void;
  clearRichDraft: (ptyId: string) => void;

  /** Which toolbar popover is open. Transient. */
  toolbarPopover: ToolbarPopover;
  setToolbarPopover: (popover: ToolbarPopover) => void;

  /** Command sent by the "New" button. Persisted (default '/clear'). */
  newConversationCommand: string;
  setNewConversationCommand: (cmd: string) => void;
}

export const createAgentToolbarSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  AgentToolbarSlice
> = (set) => ({
  agentToolbarEnabled: true,
  setAgentToolbarEnabled: (enabled) => set((draft: StoreState) => {
    draft.agentToolbarEnabled = enabled;
  }),

  toolbarSnippets: [],
  addSnippet: (label, text) => set((draft: StoreState) => {
    draft.toolbarSnippets.push({ id: generateId('snippet'), label, text });
  }),
  updateSnippet: (id, patch) => set((draft: StoreState) => {
    const s = draft.toolbarSnippets.find((x) => x.id === id);
    if (!s) return;
    if (patch.label !== undefined) s.label = patch.label;
    if (patch.text !== undefined) s.text = patch.text;
  }),
  removeSnippet: (id) => set((draft: StoreState) => {
    draft.toolbarSnippets = draft.toolbarSnippets.filter((x) => x.id !== id);
  }),

  richDraftByPane: {},
  setRichDraft: (ptyId, text) => set((draft: StoreState) => {
    draft.richDraftByPane[ptyId] = text;
  }),
  clearRichDraft: (ptyId) => set((draft: StoreState) => {
    if (draft.richDraftByPane[ptyId] !== undefined) delete draft.richDraftByPane[ptyId];
  }),

  toolbarPopover: null,
  setToolbarPopover: (popover) => set((draft: StoreState) => {
    draft.toolbarPopover = popover;
  }),

  newConversationCommand: '/clear',
  setNewConversationCommand: (cmd) => set((draft: StoreState) => {
    draft.newConversationCommand = cmd;
  }),
});
```

- [ ] **Step 4: Wire the slice into the store**

In `src/renderer/stores/index.ts`:

Add the import after the `createResumeSlice` import (line 14):
```ts
import { createAgentToolbarSlice, type AgentToolbarSlice } from './slices/agentToolbarSlice';
```

Add `& AgentToolbarSlice` to the end of the `StoreState` type (line 16):
```ts
export type StoreState = WorkspaceSlice & PaneSlice & SurfaceSlice & UISlice & NotificationSlice & A2aSlice & CompanySlice & ToastSlice & SearchSlice & ProjectConfigSlice & SupervisionSlice & ResumeSlice & AgentToolbarSlice;
```

Add the spread after `...createResumeSlice(...args),` (line 31):
```ts
    ...createAgentToolbarSlice(...args),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/stores/slices/__tests__/agentToolbarSlice.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/stores/slices/agentToolbarSlice.ts src/renderer/stores/slices/__tests__/agentToolbarSlice.test.ts src/renderer/stores/index.ts
git commit -m "feat(toolbar): agentToolbarSlice state"
```

---

## Task 4: Main IPC — git status + file picker

**Files:**
- Modify: `src/shared/constants.ts`
- Create: `src/main/ipc/handlers/toolbar.handler.ts`
- Modify: `src/main/ipc/registerHandlers.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/shared/electron.d.ts`

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/constants.ts`, inside the `IPC` object near `FS_READ_DIR: 'fs:read-dir',` (line 80), add:
```ts
  GIT_STATUS: 'git:status',
  DIALOG_PICK_FILE: 'dialog:pick-file',
```

- [ ] **Step 2: Create the handler**

```ts
// src/main/ipc/handlers/toolbar.handler.ts
import { ipcMain, dialog } from 'electron';
import { execFile } from 'node:child_process';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { resolveAccessiblePath } from './fs.handler';

/** Run `git status --porcelain` in `cwd`. Returns raw stdout, '' on any error
 *  (not a repo, git missing, blocked path). Renderer parses with
 *  shared/gitStatus.parsePorcelain. */
function gitStatusPorcelain(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'status', '--porcelain'],
      { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout),
    );
  });
}

export function registerToolbarHandlers(): () => void {
  ipcMain.removeHandler(IPC.GIT_STATUS);
  ipcMain.handle(IPC.GIT_STATUS, wrapHandler(IPC.GIT_STATUS, async (_event, cwd: string): Promise<string> => {
    const resolved = await resolveAccessiblePath(cwd);
    if (!resolved) return '';
    return gitStatusPorcelain(resolved);
  }));

  ipcMain.removeHandler(IPC.DIALOG_PICK_FILE);
  ipcMain.handle(IPC.DIALOG_PICK_FILE, wrapHandler(IPC.DIALOG_PICK_FILE, async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return result.filePaths;
  }));

  return () => {
    ipcMain.removeHandler(IPC.GIT_STATUS);
    ipcMain.removeHandler(IPC.DIALOG_PICK_FILE);
  };
}
```

- [ ] **Step 3: Register the handler**

In `src/main/ipc/registerHandlers.ts`, mirror the `registerFsHandlers` wiring. Add the import next to the fs import (line 21):
```ts
import { registerToolbarHandlers } from './handlers/toolbar.handler';
```
Add the call next to `const cleanupFs = registerFsHandlers();` (line 58):
```ts
  const cleanupToolbar = registerToolbarHandlers();
```
Add `cleanupToolbar();` to the returned cleanup function alongside `cleanupFs();` (find the `return () => { ... }` block in the same file and add the call there).

- [ ] **Step 4: Expose via preload**

In `src/preload/preload.ts`, after the `fs: { ... },` namespace (ends line 225), add:
```ts
  git: {
    status: (cwd: string) => ipcRenderer.invoke(IPC.GIT_STATUS, cwd) as Promise<string>,
  },
  dialog: {
    pickFile: () => ipcRenderer.invoke(IPC.DIALOG_PICK_FILE) as Promise<string[]>,
  },
```

- [ ] **Step 5: Type the new namespaces**

In `src/shared/electron.d.ts`, find the `electronAPI` interface and add (alongside the existing `fs` namespace):
```ts
    git: {
      status: (cwd: string) => Promise<string>;
    };
    dialog: {
      pickFile: () => Promise<string[]>;
    };
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors related to `git`, `dialog`, `GIT_STATUS`, `DIALOG_PICK_FILE`.

- [ ] **Step 7: Commit**

```bash
git add src/shared/constants.ts src/main/ipc/handlers/toolbar.handler.ts src/main/ipc/registerHandlers.ts src/preload/preload.ts src/shared/electron.d.ts
git commit -m "feat(toolbar): main IPC for git status + file picker"
```

---

## Task 5: Persist toolbar prefs in SessionData

Persists `agentToolbarEnabled`, `toolbarSnippets`, `newConversationCommand`. Drafts and popover state are deliberately NOT persisted.

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/components/Layout/AppLayout.tsx` (`buildSessionData`)
- Modify: `src/renderer/stores/slices/workspaceSlice.ts` (`loadSession`)
- Test: `src/renderer/stores/slices/__tests__/workspaceSlice.loadSession.test.ts` (existing file — add a case)

- [ ] **Step 1: Extend the SessionData type**

In `src/shared/types.ts`, inside `interface SessionData` (before the closing brace at line 434), add:
```ts
  // Agent toolbar (2026-06-14). Non-sensitive prefs only — rich-input drafts
  // and transcript content are never persisted.
  agentToolbarEnabled?: boolean;
  agentToolbarSnippets?: { id: string; label: string; text: string }[];
  agentToolbarNewCommand?: string;
```

- [ ] **Step 2: Write the failing test**

Add to `src/renderer/stores/slices/__tests__/workspaceSlice.loadSession.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { useStore } from '../../index';

describe('loadSession — agent toolbar prefs', () => {
  it('restores enabled, snippets, and new command', () => {
    useStore.getState().loadSession({
      workspaces: [],
      activeWorkspaceId: '',
      sidebarVisible: true,
      agentToolbarEnabled: false,
      agentToolbarSnippets: [{ id: 's1', label: 'A', text: 'aaa' }],
      agentToolbarNewCommand: '/reset',
    } as any);
    expect(useStore.getState().agentToolbarEnabled).toBe(false);
    expect(useStore.getState().toolbarSnippets).toEqual([{ id: 's1', label: 'A', text: 'aaa' }]);
    expect(useStore.getState().newConversationCommand).toBe('/reset');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/renderer/stores/slices/__tests__/workspaceSlice.loadSession.test.ts -t "agent toolbar prefs"`
Expected: FAIL — `agentToolbarEnabled` stays at its default `true`.

- [ ] **Step 4: Read prefs in loadSession**

In `src/renderer/stores/slices/workspaceSlice.ts`, near the other `if (data.X != null) state.X = data.X;` reads (around line 409–411), add:
```ts
      if (data.agentToolbarEnabled != null) state.agentToolbarEnabled = data.agentToolbarEnabled;
      if (data.agentToolbarSnippets != null) state.toolbarSnippets = data.agentToolbarSnippets;
      if (data.agentToolbarNewCommand != null) state.newConversationCommand = data.agentToolbarNewCommand;
```

- [ ] **Step 5: Write prefs in buildSessionData**

In `src/renderer/components/Layout/AppLayout.tsx`, inside the object returned by `buildSessionData` (before the closing `};` at line 232), add:
```ts
    agentToolbarEnabled: state.agentToolbarEnabled,
    agentToolbarSnippets: state.toolbarSnippets.length > 0 ? state.toolbarSnippets : undefined,
    agentToolbarNewCommand: state.newConversationCommand,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/renderer/stores/slices/__tests__/workspaceSlice.loadSession.test.ts -t "agent toolbar prefs"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/renderer/components/Layout/AppLayout.tsx src/renderer/stores/slices/workspaceSlice.ts src/renderer/stores/slices/__tests__/workspaceSlice.loadSession.test.ts
git commit -m "feat(toolbar): persist non-sensitive toolbar prefs"
```

---

## Task 6: PTY-inject helper

Shared helper used by every inject action. Reads bracketed-paste mode from the live xterm terminal (via `terminalRegistry`) and routes through `pastePtyChunked`.

**Files:**
- Create: `src/renderer/components/AgentToolbar/inject.ts`
- Test: `src/renderer/components/AgentToolbar/__tests__/inject.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/components/AgentToolbar/__tests__/inject.test.ts
import { describe, it, expect, vi } from 'vitest';
import { quotePathsForPrompt, buildSubmitWrites } from '../inject';

describe('quotePathsForPrompt', () => {
  it('quotes paths with spaces and joins with a single space', () => {
    expect(quotePathsForPrompt(['/a/b.png', '/c d/e.ts'])).toBe('/a/b.png "/c d/e.ts"');
  });
  it('returns empty string for no paths', () => {
    expect(quotePathsForPrompt([])).toBe('');
  });
});

describe('buildSubmitWrites', () => {
  it('returns the text then a lone CR when submit=true', () => {
    expect(buildSubmitWrites('hello', true)).toEqual(['hello', '\r']);
  });
  it('returns just the text when submit=false', () => {
    expect(buildSubmitWrites('hello', false)).toEqual(['hello']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/components/AgentToolbar/__tests__/inject.test.ts`
Expected: FAIL — cannot find module `../inject`.

- [ ] **Step 3: Write the helper**

```ts
// src/renderer/components/AgentToolbar/inject.ts
import { terminalRegistry } from '../../hooks/useTerminal';
import { pastePtyChunked, type TerminalModesLike } from '../../utils/clipboardChunk';

/** Quote any path containing a space; join with a single space. */
export function quotePathsForPrompt(paths: string[]): string {
  return paths.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
}

/** The ordered raw writes for a submit/no-submit inject. Pure, for testing. */
export function buildSubmitWrites(text: string, submit: boolean): string[] {
  return submit ? [text, '\r'] : [text];
}

/** Read the live terminal's bracketed-paste mode for this ptyId. */
function modesFor(ptyId: string): TerminalModesLike | null {
  const terminal = terminalRegistry.get(ptyId);
  const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } })?.modes;
  return modes ?? null;
}

/**
 * Inject text into the pane's PTY through the chunked paste path (bracketed-
 * paste safe, newline-normalized). When `submit` is true, follow with a single
 * CR to send it as one message.
 */
export async function injectText(ptyId: string, text: string, submit: boolean): Promise<void> {
  if (!ptyId || !text) return;
  const write = (d: string) => window.electronAPI.pty.write(ptyId, d);
  await pastePtyChunked(write, text, modesFor(ptyId));
  if (submit) write('\r');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/components/AgentToolbar/__tests__/inject.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/AgentToolbar/inject.ts src/renderer/components/AgentToolbar/__tests__/inject.test.ts
git commit -m "feat(toolbar): PTY-inject helper"
```

---

## Task 7: AgentToolbar shell + mount + settings toggle

Mounts the bar (Attach + New wired; popovers stubbed), gated by `agentToolbarEnabled`, and adds the settings toggle.

**Files:**
- Create: `src/renderer/components/AgentToolbar/AgentToolbar.tsx`
- Modify: `src/renderer/components/Layout/AppLayout.tsx`
- Modify: `src/renderer/components/Settings/SettingsPanel.tsx`
- Modify: `src/renderer/i18n/locales/en.ts`, `src/renderer/i18n/locales/ko.ts`

- [ ] **Step 1: Add i18n strings**

In `src/renderer/i18n/locales/en.ts`, add these keys (match the file's existing object structure — flat dotted keys):
```ts
  'toolbar.attach': 'Attach',
  'toolbar.fileExplorer': 'File explorer',
  'toolbar.snippets': 'Snippets',
  'toolbar.richInput': 'Rich Input',
  'toolbar.new': 'New',
  'toolbar.send': 'Send',
  'toolbar.richPlaceholder': 'Write or paste a prompt. Enter for newline. Send pastes it into the agent.',
  'toolbar.noTerminal': 'No terminal focused',
  'toolbar.addSnippet': 'Add snippet',
  'toolbar.snippetLabel': 'Label',
  'toolbar.snippetText': 'Prompt text',
  'settings.agentToolbar': 'Agent toolbar',
  'settings.agentToolbarShow': 'Show agent toolbar',
  'settings.agentToolbarShowDesc': 'A bottom bar of quick tools that inject into the focused agent.',
  'settings.agentToolbarNewCommand': 'New-conversation command',
  'settings.agentToolbarManageSnippets': 'Manage snippets',
```

In `src/renderer/i18n/locales/ko.ts`, add the same keys with Korean values (or copy the English values as placeholders if unsure — the keys must exist so `useT` does not warn):
```ts
  'toolbar.attach': '첨부',
  'toolbar.fileExplorer': '파일 탐색기',
  'toolbar.snippets': '스니펫',
  'toolbar.richInput': '리치 입력',
  'toolbar.new': '새로',
  'toolbar.send': '보내기',
  'toolbar.richPlaceholder': '프롬프트를 입력하거나 붙여넣으세요. Enter는 줄바꿈입니다. Send를 누르면 에이전트에 붙여넣습니다.',
  'toolbar.noTerminal': '포커스된 터미널 없음',
  'toolbar.addSnippet': '스니펫 추가',
  'toolbar.snippetLabel': '레이블',
  'toolbar.snippetText': '프롬프트 텍스트',
  'settings.agentToolbar': '에이전트 도구 모음',
  'settings.agentToolbarShow': '에이전트 도구 모음 표시',
  'settings.agentToolbarShowDesc': '포커스된 에이전트에 입력을 주입하는 하단 도구 모음입니다.',
  'settings.agentToolbarNewCommand': '새 대화 명령',
  'settings.agentToolbarManageSnippets': '스니펫 관리',
```

- [ ] **Step 2: Create the toolbar component (Attach + New live; popover buttons toggle state)**

```tsx
// src/renderer/components/AgentToolbar/AgentToolbar.tsx
import { useCallback } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { focusedTerminalPtyId } from '../../utils/focusedSurface';
import { injectText, quotePathsForPrompt } from './inject';
import RichInput from './RichInput';
import SnippetsMenu from './SnippetsMenu';
import FileExplorerPopover from './FileExplorerPopover';

export default function AgentToolbar() {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const popover = useStore((s) => s.toolbarPopover);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const newCommand = useStore((s) => s.newConversationCommand);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const ptyId = focusedTerminalPtyId(activeWorkspace);
  const disabled = !ptyId;

  const handleAttach = useCallback(async () => {
    if (!ptyId) return;
    const paths = await window.electronAPI.dialog.pickFile();
    if (paths.length === 0) return;
    await injectText(ptyId, quotePathsForPrompt(paths), false);
  }, [ptyId]);

  const handleNew = useCallback(() => {
    if (!ptyId) return;
    void injectText(ptyId, newCommand, true);
  }, [ptyId, newCommand]);

  const togglePopover = (name: 'explorer' | 'snippets' | 'rich') =>
    setPopover(popover === name ? null : name);

  const btn = 'px-2.5 py-1 rounded border text-[11px] font-mono transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const idle = 'bg-[var(--bg-surface)] border-[var(--bg-overlay)] text-[var(--text-sub)] hover:text-[var(--text-main)]';
  const active = 'bg-[var(--bg-overlay)] border-[var(--accent-blue)] text-[var(--accent-blue)]';

  return (
    <div
      className="relative flex items-center gap-2 px-2.5 py-1.5 shrink-0 border-t border-[var(--bg-surface)] bg-[var(--bg-mantle)]"
      data-testid="agent-toolbar"
    >
      <button className={`${btn} ${idle}`} disabled={disabled} onClick={handleAttach} title={t('toolbar.attach')}>
        ＋ {t('toolbar.attach')}
      </button>
      <button className={`${btn} ${popover === 'explorer' ? active : idle}`} onClick={() => togglePopover('explorer')}>
        📁 {t('toolbar.fileExplorer')}
      </button>
      <button className={`${btn} ${popover === 'snippets' ? active : idle}`} disabled={disabled} onClick={() => togglePopover('snippets')}>
        ★ {t('toolbar.snippets')}
      </button>
      <button className={`${btn} ${popover === 'rich' ? active : idle}`} disabled={disabled} onClick={() => togglePopover('rich')}>
        ⌨ {t('toolbar.richInput')} <span className="opacity-50">Ctrl G</span>
      </button>
      <div className="flex-1" />
      {disabled && <span className="text-[10px] text-[var(--text-muted)] font-mono">{t('toolbar.noTerminal')}</span>}
      <button className={`${btn} ${idle}`} disabled={disabled} onClick={handleNew} title={t('toolbar.new')}>
        ⊕ {t('toolbar.new')}
      </button>

      {popover === 'explorer' && <FileExplorerPopover />}
      {popover === 'snippets' && ptyId && <SnippetsMenu ptyId={ptyId} />}
      {popover === 'rich' && ptyId && <RichInput ptyId={ptyId} />}
    </div>
  );
}
```

- [ ] **Step 3: Create placeholder popover components (replaced in later tasks)**

```tsx
// src/renderer/components/AgentToolbar/RichInput.tsx
export default function RichInput(_props: { ptyId: string }) {
  return null;
}
```
```tsx
// src/renderer/components/AgentToolbar/SnippetsMenu.tsx
export default function SnippetsMenu(_props: { ptyId: string }) {
  return null;
}
```
```tsx
// src/renderer/components/AgentToolbar/FileExplorerPopover.tsx
export default function FileExplorerPopover() {
  return null;
}
```

- [ ] **Step 4: Mount in AppLayout**

In `src/renderer/components/Layout/AppLayout.tsx`:

Add the import after the `StatusBar` import (line 8):
```ts
import AgentToolbar from '../AgentToolbar/AgentToolbar';
```
Add a subscription near the other `useStore` reads in `AppLayout` (e.g. after line 247's `clearAllPtyState`):
```ts
  const agentToolbarEnabled = useStore((s) => s.agentToolbarEnabled);
```
Mount the bar as the LAST child of the main column `div` — immediately before the `</div>` that closes `<div className="flex-1 min-w-0 flex flex-col">` (the closing tag at line 1138, right after the pane-area conditional block):
```tsx
        {agentToolbarEnabled && (
          <ErrorBoundary name="AgentToolbar">
            <AgentToolbar />
          </ErrorBoundary>
        )}
```

- [ ] **Step 5: Add the settings toggle**

In `src/renderer/components/Settings/SettingsPanel.tsx`, find the General-section block that renders the `notificationSoundEnabled` toggle and add an "Agent toolbar" group nearby. Use the same row markup the file already uses for boolean settings; the wiring is:
```tsx
{/* Agent toolbar */}
<SectionLabel label={t('settings.agentToolbar')} />
<div className="flex items-center justify-between py-2">
  <div>
    <p className="text-sm text-[color:var(--text-main)]">{t('settings.agentToolbarShow')}</p>
    <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5">{t('settings.agentToolbarShowDesc')}</p>
  </div>
  <input
    type="checkbox"
    checked={useStore.getState().agentToolbarEnabled}
    onChange={(e) => useStore.getState().setAgentToolbarEnabled(e.target.checked)}
  />
</div>
<div className="flex items-center justify-between py-2">
  <p className="text-sm text-[color:var(--text-main)]">{t('settings.agentToolbarNewCommand')}</p>
  <input
    type="text"
    defaultValue={useStore.getState().newConversationCommand}
    onBlur={(e) => useStore.getState().setNewConversationCommand(e.target.value)}
    className="bg-[var(--bg-base)] border border-[var(--bg-surface)] rounded px-2 py-1 text-xs font-mono"
  />
</div>
```
NOTE: match the actual reactive pattern used by neighbouring toggles in this file (most read the value via `useStore((s) => s.X)` at the top of the component rather than `getState()` inline). If the surrounding toggles use a hook subscription, add `const agentToolbarEnabled = useStore((s) => s.agentToolbarEnabled);` etc. at the top and bind `checked={agentToolbarEnabled}` to stay reactive.

- [ ] **Step 6: Typecheck + manual verification**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

Run the app (`npm run dev` or the project's run skill). Verify:
- A bottom bar appears with ＋ Attach · 📁 File explorer · ★ Snippets · ⌨ Rich Input · ⊕ New.
- Focus a Claude/shell pane: ＋ Attach opens an OS picker; choosing a file inserts its path into the prompt; choosing a PNG inserts a path the agent treats as an image.
- ⊕ New types `/clear` + Enter into the focused pane.
- Settings → General → Agent toolbar toggle hides/shows the bar; layout returns to normal when off.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/AgentToolbar/ src/renderer/components/Layout/AppLayout.tsx src/renderer/components/Settings/SettingsPanel.tsx src/renderer/i18n/locales/en.ts src/renderer/i18n/locales/ko.ts
git commit -m "feat(toolbar): bottom bar shell with Attach + New and settings toggle"
```

---

## Task 8: Snippets menu

**Files:**
- Modify: `src/renderer/components/AgentToolbar/SnippetsMenu.tsx`

- [ ] **Step 1: Implement the menu**

```tsx
// src/renderer/components/AgentToolbar/SnippetsMenu.tsx
import { useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { injectText } from './inject';

export default function SnippetsMenu({ ptyId }: { ptyId: string }) {
  const t = useT();
  const snippets = useStore((s) => s.toolbarSnippets);
  const addSnippet = useStore((s) => s.addSnippet);
  const removeSnippet = useStore((s) => s.removeSnippet);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');

  const insert = (body: string) => {
    void injectText(ptyId, body, false);
    setPopover(null);
  };

  return (
    <div
      className="absolute bottom-full left-2 mb-1 w-72 rounded-lg border border-[var(--accent-blue)] bg-[var(--bg-mantle)] shadow-xl z-50 p-2 font-mono text-xs"
      data-testid="snippets-menu"
    >
      <div className="max-h-48 overflow-y-auto">
        {snippets.length === 0 && (
          <p className="text-[var(--text-muted)] px-1 py-2">{t('toolbar.snippets')} —</p>
        )}
        {snippets.map((s) => (
          <div key={s.id} className="flex items-center gap-1 group">
            <button
              className="flex-1 text-left px-2 py-1 rounded hover:bg-[var(--bg-surface)] text-[var(--text-sub)] hover:text-[var(--text-main)] truncate"
              title={s.text}
              onClick={() => insert(s.text)}
            >
              {s.label}
            </button>
            <button
              className="px-1 text-[var(--text-muted)] hover:text-[var(--accent-red)] opacity-0 group-hover:opacity-100"
              title="✕"
              onClick={() => removeSnippet(s.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--bg-surface)] mt-2 pt-2 flex flex-col gap-1">
        <input
          className="bg-[var(--bg-base)] border border-[var(--bg-surface)] rounded px-2 py-1"
          placeholder={t('toolbar.snippetLabel')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <textarea
          className="bg-[var(--bg-base)] border border-[var(--bg-surface)] rounded px-2 py-1 resize-none h-14"
          placeholder={t('toolbar.snippetText')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="self-end px-3 py-1 rounded bg-[var(--accent-blue)] text-[var(--bg-base)] disabled:opacity-40"
          disabled={!label.trim() || !text.trim()}
          onClick={() => { addSnippet(label.trim(), text.trim()); setLabel(''); setText(''); }}
        >
          {t('toolbar.addSnippet')}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + manual verification**

Run: `npx tsc -p tsconfig.json --noEmit` → no errors.
In-app: open ★ Snippets, add a snippet, click it → text inserts into the prompt (no submit); reload the app → snippet persists; ✕ removes it.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/AgentToolbar/SnippetsMenu.tsx
git commit -m "feat(toolbar): snippets menu with persistence"
```

---

## Task 9: Rich Input scratchpad + Ctrl+G

**Files:**
- Modify: `src/renderer/components/AgentToolbar/RichInput.tsx`
- Modify: `src/renderer/components/AgentToolbar/AgentToolbar.tsx` (Ctrl+G listener)

- [ ] **Step 1: Implement the scratchpad**

```tsx
// src/renderer/components/AgentToolbar/RichInput.tsx
import { useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { injectText } from './inject';

export default function RichInput({ ptyId }: { ptyId: string }) {
  const t = useT();
  const draft = useStore((s) => s.richDraftByPane[ptyId] ?? '');
  const setRichDraft = useStore((s) => s.setRichDraft);
  const clearRichDraft = useStore((s) => s.clearRichDraft);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  const send = async () => {
    const text = useStore.getState().richDraftByPane[ptyId] ?? '';
    if (!text.trim()) return;
    await injectText(ptyId, text, true);
    clearRichDraft(ptyId);
    setPopover(null);
  };

  return (
    <div
      className="absolute bottom-full right-2 mb-1 w-96 rounded-lg border border-[var(--accent-blue)] bg-[var(--bg-mantle)] shadow-xl z-50 p-2 font-mono text-xs"
      data-testid="rich-input"
    >
      <textarea
        ref={ref}
        className="w-full h-32 bg-[var(--bg-base)] border border-[var(--bg-surface)] rounded px-2 py-1.5 resize-none outline-none text-[var(--text-main)]"
        placeholder={t('toolbar.richPlaceholder')}
        value={draft}
        onChange={(e) => setRichDraft(ptyId, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); setPopover(null); }
          // Enter inserts a newline (default textarea behavior) — no special-casing.
        }}
      />
      <div className="flex items-center justify-end gap-2 mt-1.5">
        <button
          className="px-3 py-1 rounded bg-[var(--accent-blue)] text-[var(--bg-base)] disabled:opacity-40"
          disabled={!draft.trim()}
          onClick={send}
        >
          {t('toolbar.send')} ▸
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the Ctrl+G shortcut**

In `src/renderer/components/AgentToolbar/AgentToolbar.tsx`, add a `useEffect` (import `useEffect`) that toggles the rich popover, gated on a focused terminal:
```tsx
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
        if (!focusedTerminalPtyId(useStore.getState().workspaces.find(
          (w) => w.id === useStore.getState().activeWorkspaceId))) return;
        e.preventDefault();
        const cur = useStore.getState().toolbarPopover;
        setPopover(cur === 'rich' ? null : 'rich');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setPopover]);
```

- [ ] **Step 3: Typecheck + manual verification**

Run: `npx tsc -p tsconfig.json --noEmit` → no errors.
In-app: Ctrl+G opens Rich Input; type multiple lines (Enter adds newlines); Send pastes all of it into the agent prompt and submits as one message; reopen Rich Input after closing without sending → the draft is still there; switching panes shows a separate draft.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/AgentToolbar/RichInput.tsx src/renderer/components/AgentToolbar/AgentToolbar.tsx
git commit -m "feat(toolbar): rich-input scratchpad with per-pane draft + Ctrl+G"
```

---

## Task 10: File explorer popover with git badges

Reuses the existing `electronAPI.fs.readDir` and `addEditorSurface` (open-on-click), overlaid with git-status badges from the new `git:status` IPC parsed by `parsePorcelain`.

**Files:**
- Modify: `src/renderer/components/AgentToolbar/FileExplorerPopover.tsx`

- [ ] **Step 1: Implement the popover**

```tsx
// src/renderer/components/AgentToolbar/FileExplorerPopover.tsx
import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../stores';
import { parsePorcelain, type GitStatusCode } from '../../../shared/gitStatus';
import { findActiveLeaf } from '../../utils/focusedSurface';

interface Entry { name: string; path: string; isDirectory: boolean; isSymlink: boolean; }

const BADGE_COLOR: Record<GitStatusCode, string> = {
  M: 'var(--accent-yellow)',
  A: 'var(--accent-blue)',
  U: 'var(--accent-green)',
  D: 'var(--accent-red)',
  R: 'var(--accent-blue)',
};

function workspaceCwd(): { cwd: string | undefined; activePaneId: string | undefined } {
  const state = useStore.getState();
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return { cwd: undefined, activePaneId: undefined };
  let cwd = ws.metadata?.cwd;
  if (!cwd) {
    const leaf = findActiveLeaf(ws);
    cwd = leaf?.surfaces.find((s) => s.id === leaf.activeSurfaceId)?.cwd || undefined;
  }
  return { cwd, activePaneId: ws.activePaneId };
}

export default function FileExplorerPopover() {
  const addEditorSurface = useStore((s) => s.addEditorSurface);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [statusByRel, setStatusByRel] = useState<Record<string, GitStatusCode>>({});
  const { cwd, activePaneId } = workspaceCwd();

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    void window.electronAPI.fs.readDir(cwd).then((list: Entry[]) => {
      if (!cancelled) setEntries(list);
    });
    void window.electronAPI.git.status(cwd).then((out) => {
      if (cancelled) return;
      const map: Record<string, GitStatusCode> = {};
      for (const { path, code } of parsePorcelain(out)) {
        // porcelain paths are forward-slash and repo-relative; key by basename
        // match against the top-level listing (good enough for the flat view).
        map[path.replace(/\\/g, '/')] = code;
      }
      setStatusByRel(map);
    });
    return () => { cancelled = true; };
  }, [cwd]);

  const badgeFor = useCallback((name: string): GitStatusCode | undefined => {
    // Match either an exact top-level file or any nested path under a dir name.
    if (statusByRel[name]) return statusByRel[name];
    for (const rel of Object.keys(statusByRel)) {
      if (rel === name || rel.startsWith(name + '/')) return statusByRel[rel];
    }
    return undefined;
  }, [statusByRel]);

  const openFile = (path: string) => {
    if (activePaneId) addEditorSurface(activePaneId, path);
    setPopover(null);
  };

  return (
    <div
      className="absolute bottom-full left-24 mb-1 w-80 max-h-80 overflow-y-auto rounded-lg border border-[var(--accent-blue)] bg-[var(--bg-mantle)] shadow-xl z-50 p-1 font-mono text-xs"
      data-testid="file-explorer"
    >
      {!cwd && <p className="text-[var(--text-muted)] px-2 py-2">No working directory.</p>}
      {entries.map((e) => {
        const badge = e.isDirectory ? undefined : badgeFor(e.name);
        return (
          <button
            key={e.path}
            className="flex items-center w-full text-left px-2 py-0.5 rounded hover:bg-[var(--bg-surface)] text-[var(--text-sub)] hover:text-[var(--text-main)]"
            onClick={() => (e.isDirectory ? undefined : openFile(e.path))}
            disabled={e.isDirectory}
            title={e.path}
          >
            <span className="mr-1.5">{e.isDirectory ? '📁' : '📄'}</span>
            <span className="truncate flex-1">{e.name}</span>
            {badge && (
              <span className="ml-2 font-bold" style={{ color: BADGE_COLOR[badge] }}>{badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

NOTE on CSS vars: confirm `--accent-yellow`, `--accent-green`, `--accent-red`, `--accent-blue` exist in the theme tokens (`src/renderer/themes`). If a token name differs, substitute the actual token. Badges must convey state by **letter + color**, never color alone (a11y) — the letter is always rendered.

- [ ] **Step 2: Typecheck + manual verification**

Run: `npx tsc -p tsconfig.json --noEmit` → no errors.
In-app, in a git repo workspace: open 📁 File explorer → top-level entries render; modified/added/untracked files show M/A/U badges in the right colors; clicking a file opens it in an editor tab (does not insert a path); clicking ＋ Attach still inserts a path. (v1 shows a flat top-level listing with badges; nested expansion is out of scope per spec.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/AgentToolbar/FileExplorerPopover.tsx
git commit -m "feat(toolbar): file explorer popover with git status badges"
```

---

## Task 11: Full suite + typecheck + branch verification

- [ ] **Step 1: Run the toolbar tests together**

Run:
```bash
npx vitest run src/shared/__tests__/gitStatus.test.ts src/renderer/utils/__tests__/focusedSurface.test.ts src/renderer/stores/slices/__tests__/agentToolbarSlice.test.ts src/renderer/components/AgentToolbar/__tests__/inject.test.ts src/renderer/stores/slices/__tests__/workspaceSlice.loadSession.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Full typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: green. NOTE: the daemon save-debounce tests (`crashRestore.integration`, `saveDebounced`) are a known parallel-load timing flake — green in isolation. If only those fail, re-run them alone to confirm; do not treat as a regression.

- [ ] **Step 4: Final manual smoke (acceptance criteria)**

Verify against the spec's acceptance table: toggle off restores today's layout; Attach inserts paths incl. PNG; File explorer shows correct badges and opens (not attaches) on click; Snippets persist and insert; Rich Input newline/Send/draft behavior; New sends the command; inject buttons disabled when a non-terminal surface is focused; no prompt bodies written to `session.json` (inspect the saved file — `richDraftByPane` must be absent).

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "test(toolbar): full suite green + typecheck"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** placement (Task 7), inject mechanism (Task 6), Attach (7), File explorer + badges + open-on-click (10), Snippets (8), Rich Input A/B/C (9), New (7), settings toggle (7), persistence incl. drafts-not-persisted (5), i18n (7), a11y badge letter+color (10). All spec sections map to a task.
- **Type consistency:** slice exposes `agentToolbarEnabled`, `toolbarSnippets`, `richDraftByPane`, `toolbarPopover`, `newConversationCommand`, and actions `setAgentToolbarEnabled/addSnippet/updateSnippet/removeSnippet/setRichDraft/clearRichDraft/setToolbarPopover/setNewConversationCommand` — used identically in Tasks 5, 7, 8, 9, 10. `focusedTerminalPtyId`/`findActiveLeaf` (Task 2) reused in Tasks 7 and 10. `parsePorcelain`/`GitStatusCode` (Task 1) reused in Task 10. `injectText`/`quotePathsForPrompt` (Task 6) reused in Tasks 7, 8, 9.
- **Known soft spots to confirm during implementation:** exact line numbers drift — search by the quoted anchor strings, not the line numbers. Confirm theme token names in Task 10. Match the neighbouring reactive pattern for the Task 7 settings rows.
