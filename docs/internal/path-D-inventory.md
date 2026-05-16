# Path D call-site inventory (substrate Phase 2.1 pre-work)

> Phase 0 pre-work for substrate Phase 2.1 path-D removal. The substrate plan
> calls path D the "only remaining footgun" against the four enforcement points
> in `docs/PROTOCOL.md §4`. This file enumerates every concrete call site so
> Phase 2.1 starts from a fixed inventory rather than rediscovering them under
> deadline.

## What "path D" means

From `docs/PROTOCOL.md §6.1`:

> Path D — `activeWorkspaceId` (renderer-side fallback). A small number of
> legacy RPCs accept an optional `workspaceId` parameter; if omitted, the
> renderer falls back to `store.activeWorkspaceId`. **Non-deterministic —
> depends on whatever workspace the user is viewing at the moment of the
> call.**

Path A (env var) and path C (`mcp.claimWorkspace`) are deterministic. Path D is
the one the enforcement gate cannot reason about, because the answer is decided
in the renderer at dispatch time, after the caller already submitted the
request.

## Classification

Not every `store.activeWorkspaceId` read is a path-D bug. Three categories:

- **path-D**: external MCP caller can hit this branch and silently route to
  whatever workspace the user is currently viewing. Phase 2.1 must close it.
- **by-design active**: the method's contract is *"act on whatever is active
  right now"* — `workspace.current`, `input.getActivePtyId`,
  `findActiveBrowserWebview`. Keep as is, document the semantics.
- **internal helper**: read after a state mutation the same handler just
  performed (e.g. `mcp.claimWorkspace` snapshotting the prior active id). Not
  reachable as a fallback for external callers. Keep as is.

## `src/renderer/hooks/useRpcBridge.ts`

| Line | Method | Category | Phase 2.1 action |
|------|--------|----------|------------------|
| 154 | `workspace.new` (read-after-mutation) | internal helper | keep |
| 159 | `workspace.focus` (set, not read fallback) | internal helper | keep |
| 171 | `workspace.current` | by-design active | document semantics |
| 180 | `mcp.claimWorkspace` (snapshot prior) | internal helper | keep |
| 188 | `mcp.claimWorkspace` (find new ws) | internal helper | keep |
| 234 | `surface.list` | **path-D** | require `workspaceId` from external MCP; allow renderer-internal omission via explicit caller tag |
| 263 | `surface.new` | **path-D** (no `workspaceId` in schema) | add `workspaceId` to RPC schema; require for MCP |
| 299 | `surface.focus` | **path-D** (no `workspaceId` in schema) | add `workspaceId`; resolve via path A/B/C |
| 312 | `surface.close` | **path-D** (no `workspaceId` in schema) | add `workspaceId`; resolve via path A/B/C |
| 339 | `pane.list` | **path-D** | require `workspaceId` from external MCP |
| 366 | `pane.split` | **path-D** (no `workspaceId` in schema) | add `workspaceId`; require for MCP |
| 386 | `pane.resolveActiveLeaf` | **path-D fallback** | internal IPC only; keep but tag caller |
| 455 | `pane.search` | **path-D fallback** | already documented (C1 / D9); audit external caller path |
| 594 | `input.readScreen` | **path-D fallback** | already partially gated; reject when caller is MCP without workspaceId |
| 651 | `input.getActivePtyId` | by-design active | document; restrict to renderer-internal callers |
| 667 | `meta.setStatus` | **path-D** (no `workspaceId` in schema) | add `workspaceId`; require for MCP |
| 673 | `meta.setProgress` | **path-D** (no `workspaceId` in schema) | add `workspaceId`; require for MCP |
| 684 | `browser.open` | **path-D fallback** | require `workspaceId` from external MCP |
| 756 | `browser.close` | **path-D** (no `workspaceId` in schema) | add `workspaceId`; require for MCP |
| 1158 | `findActiveBrowserWebview` (helper) | by-design active | document; helper consumed only by `handleBrowserNavigate` |

