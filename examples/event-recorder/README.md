# wmux event-recorder (reference plugin)

A small, standalone, dependency-free external plugin for the [wmux](../../README.md)
substrate. It connects to a running wmux over the local RPC pipe, subscribes to
the lifecycle event bus, and streams every event to an NDJSON file while
pretty-printing it to the console. Optionally it annotates the pane it is
watching with its own metadata.

This is the canonical "build a plugin against the substrate" example. It is
deliberately written without any dependencies (Node `net`/`fs`/`crypto` only)
so you can read every line and copy the pattern into your own tool. The
transport layer lives in [`wmux-rpc.mjs`](./wmux-rpc.mjs); the plugin logic
lives in [`recorder.mjs`](./recorder.mjs).

It exercises four substrate surfaces end-to-end:

| Surface | What the recorder does | Spec |
|---|---|---|
| Transport | Connect over the named pipe / unix socket / TCP fallback, auth with the token file | [`PROTOCOL.md` §5](../../docs/PROTOCOL.md) |
| Identity & permission | `mcp.identify` + `mcp.declarePermissions`, then the enforce-mode approval handshake | [`mcp-plugin-spec.md` §4](../../docs/api/mcp-plugin-spec.md) |
| Event bus | `events.poll` from cursor 0, opaque-cursor discipline, `bootId` restart detection, `resync`/`droppedCount` reconciliation via `pane.list` | [`PROTOCOL.md` §2, §3](../../docs/PROTOCOL.md) |
| Metadata | Optimistic-concurrency writeback of a shared `label` (shown in the pane header) + the recorder's own `custom.*` subtree | [`PROTOCOL.md` §1](../../docs/PROTOCOL.md) |

---

## Prerequisites

- **A running wmux** for the current OS user, with at least one workspace open.
  The recorder talks to the same daemon the GUI uses.
- **Node.js >= 18.** No `npm install` needed — there are no dependencies.

The recorder finds wmux automatically:

- **Token** — `WMUX_AUTH_TOKEN` if set (you are running inside a wmux pane),
  otherwise the file `~/.wmux-auth-token` (a plain UUID string, no JSON).
- **Endpoint** — `WMUX_SOCKET_PATH` if set, otherwise the platform default:
  `\\.\pipe\wmux-<username>` on Windows, `~/.wmux.sock` on POSIX.
- **TCP fallback** (Windows only) — if the pipe returns `EPERM`/`ENOENT`, it
  reads the port from `~/.wmux-tcp-port` and connects to `127.0.0.1:<port>`.

These are the exact rules wmux itself uses (`getPipeName` / `getAuthTokenPath` /
`getTcpPortPath` / `ENV_KEYS` in `src/shared/constants.ts`).

---

## Two trust modes

wmux records a per-plugin trust entry keyed on the `clientName` you send. There
are two ways to run the recorder.

### 1. Identity mode (the real pattern) — default

```powershell
node recorder.mjs --annotate
```

The recorder:

1. Calls `mcp.identify({ name: "wmux-examples.event-recorder", version })` —
   creates an `unconfirmed` trust entry on first contact.
2. Calls `mcp.declarePermissions({ permissions: [...], rationale })` — declares
   the capability set it intends to use.
3. Makes its first gated RPC (`workspace.list`).

In **enforce mode** (production wmux default), step 3 is rejected with
`rejection.reason === "identity-status"`, `status: "unconfirmed"`, and a
`pendingApproval.promptId`. wmux pops an approval dialog showing the declared
capabilities and rationale. The recorder logs:

```
[recorder ...] workspace.list: waiting for approval in the wmux UI (promptId=…)
```

and retries the same RPC on a 2-second backoff (the `withApprovalRetry` idiom —
see [`mcp-plugin-spec.md` §4.4](../../docs/api/mcp-plugin-spec.md)). Once you
**approve** in the wmux UI, the status flips to `trusted` and the retry
succeeds. If you **deny**, the next retry comes back with `status: "denied"` and
the recorder stops.

In **shadow mode** (dev wmux / `npm start` / `NODE_ENV=test` default), the
would-be rejection is logged server-side but the handler still runs, so the
recorder proceeds without an approval dialog. The mode is controlled by
`mcp.mode` in `~/.wmux/config.json` (`"shadow"` | `"enforce"`).

### 2. Legacy mode (grandfathered quick demo)

```powershell
node recorder.mjs --legacy --once
```

With `--legacy` the recorder sends **no** `clientName` envelope. The substrate
records such callers as `legacy` and grandfathers them through the permission
gate (this is exactly why the dynamic-verification scripts in `scripts/` work
against the production app without an approval prompt). No identity handshake,
no approval dialog. Use this for a fast smoke test or a throwaway demo.

