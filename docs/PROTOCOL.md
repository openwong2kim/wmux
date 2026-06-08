# wmux Substrate Protocol

> **Status:** Draft 1 (Phase 0 deliverable for Substrate 3.0). Expanded during Phase 1 M3 as the M0 MetadataStore lands.
> **Audience:** plugin authors, dashboard builders, orchestrators, and anyone integrating wmux as a substrate.
> **Companion docs:** [`api/inventory.md`](./api/inventory.md), [`api/versioning.md`](./api/versioning.md), [`api/stability.md`](./api/stability.md).

This document is the substrate contract. It describes the wire-level rules that external tools rely on, in enough detail to write a correct client without reading wmux source code.

---

## 0. Foundational model

wmux is a **terminal substrate**: it owns panes, terminal I/O, and the event bus. It does not own workflow logic. External tools (MCP plugins, dashboards, orchestrators) build workflow intelligence on top of these primitives.

Three contract layers:

1. **State surface:** `PaneMetadata` (per-pane) and `WorkspaceMetadata` (per-workspace). Mutable. Reads return the latest committed state.
2. **Event surface:** an in-memory ring buffer of lifecycle events, polled via `events.poll`. Lets clients react without continuous state polling.
3. **Identity surface:** `workspaceId`, `paneId`, `ptyId`, `bootId`, MCP server name, and the Named Pipe token. Determines who is talking to whom and what state survives daemon restarts.

The protocol below is the contract between wmux and clients across these three layers.

---

## 1. PaneMetadata semantics

### 1.1 Layered status

PaneMetadata has two layers:

- **Top-level fields** (`label`, `role`, `status`) — *shared display vocabulary*. Any tool may read or write. Reflects the most relevant human-facing workflow state at any given moment. Used by current and future wmux UI surfaces (pane headers, search results, sidebars) and by other tools that want a quick read of "what's this pane doing."
- **`custom` object** — *tool-specific extension*. Opaque to wmux. Each tool writes under its own namespace; deep-merge ensures cooperating tools don't clobber each other's keys.

This split came out of the RFC #15 discussion. The principle:

> Top-level fields are read by humans and other tools at a glance. Tool-specific richness lives under `custom.<tool>.*` and is parsed only by the tool that wrote it.

Multiple tools may write to `status` (the shared top-level field). wmux does not mediate. The convention is **last writer wins** for the shared field, with each tool also keeping its own rich state under `custom.<toolName>.status` (or similar). Tools that need precedence enforcement coordinate among themselves; wmux does not enforce ownership.

Optimistic concurrency (§1.3) is the substrate-level primitive for coordination when two writers race on the same field.

### 1.2 Namespacing convention

`custom` is a flat `Record<string, string>` (one-level deep-merged on `setMetadata`). The convention for keys:

- `<toolName>.<keyName>` — e.g. `orchestrator.taskId`, `qa.status`, `dashboard.lastRender`.
- Keys without a dot are permitted but discouraged; they're prone to semantic collision across tools.
- Reserved namespaces:
  - `wmux.*` — reserved for wmux itself (currently unused, claimed for future protocol-level fields).
  - `wmux.<server-name>.*` — reserved for an MCP server with that name. Per-plugin identity (see §4) anchors the namespace.

Cooperating tools should agree on namespacing out-of-band. The substrate does not validate namespace ownership; that's a §4 permission concern, not a §1 contract concern.

### 1.3 Versioning and optimistic concurrency

Each pane's metadata has a monotonic `version: number`, starting at 0 (no metadata ever set) and incrementing by 1 on every successful `setMetadata` or `clearMetadata`.

**`expectedVersion` (optional):**

```jsonc
// pane.setMetadata params
{
  "paneId": "p-123",
  "workspaceId": "ws-1",
  "status": "running",
  "expectedVersion": 7   // ← optimistic-concurrency check
}
```

If the current version is not `7`, the call returns JSON-RPC error `-32001`:

```jsonc
{
  "id": "req-42",
  "ok": false,
  "error": "VERSION_CONFLICT",
  "currentVersion": 11   // ← actual current version
}
```

The caller decides whether to retry (after re-reading or re-merging) or surrender.

**Canonical retry pattern.** When a write returns `VERSION_CONFLICT`, the client should:

1. **Read the current version** via `pane.getMetadata` or `pane.list`. The response carries the post-conflict `version` and the committed `metadata`.
2. **Re-compute the intended patch** against the new base. The conflict means another writer committed between your prior read and your write — your patch may now collide with theirs, or may need to merge differently.
3. **Retry `pane.setMetadata`** with `expectedVersion: <current_version>`. If another concurrent writer commits again during step 2, this retry conflicts too; loop until success or surrender.

