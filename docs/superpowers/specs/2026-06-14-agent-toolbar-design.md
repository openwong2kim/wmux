# Agent Toolbar — Design Spec

**Date:** 2026-06-14
**Status:** Approved for planning
**Author:** Mattia (brainstormed with Claude Code)

## Summary

A new **bottom toolbar** in wmux that gives a developer working with an AI agent
(Claude Code, Codex, etc.) a row of quick-action tools sitting *underneath* the
pane area — close to where the agent's own prompt lives. Every tool works by
**injecting text or keys into the focused pane's PTY**, reusing the exact
plumbing wmux already uses for the resume pill and file-drop. No AI transport, no
credentials, no new public RPC.

The toolbar ships with five tools: **＋ Attach**, **📁 File explorer**,
**★ Snippets**, **⌨ Rich Input**, and **⊕ New**. A General-settings toggle shows
or hides it (default on).

## Goals

- Keep useful agent/terminal actions one click away, pinned at the bottom of the
  work area rather than buried in a modal or the top status bar.
- Reuse existing wmux plumbing (`pty.write`, `pastePtyChunked`, `FileTreePanel`,
  `EditorPanel`, the `.git` watcher) instead of building new stacks.
- Stay fully internal: renderer state + internal IPC only. No new frozen public
  substrate API.
- Be removable: a settings toggle returns the layout to exactly today's behavior.

## Non-goals (explicitly deferred)

- 🎤 Voice / mic input.
- Dedicated screenshot capture (the file picker + existing bracketed-paste image
  flow already covers attaching PNG/JPG).
- AI transports, hosted model calls, model switching, streaming transcript dock.
- Slash-command autocomplete menus.
- Any new public JSON-RPC / plugin extension point.

## Placement

The existing `StatusBar` is rendered at the **top** of the main column
(`AppLayout.tsx:1026`), not the bottom. This spec does **not** move it.

The new `AgentToolbar` mounts at the **bottom** of the main column — as the last
child of the `<div className="flex-1 min-w-0 flex flex-col">` that currently holds
`<StatusBar />` followed by the pane area. Resulting vertical order:

```
┌ main column ──────────────────────────┐
│ StatusBar            (top, unchanged)  │
│ Pane area           (flex-1, panes)    │
│ AgentToolbar        (NEW, bottom)      │
└────────────────────────────────────────┘
```

- The toolbar spans full width and always targets the **focused pane's active
  terminal surface**.
- In **multiview**, a single toolbar at the bottom of the main column acts on the
  focused tile's active pane (same focus resolution used elsewhere).
- When `agentToolbarEnabled` is `false`, the toolbar does not mount and the
  layout is byte-for-byte today's layout.

## Interaction mechanism (shared by all tools)

All actions resolve the focused target as:

```
activeWorkspace → activePaneId → active leaf → activeSurfaceId → ptyId
```

(the same chain the resume pill uses via `activeSurfacePtyId`). Then:

- **Keys** (e.g. Enter, Ctrl+C, Esc) → `window.electronAPI.pty.write(ptyId, …)`.
- **Text / paths** → `pastePtyChunked((d) => pty.write(ptyId, d), text, modes)`,
  which normalizes newlines to `\r`, keeps surrogate pairs whole, paces the IPC
  queue, and respects bracketed-paste mode. This is the same helper
  `Terminal.tsx` and `AppLayout.tsx` already use.

If no terminal surface is focused (e.g. a browser/editor surface is active), the
toolbar's inject actions are disabled (greyed) rather than writing to the wrong
target.

## The five tools

### 1. ＋ Attach
- Opens an OS file picker via Electron `dialog.showOpenDialog` in **main**
  (new internal IPC, e.g. `toolbar:pick-file`), returning the selected path(s).
- Inserts each path into the prompt, quoted when it contains spaces, through
  `pastePtyChunked`. PNG/JPG paths are attached exactly like the existing
  clipboard-image and file-drop flows, so the agent treats them as image
  attachments.
- Multi-select allowed; paths are space-joined (mirrors the drag-drop handler).

