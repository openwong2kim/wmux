# wmux MCP Plugin Specification

> **Status:** Draft 2 (Phase 2.1 follow-up — trust-DB invariants tightened: widening-demotion, LRU eviction, structured rejection, transport-close identity clear. Method-dispatch enforcement still deferred to a later PR).
> **Audience:** authors of MCP servers and clients that connect to wmux.
> **Companion docs:** [`PROTOCOL.md`](../PROTOCOL.md) §4 (permission enforcement), [`api/versioning.md`](./versioning.md), [`api/stability.md`](./stability.md).

This document is the contract between wmux and external MCP clients that act as **plugins**. A plugin is any MCP client that connects to the wmux MCP server over stdio (Claude Code, Cursor, Codex, OpenClaw, custom integrations). wmux does not spawn plugins; plugins connect to wmux.

If you are building a tool that integrates with wmux, this is your starting point.

---

## 1. What is an MCP plugin in wmux?

wmux is a substrate, not a plugin host. The MCP server bundled with wmux (`src/mcp/index.ts`) exposes the substrate surface to any MCP-capable client. A "plugin" in wmux is therefore an **MCP client that has registered its identity with the substrate and declared which capabilities it intends to use**.

There is no separate plugin manager, no `wmux-plugin.json`, no `wmux plugin install` command. The plugin model rides the existing MCP protocol surface; substrate adds:

1. A grammar (`wmuxPermissions`) for plugins to declare their intent.
2. Two RPCs (`mcp.identify`, `mcp.declarePermissions`) for plugins to send that declaration.
3. A trust database (`~/.wmux/plugin-trust.json`) for the substrate to remember the declaration across reconnects.

The first-PR scope is record-only. Enforcement (rejecting calls that exceed declared permissions, prompting the user for approval) lands in a follow-up PR.

---

## 2. Identity

### 2.1 Source

Plugin identity is the `clientInfo.name` field from the MCP `InitializeRequest`. The MCP protocol requires this field on every initialize request; wmux trusts the value the client sends.

The wmux-bundled MCP server (`src/mcp/index.ts`) captures `clientInfo.name` and `clientInfo.version` automatically and forwards them to substrate via the `mcp.identify` RPC. Plugins that connect through their own MCP server may call `mcp.identify` explicitly.

### 2.2 Wire format

Every JSON-RPC request to wmux MAY include two optional envelope fields:

```jsonc
{
  "id": "uuid",
  "method": "pane.list",
  "params": { /* ... */ },
  "token": "<wmux auth token>",
  "clientName": "claude-ai",      // declared plugin identity
  "clientVersion": "1.0.94"       // optional
}
```

Requests without `clientName` are recorded as `legacy` so the substrate can grandfather them or prompt the user during the follow-up PR.

### 2.3 Threat model

> **The substrate trusts the declared name. It does not verify the name.**

There is no root-of-trust today: any process holding the wmux auth token can claim any `clientName`. The current threat model accepts this because:

1. The wmux auth token is itself a local secret protected by OS file permissions; a process that has it has already cleared the substrate's authentication bar.
2. The intended security boundary is **user-driven approval** of declared capabilities, not cryptographic identity. The user reads the displayed name and decides whether to trust it.
3. Future hardening (wmux-issued plugin tokens, signed manifests) is on the v3.1+ roadmap.

Known spoofing scenarios:

| Scenario | Substrate behavior |
|---|---|
| Two processes both claim `clientName: "claude-ai"` | Both write to the same trust-DB entry; `lastSeen` reflects the most recent contact. capability declarations overwrite each other (last writer wins). |
| Plugin claims a different name in different RPCs | Each name is recorded independently. The substrate does not cross-check or pin identity within a connection in this first PR. |
| Plugin claims `wmux` (the bundled identity) | Allowed today. Future enforcement may reject reserved names. |
| Trusted plugin re-declares a widened capability set | Substrate computes `set-difference(new, old)` on the raw declaration strings. Any capability not present in the previously approved set demotes status `trusted → unconfirmed`. Same-set or narrowed re-declarations preserve `trusted`. `denied` is never re-promoted by either path. Implemented in `applyDeclaration` (`src/main/mcp/PluginIdentity.ts`). |
| Hostile `clientName` (`__proto__`, `toString`, multi-MB string) | Trust DB stores plugin records in a null-prototype map and clamps names to `MAX_PLUGIN_NAME_LEN = 256`. Prototype keys cannot collide with `Object.prototype`; oversize names are truncated, never rejected, so the audit trail is preserved. |
| Hostile churn under fresh names (a process re-handshakes with a new `clientName` every reconnect) | DB-wide LRU cap (`MAX_PLUGIN_TRUST_ENTRIES = 1024`) bounds growth. Eviction order: `legacy` first, then `unconfirmed`, both by oldest `lastSeen`. `trusted` and `denied` are **never** evicted — user-curated state is sticky even if it overflows the cap. |