The loop is bounded by application policy, not the substrate. A typical client implementation:

```ts
async function setWithRetry(
  paneId: string,
  computePatch: (base: PaneMetadata) => Partial<PaneMetadata>,
  maxAttempts = 5,
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { metadata, version } = await rpc('pane.getMetadata', { paneId });
    const patch = computePatch(metadata);
    try {
      return await rpc('pane.setMetadata', {
        paneId,
        ...patch,
        expectedVersion: version,
      });
    } catch (err) {
      // v2.9.0 surfaces VERSION_CONFLICT as a substring of the error
      // message ("VERSION_CONFLICT (currentVersion=N)"). v2.9.1+ will
      // also expose it as a structured `code: 'VERSION_CONFLICT'`
      // envelope; clients that read the envelope SHOULD prefer that
      // path and fall back to substring matching for older daemons.
      if (!String((err as Error).message).includes('VERSION_CONFLICT')) throw err;
      // backoff + retry (jittered exponential is a reasonable default)
    }
  }
  throw new Error('setWithRetry: maxAttempts exceeded');
}
```

Notes:

- The substrate provides no built-in retry — clients own the loop because the right backoff, max attempts, and "give up" policy are tool-specific.
- `mergeMode: 'replaceShared'` (see §1.4) does NOT bypass conflict detection; it changes the merge semantics, not the version-bump contract.
- The `version` returned in a successful reply is always the post-commit version; use it as the next `expectedVersion` if you intend to chain writes without re-reading.

**`expectedVersion` omitted:** no check; the call always commits. This is the v2.x behavior and stays the default for clients that haven't migrated to optimistic concurrency.

**`expectedVersion: 0` semantics:** `0` is the correct guard for a pane that has never been written. The call succeeds iff no concurrent writer has set anything on this pane yet — i.e. the current stored version is also `0`. Use this when you want a write to land only on a "blank" pane (e.g. the first tool to claim a freshly-spawned pane) and you do not want to clobber state that another tool may have already written between your read and your write. If any prior write committed, the call returns `VERSION_CONFLICT` with `currentVersion >= 1`.

**Version is committed in the same transaction as the merged shape.** The `mergeMode` evaluation, validation, persistence, and event emission all happen inside one synchronous critical section in the main-process `MetadataStore` (single-threaded JS provides natural serialization). The `version` returned on a successful write is always the version of the post-merge shape; the `pane.metadata.changed` event carries the same value.

### 1.4 mergeMode semantics

The v3.0 wire format has three modes:

| `mergeMode` | Semantics |
|---|---|
| `'merge'` (default) | Patch-style. Top-level fields in the patch overwrite existing values. The `custom` object deep-merges one level: keys in `patch.custom` overwrite same-named keys in `existing.custom`; other existing keys are preserved. |
| `'replace'` | Full overwrite. The new metadata equals exactly `patch`; everything not in `patch` is dropped, including `custom`. |
| `'replaceShared'` | Replace top-level shared fields (`label`, `role`, `status`) but preserve `custom`. Intended for tools that want to take ownership of the shared display vocabulary without disturbing other tools' tool-specific state. |

Legacy `merge: boolean` parameter remains for backwards compatibility:

- `merge: true` ⇒ `mergeMode: 'merge'`
- `merge: false` ⇒ `mergeMode: 'replace'`

When both `merge` and `mergeMode` are present on the same request, `mergeMode` wins; the legacy `merge` field is ignored, not an error. The legacy field is preserved so v2.8.x clients continue to work unchanged, but new clients SHOULD send `mergeMode` only and stop emitting `merge`.

### 1.5 Validation

