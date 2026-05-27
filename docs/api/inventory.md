# wmux Public Surface Inventory

> **Baseline:** v2.8.4 (`main` @ c2fd6c6). Phase 0 deliverable for the Substrate 3.0 plan.
> **Purpose:** one document that lists every RPC method, MCP tool, and event type wmux exposes to external tooling, with a `stability` tier so consumers can plan around what is and isn't covered by the v3.0 contract.
> **Companion docs:** [`versioning.md`](./versioning.md) (semver + tier semantics), [`stability.md`](./stability.md) (v3.0 stable-surface guarantees), [`../PROTOCOL.md`](../PROTOCOL.md) (substrate contract).

---

## Stability tiers at a glance

| Tier | Meaning | Breaking-change policy |
|---|---|---|
| **stable** | Covered by the v3.0 substrate contract. Wire shape + semantics frozen. | Only on a major version bump. Additive changes (new optional fields, new event types) allowed within a major. |
| **experimental** | Shipped and supported, but the wire shape or semantics may evolve before being promoted to stable. Includes Company Mode and the browser/CDP surface. | Breaking changes allowed within a major; release notes flag them. |
| **internal** | Implementation detail. Not part of the external contract. Documented here only so external tooling knows what *not* to depend on. | May change without notice. |

The stability tier is reported by `system.capabilities` in v3.0 (planned addition). Today, callers can read this document as the source of truth.

---

## RPC methods (JSON-RPC over Named Pipe)