Plugins SHOULD pick a stable, namespaced identity (`my-org.my-tool`, not `tool`) so user-issued trust state survives upgrades.

---

## 3. `wmuxPermissions` grammar

### 3.1 Shape

`<capability>[:<path-glob>]`

- `capability` is drawn from a finite whitelist (§3.2).
- `path-glob` is optional and scopes the capability to a subset of the substrate surface.
- The separator is the **first** `:` in the string. Additional `:` characters inside the glob are treated as literal characters (regex-escaped during compilation), so values like `meta.write:custom.foo:bar` parse to capability `meta.write` and glob `custom.foo:bar`.

Examples:

| String | Meaning |
|---|---|
| `pane.read` | Read pane state and metadata for any pane in the plugin's workspace. |
| `meta.write` | Write any pane's metadata (top-level fields + entire `custom` object). |
| `meta.write:custom.dashboard.*` | Write only `custom.dashboard.<anything>` paths. |
| `meta.write:custom.dashboard.**` | Same, but `**` also crosses `.` so nested keys match. |
| `events.subscribe:pane.*` | Subscribe to `pane.created`, `pane.closed`, `pane.focused`, `pane.metadata.changed`. |

### 3.2 Capability whitelist (v3.0)

```
pane.read           pane.write          pane.create         pane.delete
pane.search

meta.read           meta.write

events.subscribe

workspace.read      workspace.claim

terminal.send       terminal.read

browser.navigate    browser.click       browser.type
browser.screenshot  browser.evaluate    browser.read

a2a.send            a2a.execute         a2a.read
```

Reserved prefixes (declaring these is always rejected):

- `wmux.*` — substrate-internal surface.

### 3.3 Path-glob rules

The path-glob is intentionally narrow — wmux does not import `minimatch` or any glob library to keep the substrate dependency surface small.

- `*` matches any run of characters **except** `.` (the path separator stand-in).
- `**` matches any run of characters **including** `.`.
- Everything else is a literal regex match. `.` is a literal separator.
- The match is anchored — the glob must consume the whole path.

The reference implementation is `globToRegex` in `src/main/mcp/permissionGrammar.ts`. Plugins SHOULD treat the glob as advisory in the first PR (no enforcement yet) but emit valid grammar so they're ready for the follow-up.

### 3.4 Metadata path namespace

`meta.read` and `meta.write` use dotted JSON paths into `PaneMetadata` (`src/shared/types.ts`) as the path-glob namespace:

| Path | Field | Owner |
|---|---|---|
| `label` | shared display label | shared |
| `role` | shared semantic role | shared |
| `status` | shared status string | shared |
| `custom.<key>[.<subkey>...]` | tool-owned subtree (`custom: Record<string, string>`) | declaring plugin |

Default rule:

- `meta.write` (no `:glob`) authorizes writes to **every** metadata path, including shared display fields.
- `meta.write:custom.myPlugin.*` authorizes writes to `custom.myPlugin.<single-segment>` only. Shared fields (`label`, `role`, `status`) and other plugins' `custom.*` subtrees are rejected at enforcement.
- A plugin that needs a specific shared field declares it explicitly (e.g. `meta.write:status` for a health monitor, or `meta.write:label` for a labeller). Plugins that want all shared fields request the unscoped `meta.write` and accept the broader approval prompt.
- `meta.read` follows the same namespace and default rule on the read side.

`updatedAt` is substrate-maintained and not writeable by plugins regardless of declared `meta.write` glob.

### 3.5 Event topic namespace

`events.subscribe` uses dot-separated event topic names as the path-glob namespace. The substrate intentionally uses one capability + topic glob rather than minting a new capability per event type, so the event surface can grow without expanding the whitelist.

| Glob | Matches |
|---|---|
| `events.subscribe` | every event topic (broad) |
| `events.subscribe:pane.*` | `pane.created`, `pane.closed`, `pane.focused`, `pane.metadata.changed` |
| `events.subscribe:pane.metadata.changed` | only that single topic |
| `events.subscribe:pane.metadata.**` | metadata events (depth-tolerant) |
| `events.subscribe:process.*` | `process.started`, `process.exited` |
| `events.subscribe:agent.lifecycle` | the single `agent.lifecycle` topic (sub-kind rides in payload) |