## `src/renderer/hooks/useNotificationListener.ts`

| Line | Site | Category | Phase 2.1 action |
|------|------|----------|------------------|
| 61 | `resolveNotificationTarget` (no hint, no ptyId) | by-design active | keep; notification address-of-last-resort |
| 94 | dedup vs active surface | by-design active | keep; renderer-only UX check |
| 171 | `metadata.onUpdate` (no `ptyId`, no `payloadWsId`) | **path-D** | require `workspaceId` in payload for any MCP-side metadata.update; renderer-internal still allowed |

## Summary

- **path-D sites to fix in Phase 2.1**: 14 (12 in `useRpcBridge.ts` + 1 fallback already partially gated + 1 in `useNotificationListener.ts`).
- **by-design active**: 4 — keep, document the contract.
- **internal helpers**: 5 — keep, not reachable from external MCP.

## Phase 2.1 implementation approach

1. **Schema first**: extend `RpcParams` typing for each path-D RPC so `workspaceId` is at least `optional + tagged`, not silently fallback. Tag indicates whether caller is `mcp-external` or `renderer-internal`.
2. **Resolution order**: at the RPC dispatch boundary, resolve `workspaceId` via
   - explicit param if provided
   - path A (`WMUX_WORKSPACE_ID` env) on the MCP-server connection
   - path B (PID-tree walk) if path A empty
   - path C (`mcp.claimWorkspace`) for non-wmux terminals
   - **never** `store.activeWorkspaceId` for `mcp-external` callers.
3. **Renderer-internal callers** (e.g. `SearchBar`, command palette) keep the existing fallback. They are not a substrate boundary — they run inside the renderer process where "active" is a meaningful concept.
4. **Error surface**: when an `mcp-external` call reaches the dispatch with no `workspaceId` and paths A/B/C all fail, the dispatch returns a typed JSON-RPC error (`-32602 path-D-fallback-disallowed`) so MCP servers fail loudly instead of silently writing to the wrong workspace.
5. **Migration order** (low-risk first):
   - Read-only RPCs (`surface.list`, `pane.list`, `input.readScreen`) — additive `workspaceId` requirement breaks no current internal callers, since internal callers know their workspace.
   - Pane / surface mutations (`surface.new/focus/close`, `pane.split`).
   - Metadata writes (`meta.setStatus`, `meta.setProgress`, `metadata.onUpdate`) — these are the highest-risk for cross-workspace damage and should land with the strictest validation.
   - Browser surface (`browser.open/close`) — last, since cross-workspace browser navigation has limited user impact compared to metadata corruption.

## Open questions

- **`pane.resolveActiveLeaf` (line 386)**: documented as M0-b "internal IPC". Should it be exposed to external MCP at all? If yes, what's the contract when the caller passed a `workspaceId`? Suggested: behave like the path-D fallback only when called from main process (`internal` tag), reject otherwise.
- **`input.getActivePtyId` (line 651)**: this is the most explicit "active" RPC in the inventory. External MCP can already use `mcp.claimWorkspace` + `pane.list` to find a deterministic PTY. Consider deprecating this RPC for `mcp-external` callers, or renaming it to `renderer.getActiveContext` to make the substrate boundary explicit.
- **Caller tagging mechanism**: needs a single concrete proposal — propagate via a transport-level attribute on the named-pipe connection, set at auth time based on whether the connection presented an MCP server name vs a renderer IPC channel.

## Related

- `docs/PROTOCOL.md §6.1` — the four resolution paths.
- `docs/PROTOCOL.md §7` — known limitations entry that defers path-D removal to Phase 2.1.
- `docs/internal/paneSlice-callsite-inventory.md` — companion pre-work for M0.
- `C:\Users\rizz\.claude\plans\generic-wandering-teapot.md` — substrate v3.0 plan (Phase 2.1 work item entry).
