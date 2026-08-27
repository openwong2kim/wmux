# Fable Window D1 — Event/API Schema Freeze

> Status: **FROZEN** as of 2026-06-11 (Fable window D1).
> Scope: the event/API surfaces that B-1 (plugin host), X1 (workspace context
> sidebar), and X2 (notification system) build against. Freezing these first
> lets B-1 start on D2 without waiting for the X1/X2 implementations.
>
> **Freeze rules**
> 1. Changes after D1 are **additive-only** (new optional fields, new event
>    types, new enum members at the *end* of unions).
> 2. Removing or renaming a frozen field is a breaking change and requires a
>    major-version plugin API bump.
> 3. Consumers (plugins, MCP clients, renderer) MUST ignore unknown fields and
>    unknown event types — forward compatibility is the consumer's job.
> 4. Every event flowing to plugins/MCP rides the existing EventBus
>    (`src/shared/events.ts`, poll via `events.poll`) — no second bus.

---

## 1. `notification.received` event (X2) — FROZEN

Terminal-emitted desktop-notification escape sequences (OSC 9 / OSC 777 /
OSC 99), parsed daemon-side next to the OSC 133 parser and projected onto the
EventBus. This is the single source for: pane attention ring, tab/sidebar
badges, Windows toasts, the X1 sidebar "latest notification" line, the S-C3
timeline, and the Notification Router plugin.

```ts
// src/shared/events.ts
export interface NotificationReceivedEvent extends WmuxEventBase {
  type: 'notification.received';
  ptyId: string;
  /** Which escape sequence produced this notification. */
  source: 'osc9' | 'osc777' | 'osc99';
  /** Sanitized title, or null when the sequence carried no separate title. */
  title: string | null;
  /** Sanitized body. Always non-empty (empty notifications are dropped). */
  body: string;
}
```

Daemon→main wire shape (parallel to `prompt.event`):

```ts
// shared/rpc.ts DaemonEvent
{ type: 'notification.event', sessionId, data: { source, title, body, ts } }
```

### Parsing rules (normative — see `src/main/pty/oscNotification.ts`)

| Sequence | Payload after `<code>;` | Rule |
|---|---|---|
| OSC 9 | `<body>` | Whole payload is the body, `title = null`. **ConEmu guard**: a payload whose first `;`-segment is a 1–2 digit number (`9;4;1;50` progress etc.) is a ConEmu subcommand, not a notification → dropped. |
| OSC 777 | `notify;<title>;<body>` | First segment must be the literal `notify`, else dropped. Body may contain `;` (joined back). Title-only → body takes the title text, `title = null`. |
| OSC 99 | `<metadata>;<payload>` (kitty desktop-notification protocol) | Metadata is `:`-separated `k=v`. Supported keys: `i` (id, enables multi-chunk assembly), `d` (done, `0` = more chunks follow, default `1`), `p` (payload kind, `title` \| `body`; others ignored), `e` (`1` = payload is base64). Chunks with the same `i` accumulate until a `d≠0` chunk finalizes. |

Sanitization (applies to all three): C0/C1 control characters stripped,
title capped at 256 chars, body at 4096 chars, both trimmed; a notification
with an empty body after sanitization is dropped. OSC 99 assembly state is
bounded per PTY (max 8 pending ids, 8 KB per id; overflow drops the oldest).

Delivery invariants:
- Parsing happens once, in the process that owns the PTY (daemon by default,
  main in local mode). Both modes emit the identical EventBus shape.
- `notification.received` is **not** dedup-gated (unlike hook/detector
  lifecycle signals) — every sequence the program emits is an event.
  Rate-limiting/suppression is a *surface* policy (D8–9), not a bus policy.