Current top-level event topics (see `src/shared/events.ts` `WmuxEventType` for the authoritative union): `pane.created`, `pane.closed`, `pane.focused`, `pane.metadata.changed`, `workspace.metadata.changed`, `process.started`, `process.exited`, `agent.lifecycle`. New topics are additive and matched by the same glob namespace; plugins SHOULD declare the broadest glob they're willing to be approved against.

### 3.6 Terminal-content risk class

`terminal.read` and `pane.search` are classified as **terminal-content** capabilities — declaring either grants the plugin visibility into user terminal sessions (`pane.search` returns matched logical lines plus up to two surrounding context lines, 500-char truncated). This risk class is categorically distinct from metadata and event access.

The future approval dialog (next PR) SHOULD surface terminal-content capabilities with stronger user-facing language than metadata or event capabilities, so the asymmetry stays visible to the user at approval time.

`terminal.send` is also high-risk (it writes input to a live pane) and gets its own approval prompt.

---

## 4. Declaration flow

### 4.1 First contact

Plugins announce themselves once per connection lifetime. The wmux-bundled MCP server does this automatically via its `oninitialized` hook; external MCP clients SHOULD call `mcp.identify` themselves right after their initialize handshake.

```
mcp.identify({
  name: "my-org.my-tool",
  version: "1.2.0"
})
```

Returns the current `PluginIdentityRecord` (creating a fresh `unconfirmed` entry if this is first contact, refreshing `lastSeen` if not).

### 4.2 Permission declaration

Plugins declare the full capability set they expect to use:

```
mcp.declarePermissions({
  permissions: [
    "pane.read",
    "meta.write:custom.my-org.*",
    "events.subscribe:pane.*"
  ],
  rationale: "Tracks pane lifecycle for the my-org dashboard."
})
```

Behaviour:

- The entire array is parsed against §3. If **any** entry is malformed, the whole declaration is rejected — plugins cannot half-declare.
- Accepted declarations overwrite any prior declaration from the same `clientName`. There is no union/merge in the first PR.
- Leading and trailing whitespace on each entry is stripped before storage so that cosmetic reformatting (e.g. trailing newlines from a codegen template) does not register as a capability change. The widening detector in §2.3 operates on the stored (trimmed) form, not the wire form.
- The persisted record preserves the (trimmed) strings the plugin sent so future parsers can re-validate against an updated grammar.
- `rationale` is optional, surfaced verbatim in the future approval dialog. Omitting it on a re-declaration **clears** any previously stored rationale — the trust DB always reflects the most recent declaration, not a cumulative history.

Result shape is a discriminated union:

```jsonc
// Acceptance — every entry parsed and the declaration was persisted.
{ "ok": true,
  "identity": { /* PluginIdentityRecord */ },
  "accepted": ["pane.read", "meta.write:custom.my-org.*"] }

// Rejection — at least one entry failed grammar; nothing was persisted.
{ "ok": false,
  "errors": [
    { "index": 1, "permission": "pane.teleport",
      "reason": "unknown capability \"pane.teleport\"" }
  ] }
```

`index` is the 0-based position in the original `permissions` array. `index: -1` is reserved for top-level shape errors (e.g. `permissions` not an array). The RPC envelope itself stays `ok: true` whenever the call reached the handler — the application-level outcome rides in `result.ok` so plugins can distinguish "wmux is unreachable" from "wmux declined our declaration."

### 4.3 Trust states

A `PluginIdentityRecord` carries a `status` field:

| Status | Meaning | Set by |
|---|---|---|
| `unconfirmed` | Identity recorded; user has not seen or approved the plugin yet. | First-contact RPC. |
| `trusted` | User approved the declared capability set. | Future PR (approval dialog). |
| `denied` | User rejected the plugin. | Future PR. |
| `legacy` | Identity inferred from RPC traffic with no `clientName` envelope (pre-v2.10 callers, non-MCP clients). | RPC dispatch fallback. |

Allowed automated transitions:

- `legacy → unconfirmed` — a previously-legacy plugin learns to send `clientName`.
- `trusted → unconfirmed` — a trusted plugin re-declares a **widened** capability set (any string not in the previously approved declaration). Same-set or narrowed re-declarations preserve `trusted`.
- Same-status `lastSeen` refresh.

Forbidden automated transitions (only the user-approval dialog can perform these — landing in a follow-up PR):