> **Deprecated (#1111):** the `legacy` grandfather closes in the first release
> on or after **2026-09-30**. After that, `--legacy` is refused by the gate —
> use the identity mode above.

> The two modes differ only in whether the envelope carries `clientName`. The
> event-bus, metadata, and reconciliation logic is identical.

---

## Run commands (PowerShell)

```powershell
node recorder.mjs --legacy --once
```
Single poll, no identity, append to `./events.ndjson`, exit. Fastest smoke test.

```powershell
node recorder.mjs
```
Identity mode, poll all 8 event types every 1000 ms, append to `./events.ndjson`.

```powershell
node recorder.mjs --types agent.lifecycle,process.started,process.exited --interval 500
```
Watch only agent/process events, poll every 500 ms.

```powershell
node recorder.mjs --workspace ws-1 --annotate --annotate-every 5
```
Watch a specific workspace, and every 5 recorded events write a `label`
(`event-recorder: <count>`, visible in the pane header) plus
`custom.event-recorder.lastSeq` + `custom.event-recorder.count` onto the watched
pane (optimistic concurrency).

```powershell
node recorder.mjs --help
```
Full flag reference.

> Keep each command on one line — pasting a wrapped command into PowerShell can
> inject stray whitespace.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--legacy` | off | Skip identity/declare; send no `clientName` (grandfathered). |
| `--workspace <id>` | first from `workspace.list` | Workspace to watch. |
| `--types a,b,c` | all 8 | Comma-separated `WmuxEventType` filter. |
| `--out <path>` | `./events.ndjson` | NDJSON output file (append). |
| `--interval <ms>` | `1000` (min 50) | Poll interval. The floor keeps polls + annotate writes well under the 50 rpc/s socket cap. |
| `--annotate` | off | Write a shared `label` + the recorder's `custom.*` metadata onto the watched pane. |
| `--annotate-every <n>` | `10` | Annotate once per `n` recorded events. |
| `--once` | off | Single poll then exit. |
| `--help`, `-h` | — | Help text. |

The eight event types: `pane.created`, `pane.closed`, `pane.focused`,
`pane.metadata.changed`, `workspace.metadata.changed`, `process.started`,
`process.exited`, `agent.lifecycle` (`src/shared/events.ts`).

---

## Walkthrough (mapped to the spec)

### Transport — `PROTOCOL.md` §5

[`wmux-rpc.mjs`](./wmux-rpc.mjs) opens **one** persistent socket to the endpoint,
buffers incoming bytes and splits on `\n`, `JSON.parse`s each line, and
correlates responses to requests by `id`. Every outbound envelope is
`{ id, method, params, token, clientName?, clientVersion? }` and is terminated
with `\n` (envelope/auth: `PROTOCOL.md` §5.1; newline framing: `PipeServer.ts`).
An unauthenticated request gets a single `{ ok:false, error:'unauthorized' }`
reply and the server then destroys the socket, so the token is always attached.
On Windows, an
`EPERM`/`ENOENT` on the pipe transparently retries via the TCP loopback
fallback. The socket reconnects on close.

### Identity & permission — `mcp-plugin-spec.md` §4

In identity mode the recorder declares:

```js
permissions: [
  'events.subscribe',                    // gates events.poll
  'workspace.read',                      // gates workspace.list
  'pane.read',                           // gates pane.list
  'meta.read',                           // gates pane.getMetadata
  'meta.write:label',                    // gates writing the shared pane label
  'meta.write:custom.event-recorder.*',  // gates writing our own custom subtree
]
```

These capability strings come from the whitelist in
[`mcp-plugin-spec.md` §3.2](../../docs/api/mcp-plugin-spec.md) and map to RPC
methods via `src/main/mcp/methodCapabilityMap.ts`. Each method's required
capability must be declared, or the call is rejected with
`capability-not-declared` even after the plugin is trusted — that is why
`workspace.read` (for `workspace.list`) and `meta.read` (for `pane.getMetadata`)
appear here, not just the write capabilities. We scope each `meta.write` to the
narrowest glob we actually touch rather than requesting unscoped `meta.write` —
the approval prompt renders the declared globs verbatim, so a tight scope is
easier for a user to approve; the two `meta.write` entries union at enforcement
time, so one `pane.setMetadata` writing both `label` and
`custom.event-recorder.*` passes the path check. The result of
`mcp.declarePermissions` is a discriminated union: `{ ok:true, identity,
accepted }` on success, or `{ ok:false, errors:[{index,permission,reason}] }` if
any entry is malformed (the whole array is rejected — you cannot half-declare).

The enforce-mode approval handshake (`withApprovalRetry`) is described under
[Identity mode](#1-identity-mode-the-real-pattern--default) above.

### Event bus — `PROTOCOL.md` §2, §3

The recorder polls `events.poll({ workspaceId, cursor, types })` starting from
`cursor: 0` (replay from the oldest event still in the 1024-entry ring). The
returned `nextCursor` is **opaque** — the recorder passes it back verbatim and
never increments or compares it (`PROTOCOL.md` §2.2).

- **`bootId` change** ⇒ the daemon restarted under us. The recorder drops its
  cursor and re-hydrates from a fresh `pane.list` snapshot, re-anchoring to the
  snapshot's `asOfSeq` in the new boot's seq space (`PROTOCOL.md` §2.4).
- **`resync: true`** (with optional `droppedCount`) ⇒ the cursor drifted past
  the ring window. The reply still delivers the oldest page that survived in
  the ring, so the recorder writes that page first, continues from
  `nextCursor` (only the `droppedCount` events are actually lost), and
  refreshes its pane snapshot (`PROTOCOL.md` §2.5).

`pane.list` is the snapshot primitive: it returns `{ asOfSeq, bootId, panes }`,
where `asOfSeq` is the event watermark to resume polling from (`PROTOCOL.md` §3).

> **`agent.lifecycle` carries `ptyId`, not `paneId`.** If you need the paneId,
> resolve it once from `pane.list` and cache it (`src/shared/events.ts`).

### Metadata — `PROTOCOL.md` §1

With `--annotate`, the recorder demonstrates the write side. It reads the
current version via `pane.getMetadata`, then writes with
`pane.setMetadata({ label, custom, mergeMode: 'merge', expectedVersion })`. It
writes both a shared `label` (the top-level display field — last-writer-wins,
shown in the pane header) and its own namespaced `custom.event-recorder.*` keys;
`merge` patches exactly those paths and leaves every other field (and other
writers' `custom` subtrees) intact. If another writer raced it, the server
replies with an error whose message contains `VERSION_CONFLICT`; the recorder
re-reads the version and retries once (optimistic concurrency, `PROTOCOL.md`
§1.3).

### Workspace resolution — `PROTOCOL.md` §6.1

An external plugin launched from a non-wmux terminal has no workspace of its
own. This recorder is a pure **observer**: it calls `workspace.list` and filters
by id (`--workspace`, or the first workspace by default). A plugin that needs to
*act inside* a dedicated workspace instead would call `mcp.claimWorkspace`,
which spawns a dedicated `MCP` workspace + pane and pins it (`PROTOCOL.md` §6.1
path C).

---

## What you'll see

`--legacy --once` against a fresh workspace prints something like:

```
[recorder 2026-06-09T…Z] endpoint = \\.\pipe\wmux-rizz
[recorder 2026-06-09T…Z] mode = legacy (grandfathered)
[recorder 2026-06-09T…Z] types = pane.created,pane.closed,pane.focused,pane.metadata.changed,workspace.metadata.changed,process.started,process.exited,agent.lifecycle
[recorder 2026-06-09T…Z] out = ./events.ndjson
[recorder 2026-06-09T…Z] connected.
[recorder 2026-06-09T…Z] watching workspace: ws-1 (default)
[recorder 2026-06-09T…Z] pane.list (initial): bootId=550e8400… asOfSeq=12 panes=1 watchedPane=p-1
[recorder 2026-06-09T…Z] seq=1 pane.created ws=ws-1 pane=p-1
[recorder 2026-06-09T…Z] seq=3 process.started ws=ws-1 pty=pty-1 pid=12044 shell=pwsh.exe
[recorder 2026-06-09T…Z] --once: recorded 5 events to ./events.ndjson
```

Each line in `events.ndjson` is one full event object, e.g.:

```jsonc
{"type":"agent.lifecycle","seq":42,"ts":1717900000000,"workspaceId":"ws-1","ptyId":"pty-1","kind":"agent.stop","source":"hook","agent":"claude","decision":"emit"}
```

In identity mode against an enforce-mode wmux you will additionally see the
approval-wait line until you click Approve in the wmux window.

---

## Where to go next

- [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md) — the substrate wire contract.
- [`docs/api/mcp-plugin-spec.md`](../../docs/api/mcp-plugin-spec.md) — identity,
  permission grammar, and the enforcement / approval contract.
- [`docs/tutorials/`](../../docs/tutorials/) — guided, learning-oriented walkthroughs.
- [`docs/how-to/`](../../docs/how-to/) — task-oriented recipes (e.g. annotate a
  pane, drive an approval flow, recover from a daemon restart).
