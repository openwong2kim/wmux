# Add terminal tab button

**Date:** 2026-08-15  
**Status:** Approved design, pending implementation plan  
**Area:** `src/renderer/components/Pane`, `src/renderer/hooks`, `src/renderer/utils`

## Problem

`SurfaceTabs` renders terminal, browser, and other surfaces as tabs inside a pane. A
new terminal surface can currently be created with `Ctrl+T`, but there is no
visible action in the tab strip. The pane-header terminal action was previously
removed, leaving users who prefer pointer interaction without an obvious way to
add a tab.

The existing keyboard path already defines the expected terminal-creation
behavior, including the daemon bootstrap guard, default shell/profile selection,
working-directory selection, IPC error handling, and activation of the created
surface. The new button must reuse that behavior rather than implement a second
creation path.

## Goal

Add a visible `+` button immediately after the last surface tab. Clicking it
creates a new terminal surface in the current pane, with the same behavior as
`Ctrl+T`, and makes the new tab active.

## Non-goals

- No new workspace or pane is created.
- No menu for choosing terminal, browser, editor, or other surface types.
- No changes to split-right, split-down, browser, zoom, drag, close, or rename
  behavior.
- No change to the tab ordering or tab naming rules.
- No new user setting for showing or hiding the button; the existing pane action
  visibility setting controls the action cluster only, not the tab-strip add
  button.

## Design decisions

- **Placement:** The `+` appears directly after the last rendered surface tab,
  not at the far right of the full header. This keeps the action adjacent to the
  thing it creates and avoids a large empty gap when there are only one or two
  tabs.
- **Visual treatment:** Use the existing tab-strip typography, spacing, colors,
  and focus-ring contract. The button is a lightweight unbordered control rather
  than a new bordered pill, so it remains visually subordinate to the active tab.
- **Behavior:** The button creates a terminal surface in the owning pane and
  workspace. It must work when the pane is not the globally active pane in a
  multiview layout by passing the owning workspace explicitly.
- **Implementation boundary:** `SurfaceTabs` receives an `onAddTerminal`
  callback and remains unaware of IPC, PTY creation, shell selection, and toast
  behavior.

## Architecture

Extract the existing `Ctrl+T` terminal creation sequence into a shared helper,
for example `createTerminalSurface`, at the renderer utility or hook boundary
where its IPC and store dependencies can be passed explicitly. The helper must
be pure with respect to UI rendering and must not depend on a mounted
`SurfaceTabs` component.

The helper receives the target workspace/pane identity and the dependencies it
needs to perform the existing flow:

1. Confirm the target workspace and pane are available.
2. Apply the same pane-gate/daemon-readiness guard currently used by `Ctrl+T`.
3. Resolve the same cwd, default shell, and workspace profile used by the
   keyboard path.
4. Call the existing `pty.create` IPC operation with the same spawn kind and
   workspace profile.
5. Add the returned PTY as a terminal surface to the target pane and workspace.
6. Activate the new surface using the existing store action.
7. Route rejected creation/resource-limit errors through the existing toast or
   error-reporting mechanism.

`useKeyboard` calls this helper for `Ctrl+T`. `Pane` wires the same helper to
`SurfaceTabs` through `onAddTerminal`. The callback is scoped to the pane's
`pane.id` and `workspace.id`, avoiding stale global active-workspace state.

### Data flow

```text
click +
  -> SurfaceTabs onAddTerminal callback
  -> Pane target workspace.id + pane.id
  -> shared createTerminalSurface helper
  -> existing pty.create IPC path
  -> store.addSurface(target pane, created pty)
  -> store.setActiveSurface(new surface)
  -> SurfaceTabs renders the new active tab
```

The keyboard path follows the same helper after the `Ctrl+T` event is accepted.
Both entry points therefore share readiness checks, PTY options, workspace
profile handling, error handling, and surface activation.

## UI contract

- The button is rendered after `surfaces.map(...)`, so it remains immediately
  after the last tab.
- It has an accessible name such as `Add terminal tab` through the project's
  existing localization/accessibility pattern.
- It uses the existing focus-ring utility and keyboard activation semantics of a
  native button.
- Clicking the button must not trigger the parent tab-strip or pane click
  handlers.
- The button remains available regardless of whether pane action buttons are
  visible; the existing `paneActionsVisible` setting hides the split/browser/
  zoom cluster, not this tab creation control.

## Error handling and edge cases

- If the target workspace or pane no longer exists, the helper is a no-op using
  the same internal-state assumptions as the current keyboard path.
- If PTY creation is rejected, no surface is added and the existing error/toast
  path is used.
- If the workspace/session cap is reached, the user sees the same resource-limit
  feedback as `Ctrl+T`.
- A successful creation adds exactly one terminal surface to the target pane and
  activates it.
- Browser/editor/diff surfaces remain unchanged; the button always creates a
  terminal surface.

## Testing

### Shared creation helper

Add focused tests for the extracted helper covering:

- Successful PTY creation adds one terminal surface to the requested pane and
  workspace.
- The created surface becomes active.
- The helper passes the same shell, cwd, profile, workspace id, and spawn kind as
  the existing `Ctrl+T` path.
- PTY creation rejection does not add a surface and invokes the existing error
  handling.
- A non-active workspace/pane target is honored rather than using the global
  active workspace.

### SurfaceTabs integration

Update the existing `SurfaceTabs.actions` test to mount the real component with
`onAddTerminal` wired to the same helper/store path and assert that:

- A `+` button is rendered immediately after the final tab.
- Clicking `+` creates one terminal surface in the current pane.
- The new surface becomes active.
- The button has an accessible name.
- Existing split-right, split-down, browser, zoom, and hidden-action behavior
  still passes.

### Keyboard regression

Retain or extend the keyboard test so `Ctrl+T` invokes the shared helper. This
ensures extracting the flow does not change the existing shortcut behavior.

## Success criteria

- A user can click `+` immediately after the last tab to create a terminal tab.
- The new tab is created in the same pane and workspace as the button.
- The new tab becomes active and behaves exactly like a tab created with
  `Ctrl+T`.
- Existing surface actions and settings remain unchanged.
- Focused tests for the helper, tab action, and keyboard path pass.