- `unconfirmed → trusted` / `unconfirmed → denied`
- `denied → anything` (never regresses)
- `trusted → trusted` after a widening (must demote and re-approve)

### 4.4 Enforcement contract (Phase 2.2)

Once a plugin has identified itself and declared its capability set, every subsequent RPC is gated against the trust record. The substrate either calls the handler (the plugin is `trusted` and the capability+path match its declaration), or it returns an `RpcResponse` failure with a structured `rejection` field carrying machine-readable detail.

**Mode flag.** `~/.wmux/config.json` carries an optional `mcp.mode` field:

```jsonc
{
  "version": 1,
  "daemon": { ... },
  "session": { ... },
  "mcp": { "mode": "enforce" }   // "shadow" | "enforce"
}
```

- Production wmux defaults to `enforce` (the v3.0 ship target).
- Dev wmux (electron-forge / `npm start` / `NODE_ENV=test`) defaults to `shadow` — rejection decisions are logged to `~/.wmux/shadow-rejections.log` but the handler still runs, so a bad delta during dogfood doesn't lock the developer out.
- Users can override either way explicitly via the config key.

**Wire shape.** The `RpcResponse` failure arm carries a `rejection?: RpcRejection` discriminated union (see `src/shared/rpc.ts`):

```ts
type RpcRejection =
  | { reason: 'capability-not-declared'; method; capability }
  | { reason: 'path-not-allowed'; method; capability; path; declared }
  | { reason: 'paths-partially-allowed'; method; capability;
      allowed: string[]; rejected: { path; declared }[] }
  | { reason: 'identity-status'; method; capability; status;
      pendingApproval?: { promptId } };
```

The existing `error: string` field carries a human-readable summary suitable for log output; clients that want per-path detail or want to drive an auto-retry loop branch on `rejection.reason`.

**`pendingApproval.promptId` retry idiom.** When a plugin tries to use a declared capability before the user has approved its declaration, the rejection carries:

```jsonc
{
  "ok": false,
  "error": "pane.list: awaiting user approval (promptId=abc123)",
  "rejection": {
    "reason": "identity-status",
    "method": "pane.list",
    "capability": "pane.read",
    "status": "unconfirmed",
    "pendingApproval": { "promptId": "abc123" }
  }
}
```

This is intentionally non-blocking — the substrate doesn't pin a socket waiting for the user's response (50-connection cap + renderer-stall fault tolerance + OAuth `authorization_pending` precedent). Plugins should:

1. Surface the `pendingApproval` state to their own user (e.g. "wmux is waiting for permission approval").
2. Retry the same RPC on a small backoff (1–5 s) until the response no longer carries `pendingApproval`.
3. If `rejection.status` flips to `denied` on a retry, stop — the user explicitly rejected the declaration and the substrate will continue to deny.

The `@wmux/orchestrator` SDK ships a `withApprovalRetry()` helper that wraps this idiom; external integrators can copy the pattern from the orchestrator README.

**Worked glob example.** A plugin declaring:

```
meta.write:custom.foo
```

is authorised to write to the EXACT path `custom.foo`. It is NOT authorised to write to `custom.foo.bar` — the substrate's `*` glob stops at the path separator. To match the whole subtree, declare either:

- `meta.write:custom.foo.*` — single-segment children (`custom.foo.x`, `custom.foo.y`).
- `meta.write:custom.foo.**` — full recursive subtree (`custom.foo.x.y.z`).

`meta.write` (no `:glob`) authorises every metadata path including shared `label`/`role`/`status`. Plugins should declare the narrowest glob that covers their actual writes — the approval prompt renders the declared globs verbatim so the user can verify scope.

**Multi-path partial rejection.** `events.poll` with multiple types in `params.types` is in `partial` multi-path mode: if some topics match the declaration and some don't, the wire returns `paths-partially-allowed` on the failure arm with `allowed: [...]` and `rejected: [...]` arrays. Clients should drop the rejected topics from their next poll. `pane.setMetadata` and `pane.clearMetadata` are `all-or-nothing` — any path miss wholesale-rejects the call (writes can't silently drop fields).

**Identity bootstrap exemption.** `mcp.identify`, `mcp.declarePermissions`, `system.identify`, and `system.capabilities` are exempt from the gate — they have `capability: null` in the method table. A plugin in `unconfirmed` or `denied` state can still call these to refresh its identity or query substrate capabilities; everything else returns a structured rejection.

### 4.5 Trust DB location

`~/.wmux/plugin-trust.json` (on Windows, `%USERPROFILE%\.wmux\plugin-trust.json`).