### 2. 📁 File explorer
- A popover anchored to the toolbar showing a browsable tree of the **current
  repo** (the focused workspace's cwd / git root), built on the existing
  `FileTreePanel` component.
- **Git-status badges** per file, VS-Code style: `M` modified (amber), `A` added
  (blue), `U` untracked (green), `D` deleted (red, struck-through). Source is
  `git status --porcelain` run in **main** for the workspace root, exposed via a
  new internal IPC (e.g. `git:status`) and refreshed off the existing
  `.git` `fs.watch` in `WorkspaceContextRouter` that already drives branch
  updates.
- **Click opens the file** in a wmux **editor surface** (`addSurface` with
  `surfaceType: 'editor'`, `editorFilePath`). It does **not** attach the path —
  attaching is the ＋ button's job. (Decision: option A.)

### 3. ★ Snippets
- A dropdown of user-saved reusable prompts (e.g. "write tests for this",
  "explain this error").
- Clicking a snippet inserts its text into the prompt via `pastePtyChunked`
  (does not auto-submit — user reviews then presses Enter, or uses Rich Input
  for multiline).
- Snippets are **persisted** (user-authored content they chose to save) — stored
  in session prefs as a small `snippets: { id, label, text }[]` array.
- Minimal management UI: add / rename / delete from the dropdown (or the
  General settings subsection). No folders/tags in v1.

### 4. ⌨ Rich Input (Ctrl+G)
- A multiline scratchpad popover for composing/pasting long prompts.
- **Enter inserts a newline** (ordinary textarea semantics). Paste, click-to-place
  cursor, and selection all behave like a normal editor.
- A **Send** button pastes the entire text into the focused prompt via
  `pastePtyChunked`, then writes a single `\r` to submit it as one message.
- Keeps a **per-pane draft in memory** (`richDraftByPane[ptyId]`) so closing and
  reopening resumes editing. (Decisions: B + C.)
- Opened/toggled by a configurable shortcut, default **Ctrl+G**, and by clicking
  the toolbar button. `Esc` closes the popover (does not submit).
- Drafts are **never written to disk** — prompt bodies stay in memory only,
  matching wmux's privacy posture for prompt content.

### 5. ⊕ New
- Sends a "new conversation / clear" command to the focused agent.
- v1 default: paste `/clear` + `\r`. The command string is a single configurable
  value (per-agent customization deferred).

## State & persistence

New renderer slice `agentToolbarSlice`:

```ts
interface AgentToolbarState {
  enabled: boolean;                              // persisted (settings toggle, default true)
  snippets: { id: string; label: string; text: string }[]; // persisted
  richDraftByPane: Record<string, string>;       // in-memory ONLY (ptyId → draft)
  openPopover: 'explorer' | 'snippets' | 'rich' | null; // transient
  newCommand: string;                            // persisted, default '/clear'
}
```

Persistence (extends `SessionData` in `buildSessionData`, non-sensitive fields
only, following the existing pattern):

- `agentToolbarEnabled: boolean`
- `agentToolbarSnippets: {…}[]`
- `agentToolbarNewCommand: string`

**Not persisted:** `richDraftByPane` (prompt bodies), `openPopover` (transient).

Git status is fetched on demand when the explorer opens and refreshed via the
existing `.git` watch — no new polling loop.

## Settings

A **General** settings subsection ("Agent toolbar"):

- **Show agent toolbar** — toggles `agentToolbarEnabled`. Off → toolbar unmounts.
- **Manage snippets** — add / rename / delete saved snippets.
- **New-conversation command** — text field, default `/clear`.
- (Rich Input shortcut surfaces through the existing keybindings system.)

## Architecture & integration points

| Concern | Reuse / add |
|---|---|
| Mount point | `AppLayout.tsx` main column, after pane area (new `<AgentToolbar />`) |
| Focused ptyId | Existing active-workspace → active-pane → active-surface chain |
| Text/path inject | Existing `pastePtyChunked` + `pty.write` |
| File picker | New main IPC `toolbar:pick-file` (Electron `showOpenDialog`) |
| File tree | Existing `FileTreePanel` (extended with git badges) |
| Git status | New main IPC `git:status` (`git status --porcelain`), refreshed off existing `.git` watcher in `WorkspaceContextRouter` |
| Open file | Existing `addSurface(..., 'editor', editorFilePath)` + `EditorPanel` |
| State | New `agentToolbarSlice` (Zustand) |
| Persistence | Extend `SessionData` / `buildSessionData` with 3 non-sensitive fields |
| i18n | All visible strings via existing `useT` hook |

No credentials, no network, no new public RPC. Everything is first-party renderer
+ internal IPC.

## Accessibility & i18n

- Buttons have labels, visible focus rings, keyboard operability, sensible tab
  order. Popovers are dismissible with `Esc` and trap focus while open.
- Git-status badges convey state with **letter + color**, never color alone.
- All visible text (button labels, "Send", "Attach", snippet management,
  settings) routes through `useT` / the i18n locale files (`en`, `ko`).

## Testing plan (Vitest, matching repo conventions)

- **Slice unit tests**: `enabled` toggle, snippet add/rename/delete, per-pane
  draft set/get/clear, `openPopover` transitions.
- **Inject semantics**: attach-path quoting (spaces), Rich Input Send pastes full
  text then a single `\r`, New sends configured command + `\r`.
- **Git parsing**: `git status --porcelain` → `{ path, code }[]` mapping for M/A/U/D
  and renamed/edge cases.
- **Focused-target helper**: resolves the correct ptyId across single view and
  multiview; returns null (disables inject) when a non-terminal surface is focused.
- **Render/layout**: toolbar mounts at bottom when enabled; unmounts cleanly and
  restores prior layout when disabled; existing top status bar unaffected.

## Acceptance criteria

| Area | Criterion |
|---|---|
| Toggle | With the setting off, layout matches today exactly; on, the bottom bar appears. |
| Attach | Picking a file inserts its quoted path into the focused prompt; a PNG is attached as an image. |
| File explorer | Tree shows current repo with correct M/A/U/D badges; clicking a file opens it in an editor surface (does not attach). |
| Snippets | Saved snippets persist across restart; clicking one inserts its text. |
| Rich Input | Enter adds newlines; Send pastes the full text and submits as one message; draft survives close/reopen; never written to disk. |
| New | Sends the configured new-conversation command to the agent. |
| Focus safety | Inject actions disabled when a non-terminal surface is focused. |
| Security | No prompt bodies persisted; no credentials/network involved. |
| i18n / a11y | All strings translated; badges not color-only; popovers keyboard-operable. |

## Open questions (non-blocking)

- Snippet management UX: inline in the dropdown vs. only in settings. (Lean:
  both — quick "＋ add from current draft" in the dropdown, full edit in settings.)
- Per-agent `New` command presets (Claude `/clear` vs others) — deferred to a
  later pass; v1 ships one configurable string.