Inputs are validated before commit. Failures return a JSON-RPC error with a descriptive message and **do not** increment `version`. Limits live in [`api/stability.md`](./api/stability.md#validation-limits-v30-baseline-values).

**Single source of truth.** All metadata field validation — types, length caps for `label`/`role`/`status`, the `custom` key/value contract, and the total serialized-byte cap — happens inside `MetadataStore.set` and `MetadataStore.clear`. The RPC handler layer is responsible only for wire-shape normalization (paneId resolution, `mergeMode` and `expectedVersion` type checks, workspaceId scoping); it does not re-validate the payload before forwarding it to the store. Two parallel validators would be a substrate liability — shared constants and near-identical branches inevitably drift across PRs and silently shadow each other. Keeping validation in one place ensures the version bump and the validate step stay atomic in the same critical section, and there is exactly one error message per rejection class.

---

## 2. Event bus contract

### 2.1 Polling model

The event bus is **pull, not push**. Clients call `events.poll(cursor)`; the bus returns all events with `seq > cursor` (subject to filters), plus a new cursor and a `bootId`.

Stdio MCP transport doesn't carry server-initiated notifications cleanly, and `daemon.readPromptEvents` already establishes the pull pattern. The 1024-event ring covers minutes of typical activity; bursts beyond that surface as `droppedCount > 0` and trigger client-side reconciliation via §2.5.

### 2.2 Cursor is opaque

Today, `cursor` is a monotonic 64-bit integer assigned by the bus. **Clients must not depend on this.** The substrate guarantees only:

- `cursor: 0` always means "replay from oldest in the ring."
- `nextCursor` returned from `events.poll` is the right value to pass back on the next poll. Do not increment, sort, or compare it.
- `nextCursor` is monotonically non-decreasing across calls from the same client (strictly increasing only when new events were delivered). Specifically: `nextCursor >= priorCursor` always; `nextCursor > priorCursor` if and only if at least one event was scanned past the cursor (including filter no-matches, which still advance the cursor — see §2.3).

Future evolutions (sharded rings, segmented cursors) may change the underlying encoding without notice. Opaque-cursor clients are unaffected.

### 2.3 Filtered polling

`events.poll` accepts `types?: WmuxEventType[]` and `workspaceId?: string` filters. The cursor advances on **scanned** events, not just matched ones — a subscriber filtering for `process.exited` across a busy bus doesn't re-scan unmatched events on every poll.

### 2.4 `bootId` and daemon restart

`bootId` is a UUIDv4 stamped at `EventBus` construction. Every `events.poll` response, every `pane.list` response, and `system.capabilities().features.events.bootId` all return the same value for the lifetime of a main-process run.

**Mismatch across calls means the daemon restarted under the caller.** Required client action:

1. Drop all cached state — pane ids, pty ids, cursors, last-seen workspace metadata.
2. Re-hydrate via `pane.list` (returns a new `asOfSeq` and `bootId`).
3. Resume `events.poll` with `cursor: asOfSeq`.

`bootId` mismatch is a stricter signal than `resync: true`. Cursor-window drift is recoverable by re-polling; daemon restart invalidates the entire seq space.

**Atomicity:** the `bootId` is set once when `EventBus` is constructed. It does not change while the main process is alive; the construction happens before any RPC handler can return a response. Clients can rely on the value remaining constant across the lifetime of a successful connection.

### 2.5 Snapshot reconciliation (`resync: true` and `droppedCount`)

If the caller's cursor drifted past the ring window (`cursor + 1 < oldestSeq`) **or** is in the future (`cursor > latestSeq`), the response carries `resync: true`. The `droppedCount` field is set when the drift is past the ring window (the daemon knows exactly how many events were missed).

Required client action on `resync: true`:

1. Stop trusting cached pane state.
2. Call `pane.list` to get a fresh snapshot. The response carries `{ asOfSeq, bootId, panes }`.
3. If `bootId` differs from your last known value, treat as a daemon restart (§2.4): drop everything else cached too.
4. Resume `events.poll` with `cursor: asOfSeq`.

`pane.list` is the substrate's snapshot primitive. It returns the full pane tree with metadata + version per pane, plus the `asOfSeq` watermark that anchors event replay.

### 2.6 PollResult fields, full

```jsonc
{
  "events": [/* WmuxEvent[] with seq > effectiveCursor */],
  "nextCursor": 412,
  "priorCursor": 380,    // ← echoes the cursor you passed in
  "bootId": "550e8400-e29b-41d4-a716-446655440000",
  "droppedCount": 3,     // ← set if drifted past ring window
  "resync": true         // ← set if drift or future cursor
}
```

`priorCursor` and `droppedCount` are diagnostic — clients can log them to detect partner-side problems (the caller was paused, the bus was too small for the burst rate, etc.).

### 2.7 Ordering caveat

Event `seq` is monotonic in **arrival order**, not in **causal order**. Two independent producers (PTYBridge in main; paneSlice via preload IPC) write to the bus on different paths. Within one producer, order is preserved; across producers, a same-tick `pane.created` (renderer-published) and `process.started` (main-published) can land in the bus in either order.

Clients must not assume `seq` order implies causal order across producer boundaries. Use timestamps (`ts`) for cross-producer reasoning when ordering matters.

---

## 3. Snapshot envelope (`pane.list`)

`pane.list` is more than a list. It returns:

```jsonc
{
  "asOfSeq": 412,
  "bootId": "550e8400-e29b-41d4-a716-446655440000",
  "panes": [
    {
      "id": "p-1",
      "type": "leaf",
      // …tree structure…
      "metadata": { /* PaneMetadata */ },
      "version": 7                       // ← per-pane metadata version
    }
    // …more panes…
  ]
}
```

**Properties:**

- `asOfSeq` is the EventBus seq at the moment the snapshot was assembled. Events with `seq <= asOfSeq` are already reflected in `panes[*].metadata`; events with `seq > asOfSeq` are the next ones to consume via `events.poll(cursor: asOfSeq)`.
- `bootId` matches the EventBus's current value. Use it to detect daemon restarts.
- Snapshot is atomic from the client's perspective: the entire response is a consistent slice of state at `asOfSeq`. Internally, the M0 transaction-aware MetadataStore guarantees this — `pane.list` reads from a snapshot view of the store, not interleaved with concurrent writes.

This is the reconciliation primitive for §2.5.

---

## 4. Permission enforcement

The substrate has four enforcement points. All four exist to prevent one MCP from doing something it wasn't authorized to do.

| # | Point | Status | Notes |
|---|---|---|---|
| 1 | Method dispatch | Phase 2.1 follow-up (record-only in first PR) | `wmuxPermissions` declared via `mcp.declarePermissions` filters which RPC methods this plugin may call. Enforcement lands in the follow-up PR; the first PR only records declarations to the trust DB so plugins can wire grammar today. |
| 2 | Metadata path write | Phase 2.1 follow-up (record-only in first PR) | `meta.write[:<path-glob>]` scopes writes to specific `custom.<namespace>.*` paths. Same staging as #1. |
| 3 | Event subscription | Phase 2.1 follow-up (record-only in first PR) | `events.subscribe[:<type-glob>]` scopes which events `events.poll` may return. Same staging as #1. |
| 4 | Workspace claim | **v2.7.2 (already shipped)** | `mcp.claimWorkspace` binds a plugin to a workspace. Subsequent writes targeting other workspaces are rejected. Unrelated to `wmuxPermissions` grammar — predates it. |

### 4.1 Identity (Phase 2.1 first PR — shipped)

Plugin identity rides the JSON-RPC envelope as `clientName` (and optional `clientVersion`). The MCP server (`src/mcp/index.ts`) populates them from the MCP `InitializeRequest.clientInfo` so the substrate can attribute every call to a declared plugin. Identity is **declared, not verified** — there is no root-of-trust today; threat-model details live in `api/mcp-plugin-spec.md`.

Requests without `clientName` are recorded as `legacy` so future enforcement can grandfather them or prompt the user, never silently bypass.

The trust DB lives at `~/.wmux/plugin-trust.json` (atomic-write, single-process owner = wmux main). Per-plugin record shape (`PluginIdentityRecord` in `src/shared/rpc.ts`):

```jsonc
{
  "name": "claude-ai",          // MCP clientInfo.name
  "version": "1.0.94",          // MCP clientInfo.version (optional)
  "declaredCapabilities": ["pane.read", "meta.write:custom.dashboard.*"],
  "rationale": "Optional human-readable hint shown in the future approval UI",
  "status": "unconfirmed",      // unconfirmed | trusted | denied | legacy
  "firstSeen": 1715800000000,
  "lastSeen": 1715800012345
}
```

### 4.2 Declaration RPCs (Phase 2.1 first PR — shipped, record-only)

Plugins announce themselves with two RPCs. Both are idempotent and never reject existing user-issued trust state.

- `mcp.identify({ name, version? })` — fired automatically by the wmux-bundled MCP server when the MCP `InitializeRequest` completes. External plugins (non-wmux MCP servers) MAY call it explicitly.
- `mcp.declarePermissions({ permissions: string[], rationale? })` — plugin declares the full capability set it expects to use. Returns a discriminated union: `{ ok: true, identity, accepted }` on full acceptance, `{ ok: false, errors }` with per-entry `{ index, permission, reason }` when any entry fails grammar. Whole-declaration rejection — wmux does not partially accept. The RPC envelope stays `ok: true` whenever the call reached the handler; application outcome rides in `result.ok`.

#### Trust-DB invariants (Phase 2.1 follow-up — shipped)

- **Capability widening demotes `trusted`.** A re-declaration that introduces any capability string not present in the previously approved set drops status from `trusted` to `unconfirmed`. Subset / identical re-declarations preserve `trusted`. `denied` never regresses to `unconfirmed` regardless of re-declaration content.
- **LRU eviction caps trust-DB growth.** `MAX_PLUGIN_TRUST_ENTRIES = 1024`. When the cap is exceeded, the substrate evicts `legacy` entries first (oldest `lastSeen` first), then `unconfirmed`. `trusted` and `denied` are exempt — user decisions persist even if they overflow the cap.
- **Transport close clears in-process identity.** The wmux-bundled MCP server calls `clearClientIdentity()` from its `transport.onclose` handler so trailing RPC traffic stamps an envelope-less request and falls back to the substrate's `legacy` audit path. A reconnect must re-run the MCP initialize handshake.

### 4.3 `wmuxPermissions` grammar

`<capability>[:<path-glob>]`. Examples:

- `pane.read` — read pane state and metadata.
- `meta.write` — write any pane's metadata (top-level + custom).
- `meta.write:custom.dashboard.*` — write only the `dashboard.*` paths inside `custom`.
- `events.subscribe:pane.*` — subscribe to `pane.created`, `pane.closed`, `pane.focused`, `pane.metadata.changed`.

`wmux.*` is reserved. The complete capability whitelist, the path-glob rules (`*` excludes `.`, `**` includes it), and the threat model are in `api/mcp-plugin-spec.md`.

**Raw RPC bypass policy:** all four enforcement points are at method-dispatch level. There's no "internal" path that skips them; the IPC handler entry point is the chokepoint. The substrate does not expose a "trusted" mode that lets a plugin opt out of enforcement.

---

## 5. Named Pipe security model

The wmux daemon exposes the JSON-RPC surface over a Windows Named Pipe at `\\.\pipe\wmux-rpc-<token>`.

### 5.1 Token-based authentication

Every connection must present the token from `%APPDATA%\wmux\pipe-token` in the first request:

```jsonc
{
  "id": "req-1",
  "method": "system.identify",
  "params": {},
  "token": "<base64-encoded-token>"
}
```

The token is a random UUIDv4 (122 bits of entropy, via `crypto.randomUUID()`) generated on first daemon launch and persisted to disk; it is reused across boots and rotated only on explicit request (planned CLI: `wmux pipe rotate-token`). The file is written with `secureWriteTokenFile` and re-hardened on every load by `reHardenTokenFileAcl` — on Windows the DACL is rebuilt so the ONLY surviving entry is Full control for the owner: inheritance is disabled and discarded and every pre-existing ACE (inherited or explicit, including a broad `Everyone`/`Users` grant) is dropped. The rebuild uses the .NET `FileInfo.SetAccessControl` overload, which writes the DACL ONLY — never the owner/group/SACL — so it needs no privilege and works on the already-protected token left by older versions (a plain `Set-Acl` would throw `SeSecurityPrivilege`; a plain `icacls /grant:r` would leave an explicit broad ACE in place). The owner is identified by SID rather than `%USERNAME%` so that non-ASCII profile names are not mangled. On SKUs where PowerShell is unavailable the helper falls back to `icacls` (owner Full control, `/inheritance:r`, then explicit `/remove:g` of the well-known broad SIDs).

### 5.2 Connection cap

`MAX_CONNECTIONS = 50` concurrent client connections per daemon. A new connection beyond the cap is rejected immediately. The cap protects against runaway plugin scenarios where a misbehaving client opens connections in a loop.

### 5.3 Why not ACL the pipe itself?

The pipe is created with a default DACL that allows the current user's processes to connect. Earlier plans proposed restricting the pipe DACL further; that approach was retired because:

- The token model already provides per-process authentication independently of OS user identity.
- Windows pipe DACL semantics interact awkwardly with elevated processes (admin shells reaching a non-elevated wmux daemon and vice versa).
- Token rotation is a clean recovery primitive; DACL re-tightening requires daemon restart.

The current model is: OS isolates users, token isolates processes, `mcp.claimWorkspace` isolates workspaces within a process, and `wmuxPermissions` isolates capability classes within a workspace. Defense in depth, with the token acting as the primary security boundary.

### 5.4 What the token does NOT authenticate

- **Plugin identity beyond "you have the token."** Two MCP servers connecting with the same token are distinguishable only by the `system.identify` they declare. The `wmuxPermissions`-based plugin identity model is the v3.0 strengthening of this.
- **Workspace ownership.** Any token-holder can read any workspace's state by default. `mcp.claimWorkspace` is the opt-in scoping mechanism; tools that don't claim get read-only-style access to the full surface.
- **Transport encryption.** Named Pipe is a local IPC; the OS is the trust boundary. Cross-machine access would require a different transport (WebSocket + TLS, planned for v3.1+).

---

## 6. Identity model

| Identifier | Lifetime | Cache invalidation signal |
|---|---|---|
| `workspaceId` | persisted across daemon restarts | — (stable) |
| `paneId` | one daemon run | `bootId` change |
| `ptyId` | one PTY process | `process.exited` event |
| `bootId` | one main-process run | itself (mismatch = restart) |
| MCP server name | stable as long as the server is registered | re-registration |
| Pipe token | persisted on disk; rotated explicitly | token rotation event (planned) |

The two stable-across-restart identifiers are `workspaceId` and MCP server name. Everything else is single-run; clients must reconcile via `pane.list` after a `bootId` change.

### 6.1 `workspaceId` resolution paths

How an MCP server figures out which workspace it belongs to. This matters because every workspace-scoped permission check (§4 point #4) depends on the answer.

There are four resolution paths in the current implementation, in order of preference:

| # | Path | Source | Latency | Determinism |
|---|---|---|---|---|
| B | PID-tree walk via `a2a.resolve.identity` RPC | The MCP server asks the daemon for the current PID → `workspaceId` mappings, then walks its own process tree upward (up to 10 levels) looking for a match. The daemon's on-disk map stores PID → **ptyId** (immutable); the owning workspace is resolved **live** from the renderer (`input.findOwnerWorkspace`) on every call, so a re-minted workspace id never produces a stale identity. The PID query uses PowerShell `Get-CimInstance` on Windows or `ps -o ppid=` on POSIX. | First call ≈ 1–3 s on Windows (PowerShell startup); cached in-process afterwards. | Deterministic, and always reflects current ownership. |
| A | `WMUX_WORKSPACE_ID` env var (hint / last resort) | Set on the parent PTY by `PTYManager` at spawn time and inherited down the process tree (shell → Claude Code → MCP server child) when env passthrough holds. Used **only when path B yields nothing** — it is frozen at spawn time, so it goes stale the moment the workspace id is re-minted (daemon respawn / session restore) and is never cached as a confirmed identity. | Instant. | **Stale-prone** — a frozen create-time value; not authoritative. |
| C | `mcp.claimWorkspace` (external-caller fallback) | When paths B and A both fail (typical for an MCP server launched from a non-wmux terminal such as `cmd`, Windows Terminal, or VS Code's integrated terminal), the first pane-targeted tool call invokes `mcp.claimWorkspace`. The daemon spawns a dedicated background workspace named `MCP`, creates a PTY pane inside it, restores the previously-active workspace so the user's focus is not stolen, and pins the new `ptyId` for the MCP server's lifetime. | First claim ≈ 100–400 ms (workspace + PTY spawn). Subsequent calls hit the pin. | Deterministic per MCP server process. |
| D | `activeWorkspaceId` (renderer-side fallback) | A small number of legacy RPCs (notifications and some renderer-side surfaces) accept an optional `workspaceId` parameter; if omitted, the renderer falls back to `store.activeWorkspaceId`. This path predates `mcp.claimWorkspace` and survives in places that have not yet been migrated. | Instant. | **Non-deterministic — depends on whatever workspace the user is viewing at the moment of the call.** |

Path B is the substrate-aligned answer: it anchors identity to the immutable `ptyId` and resolves the owning workspace live, so it survives workspace-id re-minting. Path A is now a stale-prone hint, demoted to a last resort behind B (it previously short-circuited resolution, which left agents permanently stuck on a dead workspace id after a respawn/restore — "no workspace found for ws-…"). Path C covers non-wmux terminals; path D is the only remaining footgun and is the substrate boundary documented in §8.

**Substrate alignment notes:**

- Identity is anchored to `ptyId`, not `workspaceId`. The on-disk PID map (`~/.wmux/pid-map/<pid>`) stores the ptyId, which never changes for a process's lifetime; the pty → workspace edge is resolved live in `a2a.resolve.identity`. This is what keeps identity correct across a daemon respawn or session restore that re-mints the workspace id. The map is (re)written at PTY create and on reconnect.
- MCP resolvers never permanently trust the env hint: a non-empty `WMUX_WORKSPACE_ID` is validated against live ownership (path B) before use, and an RPC that reports a stale identity (`no workspace found` / `not owned by workspace`) invalidates the in-process cache so the next call re-resolves the live owner — self-healing without a restart.
- The two strict callers (A2A operations via `requireWorkspaceId`, and pane-targeted MCP tools via `resolveDefaultPtyId`) refuse to fall back to path D. They either return a deterministic id from B/A/C, or they fail with an explicit error rather than silently routing to whatever pane the user is viewing.
- Env propagation is best-effort. wmux sets `WMUX_WORKSPACE_ID` at the PTY layer, but the substrate cannot enforce that intermediate processes (shells, Claude Code, language runtimes) pass it through, and even when it does the value can be stale. Path B exists precisely because env is neither a contract nor authoritative.
- The PowerShell-based PID-tree walk has a first-call latency. A native PID-parent API call (e.g. cached `ProcessSnapshot` in the daemon) is a v3.x optimization candidate, not a v3.0 blocker.

---

## 7. Daemon lifecycle & resource floors

§§1–6 cover the state, event, and identity surfaces. This section covers the daemon **lifecycle** and the **config contract** that parameterises it.

The governing principle mirrors the neutrality of the other surfaces. The substrate enforces **resource floors** — configurable, triggered by measured pressure or count, and resolved by *refusing* new work or *garbage-collecting* dead artifacts. It never evicts a *live* session because of idle-time or age. Idle/age eviction is workflow policy and lives in an outer layer (§8).

### 7.1 Three tiers

| Tier | Owner | Behaviour |
|---|---|---|
| **1 — Mechanism** | substrate, no knob | create / destroy / attach / detach; persist-across-detach + recover; **exit-empty** — the daemon exits after a grace window once *zero* live sessions remain. This fires on count == 0 (the daemon has nothing to hold), never on idle-time. |
| **2 — Resource floor** | substrate, **configurable threshold** | `maxSessions` cap → refuse new with `RESOURCE_EXHAUSTED` (never evict existing); memory-pressure ladder → warn, then GC dead tombstones, then refuse new (never kill live); dead/suspended **tombstone GC** on a configurable TTL. |
| **3 — Policy** | outer layer (GUI / plugin / operator), off by default | idle-session reaping, suspend-on-idle, age-based eviction of *live* sessions, "kill oldest to make room". The substrate's only role is to expose the facts and the `destroySession` mechanism; the decision lives here. **Not in the substrate.** |

A Tier-2 floor is legitimate substrate only because its threshold is a knob, not a literal, and it reacts to measured pressure/count (or GCs an artifact with no live process behind it) — never to idle-time, age, or intent. Reaping a dead/suspended tombstone is garbage collection (no live process behind the retained metadata); reaping a *live* idle session would be eviction and belongs in Tier 3.

### 7.2 Config contract

The daemon reads `~/.wmux/config.json`. Lifecycle knobs and their defaults:

| Key | Default | Floor / cap | Semantics |
|---|---|---|---|
| `daemon.idleShutdownMinutes` | `5` | `0` = off | exit-empty grace window (Tier 1). `0` keeps the daemon alive forever. |
| `daemon.memWarnMb` | `500` | floor 128, cap = physical RAM | RSS ≥ this → log a warning (Tier 2). |
| `daemon.memReapMb` | `750` | floor 192, cap = RAM | RSS ≥ this → GC DEAD tombstones. |
| `daemon.memBlockMb` | `1024` | floor 256, cap = RAM | RSS ≥ this → refuse new sessions until RSS recovers. A value below the floor is clamped **and logged at startup** — a block threshold under normal idle RSS would silently brick session creation. |
| `session.maxSessions` | `200` | floor 1, cap 10000 | hard cap on concurrent sessions; new-session creation throws `RESOURCE_EXHAUSTED` at the cap. Startup recovery derives its own soft cap as `min(maxSessions, 40)`, so a freshly lowered cap can never dead-mark persisted sessions. |
| `session.suspendedTtlHours` | `168` (7d) | floor 1, cap 8760 (1y) | a SUSPENDED tombstone idle longer than this is GC'd on the next load. |
| `session.deadSessionTtlHours` | `24` | — | a DEAD tombstone older than this is reaped. Captured **per session at create time**; a config change applies only to *new* sessions — existing tombstones keep their create-time value (no silent retroactive change). |

Contract rules:

- **Per-field backfill.** A config.json missing a lifecycle key gets that key filled from its default; a key with a garbage value is reset to its default **in isolation** — a single bad field never resets the whole file (whole-file reset stays reserved for core-structure breakage like a missing `pipeName`). `idleShutdownMinutes` is the one exception and keeps its pre-existing whole-reset-on-garbage validation.
- **Floors have no "off".** `0`/negative on a floor (`maxSessions`, the memory triple, `suspendedTtlHours`) clamps to the floor; "permanent" retention is a large value, not `0`. Only `idleShutdownMinutes` treats `0` as off.
- **Memory order invariant.** After per-field clamping the substrate enforces `memWarnMb ≤ memReapMb ≤ memBlockMb`, raising `reap`/`block` rather than lowering `warn`.
- **Operator contract, not wire contract.** These keys are a daemon **config** contract, distinct from the §1–§3 pane/event/identity **wire** contract — but still a contract: renaming a key or changing a default is a compatibility concern.

### 7.3 Lifecycle facts and events

The daemon tracks `createdAt`, `lastActivity`, and `state` (`attached` / `detached` / `suspended` / `dead`) per session, surfaced to the wmux main process via the internal `daemon.listSessions` RPC. A **client-facing** idle surface on the external event bus — an `idleSince` fact plus a `session.idleThresholdExceeded` event (emit-only; the substrate would never act on it) — is deferred to v3.1: no Tier-3 consumer exists yet, and wiring an unused event into the contract would be a proxy-metric anti-pattern. v3.0 ships the floors and the config contract; it emits no idle event.

---

## 8. Known limitations and v3.0 boundaries

Things external clients may run into that aren't bugs but are explicit substrate boundaries:

- **Workspace identity resolution has a non-deterministic fallback (path D).** See §6.1 for the full resolution chain. Paths A, B, and C are substrate-aligned and deterministic per MCP-server process. Path D — renderer-side `activeWorkspaceId` fallback for RPCs that omit `workspaceId` — survives in a small number of legacy call sites (notifications, some `useRpcBridge` surfaces) and resolves at request time to whichever workspace the user happens to be viewing. External callers SHOULD pass `workspaceId` explicitly to avoid path D entirely. The work item to remove path D from substrate-managed RPCs lands in Phase 2.1 as part of the four-enforcement-points implementation; code fix targets v2.10+ patch stream rather than v3.0 itself, since the doc'd workaround is one line for callers.
- **No buffer access yet.** `terminal.readEvents` covers structured prompt events; arbitrary scrollback buffer reads are partial via `input.readScreen`. The cross-workspace policy gate for full buffer access is a v3.1+ design item.
- **Cursor evolution.** The opaque-cursor guarantee is a forward-compat hedge. If sharded rings ship in v3.x, the encoding may change; opaque-cursor clients are unaffected by design.
- **Layered status precedence.** The substrate does not enforce precedence among writers of the top-level `status` field. Last writer wins. Tools that need precedence should coordinate via `custom.<tool>.status` and pick one tool to own the shared field.
- **Cross-producer ordering.** `seq` is arrival order, not causal order. See §2.7.
- **Lifecycle neutrality — the substrate enforces resource floors, never idle/age eviction.** The daemon refuses new sessions at `session.maxSessions` (`RESOURCE_EXHAUSTED`) and under memory pressure, and GCs dead/suspended tombstones on configurable TTLs — all count/pressure/GC-based. It never kills or suspends a *live* session because it has been idle or old. Idle-session reaping, age eviction, and "kill oldest to make room" are outer-layer policy (GUI app / plugin / operator): the substrate exposes the facts (`createdAt`, `lastActivity`, session `state`) and the `destroySession` mechanism, but the decision lives above it. See §7 for the tier model and config contract.

---

## 9. Change history of this document

| Version | Date | Notes |
|---|---|---|
| Draft 1 | 2026-05-12 | Phase 0 initial draft. Covers PaneMetadata layered status, mergeMode, version + expectedVersion, bootId, cursor opaqueness, snapshot envelope, permission enforcement (sketch), Named Pipe security model. Phase 1 M3 will expand. |
| Draft 2 | 2026-05-16 | Phase 1 M4 — adds §6.1 `workspaceId` resolution paths (env / PID-tree walk / `mcp.claimWorkspace` / legacy `activeWorkspaceId` fallback). §7 limitation entry rewritten to point at §6.1 and to define the path-D removal as a Phase 2.1 work item rather than a v3.0 blocker. |
| Draft 3 | 2026-05-18 | Phase 2.1 follow-up — §4.2 adds structured rejection result for `mcp.declarePermissions` (discriminated union with per-entry `errors`) and the trust-DB invariants subsection: capability-widening demotion, LRU eviction cap, transport-close identity clear. No method-dispatch enforcement yet. |
| Draft 4 | 2026-06-01 | Substrate 3.0 lifecycle boundary — adds §7 (daemon lifecycle three-tier model, config contract for the 5 new lifecycle knobs, lifecycle facts/event deferral to v3.1) and the §8 "Lifecycle neutrality" boundary entry. Documents resource-floor neutrality: substrate refuses/GCs on pressure/count, never evicts a live session on idle/age (that is outer-layer policy). Renumbered prior §7/§8 → §8/§9. |

This document evolves alongside the implementation. Changes that affect the wire contract require a major-version bump per [`api/versioning.md`](./api/versioning.md). Changes that clarify existing semantics ship in any release.