```jsonc
{
  "schemaVersion": 1,
  "plugins": {
    "claude-ai": {
      "name": "claude-ai",
      "version": "1.0.94",
      "declaredCapabilities": ["pane.read"],
      "status": "unconfirmed",
      "firstSeen": 1715800000000,
      "lastSeen": 1715800012345
    }
  }
}
```

- Written atomically via `atomicWriteJSON` (`src/daemon/util/atomicWrite/core.ts`).
- The wmux main process owns the file; no other process should write it.
- It is **not** a credential store. Treat it as user-readable index data.
- Capped at `MAX_PLUGIN_TRUST_ENTRIES = 1024` entries. The LRU evictor runs after every mutation; eviction prefers `legacy` over `unconfirmed`, both ordered by oldest `lastSeen`. `trusted` and `denied` entries are exempt — if user-issued state alone exceeds the cap, the DB is allowed to overflow rather than discard the user's decisions.

---

## 5. Lifecycle

| Phase | First PR | Follow-up PR |
|---|---|---|
| Install / first contact | `mcp.identify` records `unconfirmed`. | (same) |
| Capability declaration | `mcp.declarePermissions` records grammar. | (same) |
| User approval | Not yet — declarations sit at `unconfirmed`. | Approval dialog prompts user; status moves to `trusted` or `denied`. |
| Enforcement at method dispatch | None. | `denied` plugins blocked at RPC dispatcher; `unconfirmed` allowed (legacy grandfather). |
| Capability revocation | Manual edit of `plugin-trust.json`. | `wmux mcp permissions <name> --revoke <capability>`. |
| Identity rotation | Not supported — `name` is the trust key. | (same) |

---

## 6. Connection caps and resource limits

- `MAX_CONNECTIONS = 50` on the wmux Named Pipe / TCP fallback (`src/main/pipe/PipeServer.ts`). Each MCP plugin opens one or more transient sockets; the trust DB has no separate cap on **plugin count**, only on **active connections**.
- Per-socket rate limit: 50 RPC calls/sec. Global rate limit: 200/sec.
- Both limits are pre-`clientName` (rate is enforced on the wire, not the identity).

---

## 7. What's not in v3.0

- **wmux-issued plugin tokens** — substrate trusts declared `clientName` only.
- **Signed manifests** — no cryptographic check on declarations.
- **WASM sandbox** — plugins run as their own OS process; wmux does not isolate them.
- **Marketplace UI** — discovery is out-of-band (GitHub topic `wmux-plugin`).
- **Capability revocation CLI** — manual file edit only.
- **Per-connection identity pinning** — a plugin may rotate `clientName` mid-session in the first PR.
- **Trust-DB migration tools** — schema v1 only; future versions will define migrators.

---

## 8. Reference implementation

Substrate side:

- `src/shared/rpc.ts` — envelope types (`RpcRequest.clientName`, `PluginIdentityRecord`).
- `src/main/mcp/PluginIdentity.ts` — domain transitions.
- `src/main/mcp/permissionGrammar.ts` — grammar parser.
- `src/main/mcp/PluginTrustStore.ts` — atomic-write CRUD.
- `src/main/pipe/handlers/mcp.rpc.ts` — `mcp.identify` and `mcp.declarePermissions` handlers.

MCP-server side (the wmux-bundled MCP server, which is itself the reference plugin host):

- `src/mcp/index.ts` — `oninitialized` hook captures `clientInfo` and fires `mcp.identify`.
- `src/mcp/wmux-client.ts` — `setClientIdentity` stamps every outbound RPC envelope.

External plugin authors building their own MCP servers can copy the pattern: capture `clientInfo` from the MCP SDK, attach `clientName`/`clientVersion` to the wmux auth-token-bearing JSON-RPC payload, then call `mcp.identify` once.

### 8.1 Transport-close contract

When the MCP transport closes (process shutdown, SIGINT, host disconnect), the wmux-bundled MCP server calls `clearClientIdentity()` from `src/mcp/wmux-client.ts`. This drops the cached `clientName`/`clientVersion` from module scope so any trailing RPC traffic (e.g. cleanup work scheduled during the shutdown handler) stamps an envelope-less request and falls back to the substrate's `legacy` audit path instead of mis-attributing the call to a plugin that has already disconnected.

A reconnect MUST re-run the MCP initialize handshake to re-establish identity; there is no replay of cached identity across transport boundaries. External MCP servers SHOULD mirror this contract when implementing their own transport-close cleanup.