- `workspaceId` scoping follows the same resolution as `agent.lifecycle`
  (drop if the owning workspace can't be resolved).

---

## 2. `workspace.context` (X1) — FROZEN

Aggregated live metadata for the sidebar, Fleet View (S-C1), and the plugin
SDK. Two layers:

**Daemon layer — per-session context (keyed by sessionId/ptyId).** The daemon
only knows sessions; workspace grouping happens in main. New push events ride
the existing DaemonEvent broadcast channel:

```ts
// shared/rpc.ts DaemonEvent additions (D6–7)
{ type: 'context.git',   sessionId, data: { branch: string | null; isWorktree: boolean } }
{ type: 'context.ports', sessionId, data: { ports: Array<{ port: number; pid: number }> } }
// cwd already exists: { type: 'cwd.changed', sessionId, data: string }
```

**Main layer — per-workspace aggregate.** Main folds session contexts into the
existing `WorkspaceMetadata` (extended additively) and publishes the existing
`workspace.metadata.changed` event — no new event type needed; plugins and the
sidebar subscribe to what already exists.

```ts
// src/shared/types.ts WorkspaceMetadata — additive extension (D6–7)
export interface WorkspaceMetadata {
  // ... existing frozen fields: gitBranch, cwd, listeningPorts,
  //     lastNotification, status, progress, agentName, agentStatus,
  //     notificationsMuted ...

  /** True when gitBranch comes from a linked worktree, not the main checkout. */
  gitIsWorktree?: boolean;
  /** PR for the current branch, from `gh pr status --json` (5 min TTL cache).
   *  Absent when gh is not installed or no PR exists. */
  pr?: { number: number; state: 'open' | 'draft' | 'merged' | 'closed';
         checks: 'pending' | 'passing' | 'failing' | null; url: string };
  /** Latest notification.received summary for the sidebar line. */
  lastNotificationText?: { ts: number; title: string | null; body: string;
                           source: 'osc9' | 'osc777' | 'osc99' };
  /** Unread notification count for non-visible workspaces. Reset by focus. */
  unreadNotifications?: number;
}
```

Resolution sources (normative for D6–7 implementation):
- `gitBranch`/`gitIsWorktree`: daemon `fs.watch` on `<cwd>/.git/HEAD` (and
  worktree `gitdir` indirection). **No polling.**
- `pr`: main-process `gh pr status --json` cache, 5 min TTL, silent absence
  when `gh` missing.
- `listeningPorts`: daemon PID tree (reuse identity PID map) →
  in-process listener-table snapshot (`GetExtendedTcpTable` via koffi — see
  `src/main/pty/winSnapshotNative.ts`, issue #1051), 10 s interval.
  (Resolution-source note only; the frozen wire shape above is unchanged.
  Originally read via a PowerShell cmdlet — replaced because the periodic
  spawn from an unsigned exe tripped Defender's behavioral heuristics.)
- `cwd`: existing OSC 7 + prompt-scrape dual path (fix `surface_list`
  staleness as part of D6–7).

---

## 3. `agent.lifecycle` — FROZEN (as shipped)

The shape in `src/shared/events.ts` (`AgentLifecycleEvent`: `ptyId`, `kind`,
`source: 'hook' | 'detector' | 'osc133'`, `agent: AgentSlug | null`,
`decision`, `exitCode?`) is frozen exactly as currently shipped (v3.0.0).
No D1 changes. Future additions (e.g. `source: 'osc9'`? — **no**: terminal
notifications are their own event type, see §1) must be additive.

---

## 4. Plugin permission model additions (B-1) — FROZEN

B-1 reuses the shipped enforcement stack unchanged: `PluginTrustStore`
(identity lifecycle legacy → unconfirmed → trusted/denied, widening
detection), `PermissionEnforcer` (pure allow/reject/partial), grammar
`<capability>[:<path-glob>]`.

### New capabilities (appended to the whitelist in mcp-plugin-spec §
"capability whitelist")

| Capability | Grants |
|---|---|
| `ui.sidebar` | Register a sidebar panel contribution (sandboxed iframe). |
| `ui.statusbar` | Register a status-bar widget. |
| `ui.pane-decoration` | Register pane badges/overlays. |
| `ui.commands` | Contribute command-palette entries. |
| `notifications.read` | Receive `notification.received` events via `events.subscribe` filtering. (Bare `events.subscribe` does NOT include notification events — they can contain terminal-program-controlled text, so they are opt-in.) |

UI capabilities are enforced at **contribution registration time** (the host
refuses to mount the iframe/widget), not per-message — once mounted, the
bridge enforces per-RPC capabilities exactly like MCP plugins today.

### Activation events

```
onStartup                      — app ready
onWorkspace                    — any workspace opened
onAgentDetected:<AgentSlug>    — AgentDetector gates the given agent
onEvent:<WmuxEventType>        — first event of that type (requires the
                                 matching read capability)
```

### postMessage bridge envelope (host ⇄ plugin iframe)

```ts
type BridgeEnvelope =
  | { v: 1; id: string; kind: 'request';  method: string; params?: unknown }
  | { v: 1; id: string; kind: 'response'; result?: unknown;
      error?: { code: string; message: string } }
  | { v: 1; id: null;   kind: 'event';    event: WmuxEvent }
  // Additive v1 extension (rule 1): host→plugin palette-command invocation.
  // `command` is the manifest `contributes.commands[].id`.
  | { v: 1; id: null;   kind: 'command';  command: string };
```

- `v` is the bridge protocol version; v1 frozen here. Unknown `kind` ignored.
- `method` names map 1:1 onto the existing RPC method space, so
  `methodCapabilityMap` applies verbatim — the iframe bridge is just another
  transport in front of the same `PermissionEnforcer`.
- iframe sandbox: `sandbox="allow-scripts"` only; no `allow-same-origin`.
  All host interaction goes through the envelope.

---

## 5. What D1 ships in code

Only the X2 parser core (hot path, longest soak time):
- `src/main/pty/oscNotification.ts` — `TerminalNotificationParser`
  (OSC 9 / 777 / 99 per §1, stateful OSC 99 assembly).
- Wiring in both PTY ownership modes: `DaemonPTYBridge` → `session:notification`
  → DaemonEvent `notification.event` → `DaemonClient` →
  `DaemonNotificationRouter` → EventBus; local-mode `PTYBridge` OSC switch.
- `notification.received` added to `src/shared/events.ts`.

Everything else in this document is schema-only until its scheduled day
(B-1: D2–4, X1 daemon core: D6–7, X2 surfaces: D8–9).
