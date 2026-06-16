# Follow-up: RPC workspaceId scoping sweep (siblings of #236)

**Status:** tracked, deferred out of the #236 fix (scope discipline).
**Parent:** #236 (`pane.split` ignored `workspaceId` → fixed: handler fail-closed +
focus-scoping + background eager-spawn + main-side forward).

## Why this is separate from #236

The #236 expert panel (sweep agent) found `pane.split` is **not** the only RPC
handler that ignores an explicit `workspaceId` and always acts on the
globally-active workspace. The same `activeWorkspaceId`-fallback defect lives in
several sibling handlers. They are deferred because — unlike `pane.split`, which
is a pure "create in my ws" operation — the `*.focus` siblings **intentionally
move the user's focus today**, so changing them is a UX-semantics decision that
needs its own dogfood, not a drive-by bugfix bundled into #236.

## Classification (current branch, post-#236)

C-bucket = ignores `workspaceId` entirely (always active ws).
B-bucket = reads `workspaceId` but silently falls back to active ws on miss.

| Method | Renderer site | Daemon site | Bucket | Multi-agent impact |
|---|---|---|---|---|
| `pane.focus` | `useRpcBridge.ts` (`method === 'pane.focus'`) | `pane.rpc.ts` `pane.focus` (forwards only `id`) | **C** | external caller focuses the active ws's pane, not its own |
| `surface.new` | `useRpcBridge.ts` (`method === 'surface.new'`) | `surface.rpc.ts` `surface.new` (drops params) | **C** | new terminal opens in the on-screen ws, not the caller's |
| `surface.focus` | `useRpcBridge.ts` (`method === 'surface.focus'`) | `surface.rpc.ts` `surface.focus` (forwards only `id`) | **C** | focus moves in the active ws, not the caller's |
| `browser.open` | `useRpcBridge.ts` (`browser.open`) | `browser.rpc.ts` | **B** | MCP-gated by `requireWorkspaceId()` upstream → low risk |
| `browser.close` | `useRpcBridge.ts` (`browser.close`) | `browser.rpc.ts` | **B** | MCP-gated → low risk |

(For contrast, the already-CORRECT handlers — `pane.list`, `surface.list`,
`surface.close` — read `workspaceId` and either fail closed or search all
workspaces by a globally-unique id. `pane.split` now joins them.)

## Also surfaced, separate gap

- **No `pane.close` / `pane.delete` RPC exists.** The store has
  `closePane(paneId, workspaceId?)` but it is not registered on the pipe. An
  external multi-agent caller that creates a worker pane (now possible via the
  #236 fix) cannot clean it up over RPC — it has to `exit` the shell. Worth a
  `pane.close` handler mirroring `surface.close`'s all-workspace, id-unambiguous
  lookup.

## Recommended approach for the sweep PR

1. **`surface.new` first** — lowest UX risk (creating, not focusing) and #236
   already did half the infra: `addSurface` now takes an optional `workspaceId`,
   and the background eager-spawn pattern in the `pane.split` handler is the
   template. Thread `workspaceId` (fail-closed) + eager-spawn for a background ws.
2. **`pane.focus` / `surface.focus`** — these need a product decision: should a
   remote focus move the *global* view or only the *target ws's* internal active
   pane/surface? Likely the latter (don't yank the user's screen), mirroring the
   #236 focus-scoping. Dogfood with two live workspaces.
3. **`pane.close` RPC** — additive; mirror `surface.close`.
4. Leave `browser.*` B-bucket as-is unless a concrete report lands (MCP-gated).

Each gets a `workspaceRouting` / dogfood regression like #236's.
