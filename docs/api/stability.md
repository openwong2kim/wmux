# wmux v3.0 Stable Surface

> **Status:** Phase 0 deliverable for Substrate 3.0. Freezes the v3.0 substrate contract.
> **Audience:** plugin authors and external orchestrators planning long-lived integrations.
> **Companion docs:** [`inventory.md`](./inventory.md) (full surface list with tiers), [`versioning.md`](./versioning.md) (semver + tier semantics), [`../PROTOCOL.md`](../PROTOCOL.md) (wire contract).

---

## What this document is

The v3.0 substrate contract is a *subset* of the inventory. This file lists every surface that ships with `stable` guarantees, plus the precise scope of what's guaranteed for each.

A v3.0 `stable` surface is:

1. **Wire-shape-frozen.** Parameter names, return field names, JSON-RPC error codes, event envelope keys — fixed for the v3.x lifetime.
2. **Semantics-frozen.** Same input ⇒ same output and side effects.
3. **Additive-only.** New optional parameters and new fields may appear in minor releases (`3.1.0`, `3.2.0`, …). New event types may be added. Existing fields don't disappear and don't change meaning.
4. **Removable only on a major** (v4.0+), with at least one minor's deprecation notice.

A v3.0 `stable` client — one that uses only the surfaces in this document, ignores unknown fields, and feature-detects via `system.capabilities` — is guaranteed to keep working across every v3.x release.

---

## Substrate core (the metadata + events surface)

This is the heart of the substrate contract — the surface RFC #15 was about.

### `pane.list`

**Method:** `pane.list`
**Params:** `{ workspaceId?: string }`
**Returns:** `{ asOfSeq: number, bootId: string, panes: PaneListEntry[] }`

