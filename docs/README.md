# wmux documentation

wmux is a **terminal substrate**: it owns panes, terminal I/O, and an in-memory
event bus, and exposes them over a token-authenticated JSON-RPC socket. It does
not own workflow logic. Plugins, dashboards, and orchestrators connect from
in-pane or external processes and build their intelligence *on top* of these
primitives — there is no plugin manager and no install hook; a plugin is just an
authenticated client that declares an identity and the capabilities it intends
to use.

These docs follow the [Diátaxis](https://diataxis.fr/) model: learning-oriented
tutorials, task-oriented how-to guides, information-oriented reference, and
understanding-oriented explanation.

## Tutorials

Start here if you are new. A single guided lesson you follow start to finish.

- [Build a substrate plugin](./tutorials/build-a-substrate-plugin.md) — connect an external program to wmux, watch real events stream, write a label into a pane header, and walk the full identity + approval flow.

## How-to guides

Task recipes for when you already know what you want to do.

- [Connect to wmux](./how-to/connect-to-wmux.md) — resolve the token and endpoint, the Windows TCP fallback, wire framing, auth, and rate-limit caps.
- [React to events](./how-to/react-to-events.md) — the `events.poll` loop, the eight event types, opaque cursors, and filters.
- [Write pane metadata](./how-to/write-pane-metadata.md) — `setMetadata` mergeModes, shared vs `custom` fields, and the optimistic-concurrency retry loop.
- [Handle a daemon restart](./how-to/handle-daemon-restart.md) — detect `bootId` mismatch vs `resync`, and reconcile state from a fresh snapshot.
- [Attach a remote machine's workspaces](./how-to/remote-workspaces.md) — the desktop app's remote attach flow, `--tailscale` setup, and its limitations.

## Reference

The exact contract. Look things up here; do not read top to bottom.

- [`api/inventory.md`](./api/inventory.md) — every RPC method, MCP tool, and event type, each with a stability tier.
- [`api/reference.md`](./api/reference.md) — generated per-method API reference (produced by `scripts/gen-api-reference.mjs` from the source capability map).
- [`api/mcp-plugin-spec.md`](./api/mcp-plugin-spec.md) — plugin identity, the `wmuxPermissions` grammar, and the enforcement contract.
- [`api/versioning.md`](./api/versioning.md) — semver policy and what each stability tier promises.
- [`api/stability.md`](./api/stability.md) — the v3.0 stable-surface guarantees and validation limits.

## Explanation

Background and design rationale — why the substrate is shaped the way it is.

- [`PROTOCOL.md`](./PROTOCOL.md) — the substrate contract: PaneMetadata semantics, the event-bus model, the named-pipe security model, the identity model, and daemon lifecycle.
- [`browser-backends.md`](./browser-backends.md) — the three browser backends, the three levels of Chrome-profile exposure, what CDP cannot do (real passkeys, canvas UIs, mid-animation coordinates, automation detection), and how password values are redacted.
- [`phone-client-contract.md`](./phone-client-contract.md) — everything a phone client implements against `wmux web`: pairing, per-device credentials, stream tickets, the attention cursor, the approvals API, and the sealed push envelope.
- [`internal/m0-design.md`](./internal/m0-design.md) — the transaction-aware MetadataStore design (optimistic concurrency, snapshot envelope).
- [`internal/path-D-inventory.md`](./internal/path-D-inventory.md) — the workspace-identity resolution paths and the non-deterministic fallback being removed.
- [`internal/scrollback-restore-design.md`](./internal/scrollback-restore-design.md) — terminal scrollback persistence and restore.
