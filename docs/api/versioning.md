# wmux Versioning Policy

> **Status:** Phase 0 deliverable for Substrate 3.0. Replaces the implicit "ship semver and hope" policy that governed v0.x → v2.8.x.
> **Audience:** external tooling authors (MCP plugins, dashboards, orchestrators) and the wmux release process.
> **Companion docs:** [`inventory.md`](./inventory.md), [`stability.md`](./stability.md).

---

## TL;DR

- **Semver, strictly.** Major bumps are the only place breaking changes ship. Within a major, every change is either additive or behavior-preserving.
- **Three stability tiers**: `stable` / `experimental` / `internal`. The `stable` tier is the v3.0 substrate contract. The other two are documented but not warranty-covered.
- **v2.x → v3.0 is a "substrate identity" release**, not a wire break. The auto-updater path (winget · Chocolatey · electron-updater) treats it as a normal upgrade.
- **No 1.0 reset.** We considered renaming v2.8.x → v1.0 substrate but the auto-updater compares `1.0.0 < 2.9.0` as a downgrade. Marketing carries "Substrate 1.0" as a tagline alongside the v3.0 semver.

---

## The version triple

wmux versions follow `MAJOR.MINOR.PATCH`, applied as in [semver 2.0](https://semver.org).

| Bump | Trigger | External-tool impact |
|---|---|---|
| **PATCH** (`3.0.0 → 3.0.1`) | Bug fix in any tier. Documentation. Internal refactor. Performance work that doesn't change the wire shape. | None. Drop in. |
| **MINOR** (`3.0.x → 3.1.0`) | New `stable` surface (new RPC method, new event type, new optional field). New `experimental` surface. Promotion `experimental → stable`. Deprecation announcement (still works, but a warning is emitted). | Additive. Existing code keeps working. Clients can opt in to new surfaces. |
| **MAJOR** (`3.x → 4.0.0`) | Breaking change to any `stable` surface. Removal of a previously-stable surface (after one major's worth of deprecation). Renaming. | Coordinated migration. Release notes carry a migration guide. |

`experimental` surfaces can break within a minor; release notes call them out.

`internal` surfaces can change in any release.

---

## Stability tiers — semantics

These are the tiers declared in [`inventory.md`](./inventory.md). They are the basis for the breaking-change policy above.

### `stable`

A method, event type, or field marked `stable`:

- **Wire shape is frozen** for the current major. Names of parameters, names of returned fields, JSON-RPC error codes, event envelope keys — all fixed.
- **Semantics are frozen** for the current major. The same input shape produces the same output shape and the same side effects.
- **Additions are allowed.** New optional parameters, new fields in returned objects, new event types — these don't break clients that ignore them, so they ship in minors.
- **Removal requires a major + one-major deprecation window.** A `stable` surface marked deprecated in v3.x continues to work; it may only be removed in v4.0+.

A client that uses only `stable` surfaces, reads the `system.capabilities` tier map, and gracefully ignores fields it doesn't recognize is guaranteed forward-compatible within a major.

### `experimental`

- **May change wire shape or semantics within a major.** Release notes will call it out.
- **Typically newer surfaces** that need real-world feedback before being promoted, OR older surfaces whose contract is still being reshaped.
- **MAY be promoted to `stable`** in any minor release.
- **MAY be removed**, with a deprecation window of at least one minor release.

### `internal`

- **Not part of the external contract.** Documented here only so external tooling knows what *not* to depend on.
- **May change in any release** — patch, minor, or major.
- External callers reaching internal surfaces (e.g. raw `daemon.*` calls) accept that updates will likely break them. The substrate exposes equivalent functionality through `stable` surfaces.

---

## Deprecation process

When a `stable` surface needs to go away:

1. **Minor release N**: surface is marked deprecated. It still works identically. A console warning is emitted on every call. Release notes name a replacement.
2. **Minor release N+k** (at least one minor later): surface still works, warning still emitted. Migration guide updated with any patterns the community has reported.
3. **Major release M**: surface may be removed. Replacement is the only path forward.

Removal is not automatic at the next major. A deprecated surface can sit deprecated for multiple majors if its cost is low.

`experimental` surfaces follow the same shape but with a shorter window — usually deprecation in minor N, removal in minor N+1.

---

## How v2.x → v3.0 works (the "Substrate 3.0" release)

v3.0 is a major bump but **not a wire-break release**. Substrate 3.0 = "the substrate identity becomes the headline" + a small set of additive wire changes that close gaps surfaced by external tooling builders (issue #15, RFC discussion).

### What changes in v3.0 vs. v2.8.x

**Wire-shape additions (all backwards-compatible):**

- `pane.setMetadata` gains an optional `expectedVersion` parameter for optimistic concurrency. Callers that omit it opt out of version checks (same behavior as today).
- `pane.setMetadata` gains a `mergeMode: 'merge' | 'replace' | 'replaceShared'` parameter. The legacy `merge: boolean` parameter still works (`merge: true` ⇒ `mergeMode: 'merge'`; `merge: false` ⇒ `mergeMode: 'replace'`). Callers see no breaking change.
- `pane.setMetadata` reply gains `version: number`. Callers that ignore extra fields see no change.
- `pane.metadata.changed` event envelope gains `version: number`.
- `pane.list` snapshot envelope gains a per-pane `version: number` field — a **sibling of `metadata`**, not nested inside it. See [`../PROTOCOL.md`](../PROTOCOL.md#3-snapshot-envelope-panelist) §3 for the full envelope shape.
- `system.capabilities.features` gains a stability-tier map.
- New `wmuxPermissions` field in MCP server manifests (no impact on plugins that don't set it).

**Internal authority migration (no external impact):**

- The `MetadataStore` becomes the main-process authority for pane metadata. Today, the renderer's `paneSlice` is authoritative and the main process forwards writes to it via IPC. After v3.0, main writes directly to the `MetadataStore` and the renderer mirrors. External callers see the same JSON-RPC contract; the change is invisible to them. See [`../internal/paneSlice-callsite-inventory.md`](../internal/paneSlice-callsite-inventory.md) for the migration shape.

**Substrate identity:**

- README + announcement positioning shifts from "AI agent terminal" to "LSP-for-terminals — a neutral substrate that lets external tools build workflow intelligence on top of any terminal session." The product capabilities are a superset of v2.8.x; the framing is what's new.

### Why call it v3.0 instead of v1.0 (or v2.9)?

Three options were considered.

**Option A: v2.9.0** (minor bump). Rejected. The substrate identity shift is large enough to warrant external coordination — release notes, announcement, plugin convention. Calling it a minor undersells the contract investment.

**Option B: v1.0** (reset to mark "substrate 1.0"). Rejected. winget, Chocolatey, and electron-updater all compare `1.0.0 < 2.9.0` and treat the install as a downgrade. The auto-updater pipeline would either refuse to update or require a manual reinstall by every existing user.

**Option C: v3.0 + "Substrate 1.0" tagline** (chosen). Semver continuity preserved. Auto-updater works unchanged across winget · Chocolatey · electron-updater. Marketing/announcement carries "Substrate 1.0 — substrate-era v3.0" as the headline, similar to how Bun shipped "Bun 1.0" while remaining `1.0.0` in semver.

### v2.x → v3.0 compatibility guarantees

- All `stable` RPC methods and event types continue to work with their v2.x wire shape.
- The legacy `merge: boolean` parameter on `pane.setMetadata` is preserved as a shortcut for the new `mergeMode` field.
- `session.json` files written by v2.x load cleanly in v3.0 (missing `version` fields normalize to 0; first subsequent write becomes 1).
- The Named Pipe token contract is unchanged; v2.x clients connect to v3.0 daemons without coordination.
- The MCP server registration contract is unchanged for plugins that don't declare `wmuxPermissions` (treated as "no permissions requested" with the existing implicit-trust behavior).

### What v2.x clients lose by not updating

- No `expectedVersion` optimistic concurrency. Two MCPs writing to the same `status` field still last-writes-wins for v2.x clients.
- No `mergeMode: 'replaceShared'`. v2.x callers can't intentionally rewrite the shared-display fields without overwriting `custom`.
- No bootId/droppedCount-driven snapshot reconciliation. v2.x clients that drift past the ring window silently miss events.

These are improvements, not corrections — v2.x clients have a workable contract. The v3.0 surface gives them strictly more, without taking anything away.

---

## Auto-updater compatibility matrix

| Channel | Comparison rule | v2.8.x → v3.0.0 result |
|---|---|---|
| winget | `Microsoft.WinGet.SemanticVersion` (semver 2.0 strict) | `2.8.4 < 3.0.0` ⇒ normal upgrade path. |
| Chocolatey | `[NuGet.Versioning.SemanticVersion]` (semver 2.0) | `2.8.4 < 3.0.0` ⇒ normal upgrade path. |
| electron-updater (in-app) | `semver` npm package | `2.8.4 < 3.0.0` ⇒ normal upgrade path. |
| GitHub Releases tag sort | string + integer-aware | `v2.8.4 < v3.0.0` ⇒ correct ordering in release listings. |

The v3.0 release blocker (per Codex 1st review) was "do all three auto-update channels treat v3 as an upgrade from v2?" — verified above; release proceeds.

A v1.0-reset path would have failed all three.

---

## Patch release stream (v2.9.x)

Per the Substrate 3.0 plan, a small set of stability fixes (the TODOs.md group flagged in v2.8.x — daemon reconnect on tray restore, pane split max-depth guard, `destroyCompanyWithCleanup` race, member workspace PTY leak, DESIGN.md scaffold) ship on a separate v2.9.x patch stream rather than blocking v3.0.

- v2.9.0 ships the M0 transaction-aware MetadataStore (the bulk of Phase 1 — the actual breaking-free of authority from renderer to main).
- v2.9.1+ patches absorb the TODOs.md stability backlog. Independent of v3.0 schedule.

v2.9.x is the active patch line until v3.0 ships; users on v2.9.x receive patches automatically through the same auto-update channels.

---

## Version-aware client patterns

Recommended patterns for clients that need to support multiple wmux versions:

### Feature detection over version comparison

Prefer:

```typescript
const caps = await rpc.call('system.capabilities', {});
if (caps.features.paneMetadata?.optimisticConcurrency) {
  // Use expectedVersion.
} else {
  // Fall back to no version checks.
}
```

Over:

```typescript
const identity = await rpc.call('system.identify', {});
if (semver.gte(identity.version, '3.0.0')) { /* … */ }
```

Feature flags are stable across the entire minor line; version strings can move underneath you for reasons unrelated to the feature you care about.

### bootId comparison on every poll

```typescript
const result = await rpc.call('events.poll', { cursor: lastCursor });
if (result.bootId !== knownBootId) {
  // Daemon restarted under us — drop ALL cached state.
  cachedPaneIds.clear();
  cachedPtyIds.clear();
  lastCursor = 0;
  knownBootId = result.bootId;
  // Re-hydrate via pane.list snapshot.
}
```

`bootId` is the v3.0-stable signal for cache invalidation. It works for v2.7.x+ as well (added with the EventBus).

### Cursor passed through, not interpreted

```typescript
const result = await rpc.call('events.poll', { cursor: lastCursor });
lastCursor = result.nextCursor;     // ← pass through
// Don't compute lastCursor + 1, don't sort, don't assume monotonicity.
```

Even though `nextCursor` is monotonic today, the protocol treats it as opaque to leave room for future cursor evolutions (sharded rings, segmented cursors).

---

## Release cadence (informational, not a contract)

- Patch: as needed for fixes. Typical cadence is 1–2 per month while a minor is active.
- Minor: when a coherent feature set is ready. No fixed cadence.
- Major: rare. The expectation is one major every 12–18 months.

This is the operational target, not a guarantee. The contract is the tier-based breaking-change policy above.