- `asOfSeq` is the EventBus seq at snapshot time. Clients reconciling after `resync: true` must drain events with `seq > asOfSeq`.
- `bootId` is stable for the lifetime of the main-process run. Mismatch ⇒ client drops all cached pane ids, pty ids, and cursors.
- Each `PaneListEntry` contains pane tree info plus `metadata: PaneMetadata` (with `version` in v3.0+).
- **`stashed: boolean` (#977)** is present on every entry, always — never omitted. A stashed pane has been taken out of the layout by the user but is still owned by the workspace and its session is still running.
- **`includeStashed?: boolean` (#977, default `false`)** opts the response into stashed panes. The DEFAULT membership is unchanged: without it, `panes` still means "what is in the layout". Adding a field is forward-compatible; changing who is in the array is not, so this is opt-in.
- **`stashedLiveness: 'alive' | 'exited'`** appears on stashed entries only. `exited` means every terminal surface in that pane has lost its PTY — the daemon confirmed the session is gone. The user sees the same thing in the sidebar; an agent must be able to see it too, or it will keep addressing a pane whose session no longer exists.

`pane.list` is the snapshot-reconciliation primitive for the event bus. Combined with `events.poll`, it gives external tools a complete recovery path under burst writes or daemon restarts. `pane.stashed` / `pane.unstashed` exist so that path stays complete: a pane leaving the default listing is always explained by an event, never by silence.

**`stashed` is not the only reason a pane may be off-screen.** A cold-parked workspace's panes are `stashed: false` and equally unmounted — parking is an automatic, whole-workspace RAM reclaim that the user never asked for and never sees, while stashing is a per-pane thing the user did on purpose and can undo from the sidebar. Do not treat the two as interchangeable.

### `pane.stash` / `pane.unstash` (#977)

**Methods:** `pane.stash` / `pane.unstash`
**Params:** `{ id: string }`
**Returns:** `{ ok: true, stashed: boolean }`

`pane.stash` takes a leaf pane out of the layout WITHOUT killing it — the daemon keeps the session and replays it on return. It is refused when the pane is the only visible one, when there is no daemon connection (nothing would hold the session), or when the pane holds an editor/diff tab whose unsaved state the ring cannot replay.

`pane.unstash` puts it back next to its former neighbour. It is **idempotent**: a pane that is already in the layout is a success, not an error — the retry that a `PANE_STASHED` error asks for must always be safe to run.

Which operations work on a stashed pane:

| Operation family | Stashed | Why |
|---|---|---|
| Address ops — `input.send`, `input.sendKey`, `input.readScreen`, A2A delivery | **work** | The PTY is alive in the daemon and stdin needs no coordinates. Refusing here would mean a running agent silently stops receiving its teammates' messages. |
| Destructive address ops — `pane.close`, `surface.close` | **work** | A list that hands you an id you then cannot close is a leak with extra steps. |
| Position ops — `pane.focus`, `surface.focus` | refused | There is no slot to act on. |

A stashed pane whose session has EXITED (`stashedLiveness: 'exited'`) refuses writes too, but for a different reason and with a different shape: its surfaces no longer carry a ptyId, so there is nothing to address. That is target absence, not position — the one named exception to the address-ops rule above. Bring it back with `pane.unstash` and the pane re-attaches showing wmux's dead-pane recovery offer; it never silently self-creates a fresh shell under the old pane's name.

While the daemon connection is DOWN, stashed panes are left exactly as they are: nothing is auto-unstashed, the reported state is the last known one, and the next reconcile after reconnect settles it. Same contract cold-park already has.

A refused position op returns `code: 'PANE_STASHED'` with a `recovery` payload the caller can invoke verbatim:

```json
{
  "error": "pane.focus: pane <id> is stashed (not in the layout). Call pane.unstash({ id: \"<id>\" }) to bring it back, then retry — or read/write it in place with input.readScreen / input.send, which work while stashed.",
  "code": "PANE_STASHED",
  "recovery": { "method": "pane.unstash", "params": { "id": "<id>" } }
}
```

**Feature detection:** `system.capabilities` reports `features.paneStash: true`.

### `pane.setMetadata`

**Method:** `pane.setMetadata`
**Params:** `{ paneId?, workspaceId?, label?, role?, status?, custom?, mergeMode?, merge?, expectedVersion? }`
**Returns (success):** `{ ok: true, version: number, metadata: PaneMetadata }`
**Returns (version conflict, v3.0+):** JSON-RPC error code `-32001` with `{ error: 'VERSION_CONFLICT', currentVersion: number }`

- Stable validation limits: `PANE_METADATA_MAX_BYTES`, `PANE_METADATA_LABEL_MAX`, `PANE_METADATA_ROLE_MAX`, `PANE_METADATA_STATUS_MAX`, `PANE_METADATA_CUSTOM_KEY_MAX`, `PANE_METADATA_CUSTOM_MAX_ENTRIES`. Numeric values may grow in minors but cannot shrink within v3.x.
- `mergeMode` accepts `'merge'` (default — patch-style, with one-level deep-merge on `custom`), `'replace'` (full overwrite of the entire metadata object), and `'replaceShared'` (replace `label`/`role`/`status` while preserving `custom`).
- Legacy `merge: boolean` is preserved as a shortcut: `merge: true` ⇒ `mergeMode: 'merge'`, `merge: false` ⇒ `mergeMode: 'replace'`.
- `expectedVersion` enables optimistic concurrency. Mismatch returns `VERSION_CONFLICT` with the current version; client decides whether to retry.
- Omitting `expectedVersion` opts out of version checks. Equivalent to the v2.x semantics.
- Per-pane `version` is monotonic. Each successful `set` increments by 1. `version: 0` is the "no metadata ever set" sentinel.

### `pane.getMetadata`

**Method:** `pane.getMetadata`
**Params:** `{ paneId?, workspaceId? }`
**Returns:** `{ metadata: PaneMetadata | undefined, version: number }`

Reads return the latest committed metadata + version. No event emitted.

### `pane.clearMetadata`

**Method:** `pane.clearMetadata`
**Params:** `{ paneId?, workspaceId? }`
**Returns:** `{ ok: true, version: number }`

Drops all metadata for a pane. Emits `pane.metadata.changed` with the new (empty) metadata. Increments `version`.

### `events.poll`

**Method:** `events.poll`
**Params:** `{ cursor?: number, types?: WmuxEventType[], workspaceId?: string, max?: number }`
**Returns:** `{ events, nextCursor, priorCursor, bootId, droppedCount?, resync? }`

- Cursor is **opaque**. On a response without `resync`, clients pass `nextCursor` back verbatim on the next poll. Do not increment it or clamp it against the previous cursor.
- Without `resync`, `nextCursor >= priorCursor`; it advances when the poll scanned at least one newer event, including filter no-matches.
- With `resync: true`, `nextCursor` is a replacement cursor and may be lower than `priorCursor`, including `0` against an empty ring. Do not clamp it. Reconcile through `pane.list` and resume from its `asOfSeq`, which supersedes the replacement; see [`PROTOCOL.md` §2.2](../PROTOCOL.md#22-cursor-is-opaque).
- Default cursor is `0` — replay from the oldest event in the ring.
- `priorCursor` echoes the cursor the caller passed in. Used for diagnostics.
- `resync: true` indicates the caller's cursor drifted past the ring window or points past the newest event. Client must reconcile as described above.
- `droppedCount` is set when known (drift past ring) and reports the number of events the caller missed.
- `bootId` is present on every response. Mismatch ⇒ daemon restarted; drop all caches.
- Event ordering: monotonic in **arrival order**, not in **causal order** (see [`inventory.md`](./inventory.md#event-types) for the cross-producer caveat).

Stable event types:

| Type | Wire shape (beyond `seq`/`ts`/`workspaceId`/`type`) |
|---|---|
| `pane.created` | `paneId`, `parentBranchId?` |
| `pane.closed` | `paneId` |
| `pane.focused` | `paneId`, `previousPaneId?` |
| `pane.metadata.changed` | `paneId`, `metadata`, `version` (v3.0+) |
| `workspace.metadata.changed` | `metadata`, `patch` |
| `process.started` | `ptyId`, `pid?`, `shell` |
| `process.exited` | `ptyId`, `exitCode`, `signal?` |

Ring sizing (`RING_CAPACITY = 1024`, `POLL_DEFAULT_MAX = 256`) is an implementation detail. Both may grow in minors but cannot shrink within v3.x.

---

## Identity and trust

### `mcp.claimWorkspace`

**Method:** `mcp.claimWorkspace`
**Params:** `{ workspaceId: string }`
**Returns:** `{ ok: true }`

Stable contract: after a successful claim, all subsequent metadata writes and event subscriptions from this MCP client are scoped to the claimed workspace. Writes targeting other workspaces are rejected with a permission error.

Added in v2.7.2 to prevent active-pane hijacking by external MCPs. Stays unchanged in v3.0.

### `system.identify`

**Method:** `system.identify`
**Params:** — none —
**Returns:** `{ app: 'wmux', version: string, platform: NodeJS.Platform, electronVersion: string }`

Identity probe. Stable shape; new fields may be added in minors.

### `system.capabilities`

**Method:** `system.capabilities`
**Params:** — none —
**Returns:** `{ methods: string[], features: { paneMetadata: ..., events: ..., stabilityTiers?: ... } }`

`methods` is the full list of registered RPC method names. `features.events.bootId` and `features.events.maxRingSize` are stable.

`features.paneMetadata` returns a sub-object in v3.0: `{ optimisticConcurrency: true, mergeModes: ['merge', 'replace', 'replaceShared'] }`. v2.x returns `true` (boolean). Clients should treat truthy and object shapes both as "metadata feature present" and feature-detect specific sub-features by key presence.

`features.stabilityTiers` (v3.0+) reports the tier for each method/feature, mirroring this document programmatically. Clients can use it for capability-based degradation.

---

## Terminal I/O

### `input.send`

**Method:** `input.send`
**Params:** `{ text: string, paneId?, workspaceId? }`
**Returns:** `{ ok: true }`

Sends literal text to a pane's PTY. Targeting falls back to the active pane in the active workspace.

### `input.sendKey`

**Method:** `input.sendKey`
**Params:** `{ key: string, paneId?, workspaceId? }`
**Returns:** `{ ok: true }`

Sends a control-key sequence. Key names follow xterm conventions (`'Enter'`, `'Backspace'`, `'C-a'`, etc.).

### `input.readScreen`

**Method:** `input.readScreen`
**Params:** `{ paneId?, workspaceId? }`
**Returns:** `{ text: string }`

Reads the current visible terminal buffer as plain text.

### `terminal.readEvents`

**Method:** `terminal.readEvents`
**Params:** `{ paneId?, workspaceId?, sinceSeq? }`
**Returns:** `{ events: PromptEvent[], nextSeq: number }`

Reads structured terminal output events (prompt detection, agent status events). Wire-shape stable; the set of `PromptEvent` types is additive-only within v3.x.

---

## Workspace and surface

| Method | Stable contract |
|---|---|
| `workspace.list` | Returns all workspaces with their metadata. Workspace ids are stable across daemon restarts. |
| `workspace.new` | Creates a new workspace. Returns the new workspace id. |
| `workspace.focus` | Switches the active workspace. Idempotent. |
| `workspace.close` | Closes a workspace and cleans up its PTYs. |
| `workspace.current` | Returns the active workspace id. |
| `surface.list` | All wmux windows. |
| `surface.new` | Opens a new wmux window. |
| `surface.focus` | Focuses an existing window. |
| `surface.close` | Closes a window. |
| `pane.focus` | Focuses a leaf pane within the active workspace. |
| `pane.split` | Splits the active pane. Returns the new pane id. |
| `pane.search` | Cross-pane content search within a workspace. Scoped to the calling workspace. |

---

## Display vocabulary (shared display state)

These shape the workspace/pane state that other tools (and the future wmux UI) read as "what's going on here?"

| Method | Stable contract |
|---|---|
| `notify` | OS notification + in-app banner. |
| `meta.setStatus` | Workspace-level shared status field. Last-writer-wins semantics; v3.0 documents the layered-status convention (see [`../PROTOCOL.md`](../PROTOCOL.md#layered-status)). |
| `meta.setProgress` | Workspace-level shared progress field. Same semantics as `setStatus`. |
| `meta.setSkills` | A2A agent self-description for `a2a.discover`. |

---

## Agent-to-Agent (A2A)

Stable in v3.0. All A2A surfaces continue with the v2.7.3 execute-approval contract.

| Method | Stable contract |
|---|---|
| `a2a.resolve.identity` | Returns the canonical identity for a workspace's agent. |
| `a2a.whoami` | The calling MCP's claimed identity. |
| `a2a.discover` | Lists other agents in the local wmux instance. |
| `a2a.task.send` | Send a task; `execute:true` is new-task only and is approval-gated before task creation unless global auto-approve is enabled. |
| `a2a.task.query` | Fetch the status of a task by id. |
| `a2a.task.update` | Update task status. |
| `a2a.task.cancel` | Cancel an in-flight task. |
| `a2a.broadcast` | Send a typed broadcast to all discoverable agents. |
| `a2a.channel.list` | List channels in the caller's company. Requires explicit `workspaceId` (Path D closed). |
| `a2a.channel.create` | Create a channel; creator is auto-added as a member with `historyFromSeq: 0`. |
| `a2a.channel.post` | Post a message; idempotent on `clientMsgId`; surfaces `PERSIST_FAILED` instead of swallowing. |
| `a2a.channel.join` | Add a member; `includeHistory: false` sets `historyFromSeq` to current `nextSeq`. |
| `a2a.channel.leave` | Remove a member; last member sets `emptySince`. |
| `a2a.channel.archive` | Archive a channel (one-way); members retain history. |
| `a2a.channel.get` | Read a channel row. |
| `a2a.channel.getMessages` | Read messages, optionally filtered to `seq >= sinceSeq`. |
| `a2a.channel.getMembers` | Read the member list. |

The `a2a.channel.*` surface ships as stable in v3.0. New optional parameters and new fields may appear in minor releases (e.g. a future `channel.update` for renames/topics) but the existing field names and types will not change within v3.x. The `channel.message` event type is also frozen stable — the multi-party scoping rule (sender `workspaceId` plus every `recipientWorkspaceId`; zero visibility on an unscoped poll) is part of the contract.

---

---

## Validation limits (v3.0 baseline values)

These can grow in minor releases; they cannot shrink within v3.x.

| Limit | v3.0 value | Notes |
|---|---|---|
| `PANE_METADATA_MAX_BYTES` | 8192 | Hard cap on serialized PaneMetadata size. |
| `PANE_METADATA_LABEL_MAX` | 64 | Max chars in `label`. |
| `PANE_METADATA_ROLE_MAX` | 64 | Max chars in `role`. |
| `PANE_METADATA_STATUS_MAX` | 128 | Max chars in `status`. |
| `PANE_METADATA_CUSTOM_KEY_MAX` | 64 | Max chars in a `custom` key. |
| `PANE_METADATA_CUSTOM_MAX_ENTRIES` | 32 | Max entries in `custom`. |
| `RING_CAPACITY` (events) | 1024 | Event bus ring buffer size. |
| `POLL_DEFAULT_MAX` | 256 | Default per-poll event cap. |
| `MAX_CONNECTIONS` (Named Pipe) | 50 | Concurrent client connections. |
| `CHANNEL_IDEMPOTENCY_CAP` | 1000 | Per-channel idempotency LRU cap (R13). Repeat posts with the same `clientMsgId` return the original `seq` instead of appending a duplicate. |
| `CHANNEL_EMPTY_TTL_HOURS_DEFAULT` | 168 (7 days) | TTL after which an empty channel (no members, `emptySince` set) is pruned by the reaper on `load()`. Channels with members are retained indefinitely — the TTL only applies to channels whose last member left (`emptySince` set) and remained unpopulated for the full window. |
| `CHANNEL_TRASH_TTL_HOURS_DEFAULT` | 720 (30 days) | How long a channel stays in the trash before the retention sweep destroys it. Override with `channels.trashTtlHours` in `config.json`; `0` disables the purge. Nothing reaches the trash except an explicit `a2a.channel.trash` call, so this only ever finishes a deletion a human started. The sweep also skips any channel an open mission still links to. `a2a.channel.trash` / `restore` / `destroy` are humans-only transport (renderer IPC; not registered on the MCP/agent router), and — like `archive` — they trust a caller-supplied `verifiedWorkspaceId`, which leaves the documented same-user direct-pipe residual (#113 / F1). Accepted, with the note that `destroy` makes that residual unrecoverable rather than merely disruptive. |
| `CHANNEL_AUTO_TRASH_ARCHIVED_HOURS_DEFAULT` | 0 (off) | Age at which the sweep moves an ARCHIVED channel to the trash on its own. Off by default — this is the only knob that discards records nobody chose to discard. Override with `channels.autoTrashArchivedHours`. Even when on it only moves channels to the trash, so the full trash TTL undo window still applies. |

---

## Error contract

All `stable` JSON-RPC methods follow the JSON-RPC 2.0 error model with these additional reserved codes:

| Code | Meaning | Used by |
|---|---|---|
| `-32001` | `VERSION_CONFLICT` — `expectedVersion` mismatch | `pane.setMetadata` |
| `-32002` | `WORKSPACE_NOT_CLAIMED` — caller hasn't claimed the workspace they're trying to write to | `pane.setMetadata`, `meta.setStatus`, `meta.setProgress` |
| `-32003` | `RESOURCE_EXHAUSTED` — session cap reached | session-creating methods (see v2.8.2 release notes) |

Additional codes may be added in minors; clients should treat unknown error codes as recoverable-or-not-based on the JSON-RPC error message.

---

## What is NOT in the stable surface

Listed here so clients know what to avoid binding to.

- **All `experimental` surfaces from [`inventory.md`](./inventory.md):** browser/CDP, Company Mode, company A2A. These may move within v3.x and need feature-detection.
- **All `internal` surfaces from [`inventory.md`](./inventory.md):** `daemon.*`. Use the pane/terminal/workspace surfaces instead.
- **Renderer-internal IPC channels:** `pane:*`, `workspace:*` via the Electron preload bridge. Not reachable over the public JSON-RPC surface; external tooling must not rely on them.
- **Implementation-internal IDs:** `paneId` and `ptyId` are stable only within a single daemon run (`bootId` window). Clients that persist these must reconcile via `pane.list` on `bootId` mismatch.
- **Specific cursor numeric values:** treat as opaque. The fact that `nextCursor` is monotonic int64 today is an implementation detail.
- **CLI flag set (beyond `wmux mcp`):** the full `wmux <command> --json --format` standardization lands in v3.1.

---

## Forward-compatibility contract for clients

A v3.0-aware client that follows these patterns is guaranteed to work across all v3.x releases:

1. **Use only the methods in this document.**
2. **Ignore unknown fields in returned objects.** Don't assume the shape is exhaustive.
3. **Feature-detect via `system.capabilities`** rather than parsing version strings.
4. **Pass `nextCursor` back unchanged.** No arithmetic, no comparisons.
5. **Compare `bootId` on every `events.poll` / `pane.list` response.** Mismatch ⇒ drop caches.
6. **Reconcile on `resync: true`.** Call `pane.list` to rehydrate; resume polling at `asOfSeq`.
7. **Handle unknown JSON-RPC error codes** as "this call didn't succeed; check the message; retry if the message suggests it."
8. **For metadata writes, prefer `expectedVersion` when concurrency matters** and skip it when you're the only writer.

These are the patterns the v3.0 [`../PROTOCOL.md`](../PROTOCOL.md) elaborates on.