Transport: Named Pipe (`\\.\pipe\wmux-rpc-<token>`), token-authenticated (`PipeServer`). The MCP host hosts these as tools (see [MCP tools](#mcp-tools) below); other clients can connect directly with the token from `%APPDATA%\wmux\pipe-token`.

### Workspace surface

| Method | Params | Tier | Notes |
|---|---|---|---|
| `workspace.list` | — | stable | Returns all workspaces with their metadata. |
| `workspace.new` | `{ name?, cwd? }` | stable | Creates a new workspace. |
| `workspace.focus` | `{ id }` | stable | Switches the active workspace. |
| `workspace.close` | `{ id }` | stable | Closes a workspace (with PTY cleanup). |
| `workspace.current` | — | stable | Returns the active workspace id. |

### Surface (window) surface

| Method | Params | Tier | Notes |
|---|---|---|---|
| `surface.list` | — | stable | All wmux windows. |
| `surface.new` | — | stable | Opens a new wmux window. |
| `surface.focus` | `{ id }` | stable | Focuses an existing window. |
| `surface.close` | `{ id }` | stable | Closes a window. |

### Pane surface (the core substrate read/write)

| Method | Params | Tier | Notes |
|---|---|---|---|
| `pane.list` | `{ workspaceId? }` | stable | Returns `{ asOfSeq, bootId, panes }` envelope. `asOfSeq` is the EventBus seq at snapshot time; clients reconciling after `resync: true` drain events with `seq > asOfSeq`. `bootId` mismatch ⇒ drop all caches. |
| `pane.focus` | `{ id }` | stable | Focuses a leaf pane. |
| `pane.split` | `{ direction: 'horizontal' \| 'vertical' }` | stable | Splits the active pane. |
| `pane.setMetadata` | `{ paneId?, workspaceId?, label?, role?, status?, custom?, merge? }` | stable | External MCP callers SHOULD pass `workspaceId` (see `mcp.claimWorkspace`). `merge` defaults to true; `custom` deep-merges one level. **v3.0 will add `expectedVersion` and replace `merge: boolean` with `mergeMode: 'merge'\|'replace'\|'replaceShared'` (backwards-compatible).** |
| `pane.getMetadata` | `{ paneId?, workspaceId? }` | stable | Reads metadata for a leaf pane. |
| `pane.clearMetadata` | `{ paneId?, workspaceId? }` | stable | Drops all metadata for a leaf pane. |
| `pane.search` | `{ query, regex?, workspaceId? }` | stable | Cross-pane content search within a workspace. Scoped to the caller's workspace. |

Validation limits live in `src/shared/types.ts` (PANE_METADATA_MAX_BYTES, PANE_METADATA_LABEL_MAX, etc.) and are reported on validation failure.

### Event bus

| Method | Params | Tier | Notes |
|---|---|---|---|
| `events.poll` | `{ cursor?, types?, workspaceId?, max? }` | stable | Pull events with `seq > cursor`. Returns `{ events, nextCursor, priorCursor, bootId, droppedCount?, resync? }`. See [Event types](#event-types) below. Polling, not push — stdio MCP transport doesn't carry server-initiated notifications cleanly. |

### Terminal I/O surface

| Method | Params | Tier | Notes |
|---|---|---|---|
| `input.send` | `{ text, paneId?, workspaceId? }` | stable | Send literal text to a pane's PTY. |
| `input.sendKey` | `{ key, paneId?, workspaceId? }` | stable | Send a control key sequence. |
| `input.readScreen` | `{ paneId?, workspaceId? }` | stable | Read the current visible terminal buffer. |
| `terminal.readEvents` | `{ paneId?, workspaceId?, sinceSeq? }` | stable | Read structured terminal output events (prompt detection, etc.). |

### Identity & capability

| Method | Params | Tier | Notes |
|---|---|---|---|
| `system.identify` | — | stable | `{ app, version, platform, electronVersion }`. |
| `system.capabilities` | — | stable | Lists all registered RPC methods + feature flags. v3.0 will add a stability-tier map per feature. |
| `mcp.claimWorkspace` | `{ workspaceId }` | stable | An MCP client binds itself to a workspace. Subsequent metadata / event writes are scoped to it. Added in v2.7.2 to prevent active-pane hijacking by external MCPs. |

### Display vocabulary (shared workspace state)

| Method | Params | Tier | Notes |
|---|---|---|---|
| `notify` | `{ message, kind?, paneId?, workspaceId? }` | stable | OS notification + in-app banner. |
| `meta.setStatus` | `{ status, workspaceId? }` | stable | Workspace-level status (shared display field). |
| `meta.setProgress` | `{ progress, workspaceId? }` | stable | Workspace-level progress (shared display field). |
| `meta.setSkills` | `{ skills }` | stable | A2A agent self-description for `a2a.discover`. |

### Agent-to-Agent (A2A) surface

| Method | Params | Tier | Notes |
|---|---|---|---|
| `a2a.resolve.identity` | `{ workspaceId? }` | stable | Returns the canonical identity for a workspace's agent. |
| `a2a.whoami` | — | stable | The calling MCP's claimed identity. |
| `a2a.discover` | `{ filter? }` | stable | Lists other agents in the local wmux instance. |
| `a2a.task.send` | `{ to, kind, payload, requiresExecuteApproval? }` | stable | v2.7.3 added execute-approval gate (see memory `project_a2a_execute_gate.md`). |
| `a2a.task.query` | `{ id }` | stable | |
| `a2a.task.update` | `{ id, status, result? }` | stable | |
| `a2a.task.cancel` | `{ id }` | stable | |
| `a2a.broadcast` | `{ kind, payload }` | stable | |

### Browser / CDP surface

| Method | Params | Tier | Notes |
|---|---|---|---|
| `browser.open` | `{ url? }` | experimental | The browser/CDP surface backs the MCP `browser_*` tools. Wire shapes may evolve before v3.0. Currently the primary AI-agent capability driver, but not part of the substrate identity. |
| `browser.navigate`, `browser.goBack`, `browser.close` | various | experimental | |
| `browser.session.{start,stop,status,list}` | various | experimental | |
| `browser.type.humanlike`, `browser.type.cdp`, `browser.click.cdp`, `browser.press.cdp` | various | experimental | |
| `browser.cdp.target`, `browser.cdp.info` | various | experimental | |
| `browser.screenshot`, `browser.evaluate` | various | experimental | |

The full list lives in `src/shared/rpc.ts` (`ALL_RPC_METHODS`). For the MCP-facing tool names (which are the actual external API for most consumers), see [MCP tools](#mcp-tools).

### Daemon (internal IPC, not part of substrate contract)

| Method | Tier | Notes |
|---|---|---|
| `daemon.createSession`, `daemon.destroySession`, `daemon.attachSession`, `daemon.detachSession`, `daemon.resizeSession`, `daemon.listSessions`, `daemon.readPromptEvents`, `daemon.ping`, `daemon.shutdown`, `daemon.compact` | **internal** | Used by the wmux Electron client to manage the PTY daemon process. External tooling should not call these — use the pane/terminal surfaces instead. |

### Company Mode (deferred to Phase 4 gate)

| Method | Tier | Notes |
|---|---|---|
| `company.{create, destroy, status, addDept, removeDept, addMember, removeMember, broadcast, sendDept, sendMember, message, save, restore, templates, worktreeSetup, mergeDept, provision, provisionAll, provisionCeo}` | **experimental** | 3-tier orchestration (CEO → Department → Teammate). Per the Substrate 3.0 decision (memory `project_company_mode_vision.md`), Company Mode is being re-evaluated at the post-v3.0 gate as a first-party reference orchestrator on top of the substrate, not a core wmux feature. |
| `company.a2a.{whoami, send, broadcast, inbox, ack, status}` | **experimental** | Company-scoped A2A surface. |

---

## MCP tools

The wmux MCP server (hosted in-process, named-pipe transport to the daemon) exposes a curated subset of the RPC surface as MCP tools. Tool names match `mcp__wmux__<tool>` when used from a Claude Desktop / Claude Code client.

### Substrate surface (stable in v3.0)

| MCP tool | Backs RPC method | Notes |
|---|---|---|
| `pane_list` | `pane.list` | Returns the snapshot envelope `{ asOfSeq, bootId, panes }`. |
| `pane_get_metadata` | `pane.getMetadata` | |
| `pane_set_metadata` | `pane.setMetadata` | The substrate write entrypoint. |
| `workspace_list` | `workspace.list` | |
| `surface_list` | `surface.list` | |
| `terminal_read` | `input.readScreen` | |
| `terminal_read_events` | `terminal.readEvents` | Structured prompt-detected events. |
| `terminal_send` | `input.send` | |
| `terminal_send_key` | `input.sendKey` | |
| `wmux_events_poll` | `events.poll` | Pull-based event stream. |
| `wmux_search_panes` | `pane.search` | |
| `send_message` | (composite — combines `input.send` semantics) | |

### A2A surface (stable)

| MCP tool | Backs RPC method |
|---|---|
| `a2a_whoami` | `a2a.whoami` |
| `a2a_discover` | `a2a.discover` |
| `a2a_set_skills` | `meta.setSkills` |
| `a2a_task_send` | `a2a.task.send` |
| `a2a_task_query` | `a2a.task.query` |
| `a2a_task_update` | `a2a.task.update` |
| `a2a_task_cancel` | `a2a.task.cancel` |
| `a2a_broadcast` | `a2a.broadcast` |

### Company A2A (experimental)

| MCP tool | Notes |
|---|---|
| `company_a2a_whoami`, `company_a2a_send`, `company_a2a_broadcast`, `company_a2a_inbox`, `company_a2a_ack`, `company_a2a_status` | Company-scoped agent messaging. Behind the Phase 4 gate. |

### Browser / CDP (experimental)

| MCP tool family | Count | Notes |
|---|---|---|
| `browser_*` (open, close, navigate, navigate_back, screenshot, fill, type, click, hover, drag, press_key, scroll, scroll_into_view, snapshot, smart_snapshot, console, cookies, dialog, download, evaluate, extract_data, extract_text, file_upload, highlight, network, pdf, resize, response_body, select, session_list, session_start, session_status, session_stop, storage, tabs, trace, wait, wait_for_download, emulate) | ~40 | Wire shapes may evolve before v3.0. Backs Claude Code / Codex / Gemini CLI browser-control use cases. |

---

## Event types

The EventBus (`src/main/events/EventBus.ts`) is an in-memory ring buffer of `RING_CAPACITY = 1024` events with `POLL_DEFAULT_MAX = 256`. Workspace scoping is applied at poll time. Each main-process run has a `bootId` (UUIDv4) that invalidates client caches on daemon restart.

| Event type | Tier | Wire shape (key fields beyond `seq`/`ts`/`workspaceId`/`type`) |
|---|---|---|
| `pane.created` | stable | `paneId`, `parentBranchId?` |
| `pane.closed` | stable | `paneId` |
| `pane.focused` | stable | `paneId`, `previousPaneId?` |
| `pane.metadata.changed` | stable | `paneId`, `metadata: PaneMetadata` |
| `workspace.metadata.changed` | stable | `metadata: WorkspaceMetadata`, `patch: Partial<WorkspaceMetadata>` |
| `process.started` | stable | `ptyId`, `pid?`, `shell` |
| `process.exited` | stable | `ptyId`, `exitCode`, `signal?` |

**Ordering caveat:** `seq` is monotonic in **arrival order**, not in **causal order**. Two independent producers (PTYBridge in main process; paneSlice via preload IPC) write to the bus on different paths. Within one producer, order is preserved; across producers, a same-tick `pane.created` (renderer-published) and `process.started` (main-published) can land in the bus in either order. Clients must not assume seq order implies causal order across producer boundaries.

**v3.0 cursor contract** (planned, see [`../PROTOCOL.md`](../PROTOCOL.md)): cursor is **opaque**. Today it happens to be a monotonic 64-bit integer, but clients must pass back whatever `nextCursor` they received without interpretation. `cursor: 0` always means "replay from oldest in the ring."

---

## Identity / addressing model

| Identifier | Stable across daemon restarts? | Notes |
|---|---|---|
| `workspaceId` | yes (session-persisted) | Stable. External tools should claim via `mcp.claimWorkspace`. |
| `paneId` | no (invalidated on `bootId` change) | Recreated per main-process run. Persisted in `session.json` but new ids are minted if the session restore fails partially. |
| `ptyId` | no | One-to-one with PTY processes; lifetime tied to the underlying shell. |
| `bootId` | no — that's the whole point | Stamped at EventBus construction. Mismatch ⇒ client drops all cached pane/pty ids and cursors. |
| MCP server name | yes | Used as the v3.0 plugin namespace anchor (`wmux.<server-name>.*`). |
| Token (Named Pipe) | yes (rotated only on explicit rotate) | Persisted under `%APPDATA%\wmux\pipe-token` with OS ACL restriction. See [`../PROTOCOL.md`](../PROTOCOL.md) §Named Pipe security. |

---

## What's intentionally not in this inventory

- **Daemon internals.** `src/main/pty/*`, `src/main/session/SessionManager.ts` — these are reachable through the public surfaces above but their internal contracts are not part of the substrate.
- **Renderer-internal IPC.** The `pane:*` / `workspace:*` channels used between Electron main and the renderer process are not part of the external surface. External tooling reaches the same state through the RPC surface.
- **CLI commands.** `wmux <command>` flags are stabilized separately. v3.0 stabilizes the JSON-output mode of a small set (`wmux mcp`) and defers full `--json --format` standardization to v3.1.

---

## How this inventory is used downstream

- [`versioning.md`](./versioning.md) cites the tier column.
- [`stability.md`](./stability.md) freezes the "stable" tier subset as the v3.0 contract.
- [`../PROTOCOL.md`](../PROTOCOL.md) elaborates on the wire contract for the stable surfaces.
- `system.capabilities` will report the tier map programmatically in v3.0.

---

## Permission gate (Phase 2.2)

Every RPC method maps to a single declarative entry in `src/main/mcp/methodCapabilityMap.ts`. The enforcer (`PermissionEnforcer.check`) consults this table at dispatch time to decide whether the caller's declared `wmuxPermissions` cover the request. See [`mcp-plugin-spec.md` §4.4](./mcp-plugin-spec.md#44-enforcement-contract-phase-22) for the wire contract and retry idiom.

The capability column below summarises the table. Three sentinels:

- `null` — identity-bootstrap / system-introspection method; no capability required. Any caller can invoke regardless of trust state.
- `wmux.internal` — reserved-prefix capability that NO plugin can ever declare (`permissionGrammar.ts` rejects `wmux.*` at declaration time). Internal-only surfaces. Legacy callers (no `clientName` envelope) still grandfather through.
- `<capability>` — must match one of `KNOWN_CAPABILITIES` (spec §3.2).

### Capability map (subset — full table in code)

| Method | Capability | Path source | Risk class |
|---|---|---|---|
| `mcp.identify` | `null` (bootstrap) | — | — |
| `mcp.declarePermissions` | `null` (bootstrap) | — | — |
| `mcp.claimWorkspace` | `workspace.claim` | — | workspace |
| `pane.list` / `pane.focus` | `pane.read` | — | pane-lifecycle |
| `pane.split` | `pane.create` | — | pane-lifecycle |
| `pane.search` | `pane.search` | — | **terminal-content** |
| `pane.setMetadata` | `meta.write` | each present field → path | metadata |
| `pane.getMetadata` | `meta.read` | — (v3.0 reads whole record) | metadata |
| `pane.clearMetadata` | `meta.write` | shared paths (label/role/status) | metadata |
| `events.poll` | `events.subscribe` | `params.types` (`**` if absent) | events |
| `input.send` / `input.sendKey` | `terminal.send` | — | **terminal-input** |
| `input.readScreen` / `terminal.readEvents` | `terminal.read` | — | **terminal-content** |
| `meta.setStatus` / `meta.setProgress` / `meta.setSkills` | `meta.write` | — | metadata |
| `system.identify` / `system.capabilities` | `null` (bootstrap) | — | — |
| `browser.navigate` / `browser.open` / `browser.goBack` / `browser.close` | `browser.navigate` | — | browser |
| `browser.click.cdp` | `browser.click` | — | browser |
| `browser.type.humanlike` / `browser.type.cdp` / `browser.press.cdp` | `browser.type` | — | browser |
| `browser.screenshot` | `browser.screenshot` | — | browser |
| `browser.evaluate` | `browser.evaluate` | — | browser |
| `browser.session.status` / `browser.session.list` / `browser.cdp.target` / `browser.cdp.info` | `browser.read` | — | browser |
| `browser.session.start` / `browser.session.stop` | `browser.navigate` | — | browser |
| `a2a.whoami` / `a2a.discover` / `a2a.resolve.identity` / `a2a.task.query` | `a2a.read` | — | a2a |
| `a2a.task.send` / `a2a.task.update` / `a2a.broadcast` | `a2a.send` | — | a2a |
| `a2a.task.cancel` | `a2a.execute` | — | a2a |
| `workspace.list` / `workspace.current` | `workspace.read` | — | workspace |
| `workspace.new` / `workspace.focus` / `workspace.close` | `wmux.internal` | — | — |
| `surface.list` / `surface.new` / `surface.focus` / `surface.close` | `wmux.internal` | — | — |
| `daemon.*` | `wmux.internal` | — | — |
| `company.*` | `wmux.internal` | — | — |
| `notify` | `wmux.internal` | — | — |
| `hooks.signal` | `wmux.internal` | — | — |

Methods marked **bold** are surfaced in the approval dialog with stronger user-facing language (spec §3.6 — terminal-content / terminal-input risk classes).

The full machine-readable map (with path extractors and `multiPathMode` flags) lives at `src/main/mcp/methodCapabilityMap.ts`. `tsc --noEmit` enforces totality via `Record<RpcMethod, ...>` so a new RPC method without a map entry fails the build.
