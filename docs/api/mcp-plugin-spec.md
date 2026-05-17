# wmux MCP Plugin Specification

> **Status:** Draft 1 (Phase 2.1 first PR — identity + declaration wired, enforcement deferred to follow-up PR).
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
| Trusted plugin re-declares a widened capability set | Status is preserved (`trusted` stays `trusted`) and `declaredCapabilities` is overwritten wholesale. In this record-only PR the field is unread, so the widening is dormant. **The follow-up enforcement PR MUST detect set-difference vs the previously approved capabilities and demote to `unconfirmed`** before honouring the new surface. Tracked at `applyDeclaration` in `src/main/mcp/PluginIdentity.ts`. |
| Hostile `clientName` (`__proto__`, `toString`, multi-MB string) | Trust DB stores plugin records in a null-prototype map and clamps names to `MAX_PLUGIN_NAME_LEN = 256`. Prototype keys cannot collide with `Object.prototype`; oversize names are truncated, never rejected, so the audit trail is preserved. |

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
- The persisted record preserves the raw strings the plugin sent so future parsers can re-validate against an updated grammar.
- `rationale` is optional, surfaced verbatim in the future approval dialog. Omitting it on a re-declaration **clears** any previously stored rationale — the trust DB always reflects the most recent declaration, not a cumulative history.

### 4.3 Trust states

A `PluginIdentityRecord` carries a `status` field:

| Status | Meaning | Set by |
|---|---|---|
| `unconfirmed` | Identity recorded; user has not seen or approved the plugin yet. | First-contact RPC. |
| `trusted` | User approved the declared capability set. | Future PR (approval dialog). |
| `denied` | User rejected the plugin. | Future PR. |
| `legacy` | Identity inferred from RPC traffic with no `clientName` envelope (pre-v2.10 callers, non-MCP clients). | RPC dispatch fallback. |

Transitions in the first PR are limited to `legacy → unconfirmed` (when a previously-legacy plugin learns to send `clientName`) and `lastSeen` refreshes within the same status. User-issued `trusted`/`denied` cannot regress to `unconfirmed`.

### 4.4 Trust DB location

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
