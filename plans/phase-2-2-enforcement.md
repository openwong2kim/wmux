# Phase 2.2 — MCP Plugin Permission Enforcement

Status: DRAFT v2 (planning only — Q1/Q2/Q3 resolved by sub-agent second opinions, no code this session)
Spawned from: `plans/generic-wandering-teapot.md` (Substrate 3.0 Phase 2 row)
Predecessors: PR #48 (record-only identity + grammar), PR #49 (trust-DB invariants), PR #68 (spec §3.4/§3.5/§3.6 default rules)
Tracking: issue #31 (Substrate 3.0 roadmap), comment-thread with @alphabeen
Review trail: `architect-reviewer` + `backend-architect` independent skims (2026-05-27), both grounded in code reads of `RpcRouter`, `permissionGrammar`, `rpc.ts`, `PipeServer`, `PluginIdentity`, `PluginTrustStore`.

## Why this plan exists

Phase 2.1 shipped the identity + grammar substrate **record-only**. Every `mcp.identify` and `mcp.declarePermissions` writes to `~/.wmux/plugin-trust.json` but no RPC is gated. The substrate now knows who's talking and what they say they want, and the spec (PR #68 §3.4/§3.5/§3.6) defines the boundaries. What's missing is the wall.

Phase 2.2 puts the wall in:

1. **Method-dispatch gate** — RPC call with a capability the caller didn't declare → reject.
2. **Metadata-path gate** — `pane.setMetadata` with a path the caller's `meta.write` glob doesn't match → reject.
3. **Event-topic gate** — `events.subscribe` payload restricted to topics matching the caller's declared globs.
4. **Approval dialog** — user-visible prompt for `unconfirmed` declarations; renders terminal-content capabilities (`terminal.read`, `pane.search`) with stronger language than metadata/events.

The external-tooling reviewer (@alphabeen, issue #31) explicitly asked for **structured per-path rejection errors** so plugin authors can debug declaration vs runtime mismatch without guessing — that's a first-class requirement here, not a follow-up.

## Boundary constraints (from memory + spec)

- `[[feedback_substrate_neutrality]]` — substrate stays neutral. Enforcement is a substrate concern (record + gate + persist), but the *opinion* (which capability gates which method) lives in a single declarative table that any future reviewer can read at a glance.
- `[[feedback_no_ship_without_user_verification]]` — user dogfood between code-complete and PR push.
- `[[feedback_pr_strategy]]` — external reviewer (alphabeen) in the loop → 1 PR + commits. Stacked PRs only for self-review hygiene if scope balloons.
- `[[feedback_pr_commit_english]]` — PR body, commit message, code comments all English.
- `[[feedback_push_confirm]]` — user confirms before push.
- `[[reference_dynamic_test_pattern]]` — daemon subprocess + RPC probe e2e pattern, see `src/main/mcp/__tests__/phase-2-1-e2e.test.ts`.
- Spec §3.4 (metadata path namespace), §3.5 (event topic namespace), §3.6 (terminal-content risk class) — authoritative semantics. Implementation MUST cite spec lines in code comments where defaults are encoded.

## Surface map (what we touch)

```
docs/api/
├── mcp-plugin-spec.md          (§4 — declaration flow; extend with §4.4 enforcement contract)
├── inventory.md                 (annotate each RPC tool with its capability + path-scope rule)
└── stability.md                 (no change — gates are additive, not a breaking promise)

src/main/pipe/
├── RpcRouter.ts                 (PRIMARY GATE — central dispatch wrapper, ctx → permission check)
└── handlers/                    (each handler MAY do post-gate path-glob check for nested resource paths)
    ├── meta.rpc.ts              (pane.setMetadata / pane.getMetadata — needs path-glob check)
    ├── events.rpc.ts            (events.subscribe — needs topic-glob check + filter pipeline)
    ├── pane.rpc.ts              (pane.search — terminal-content risk class)
    ├── input.rpc.ts             (terminal.send — capability check only)
    └── ...                      (all others gated by capability only at dispatch level)

src/main/mcp/
├── PluginIdentity.ts            (existing — read trust state)
├── PluginTrustStore.ts          (existing — persist updates from approval)
├── permissionGrammar.ts         (existing — parse + match)
├── methodCapabilityMap.ts       (NEW — single source of truth: method → required capability)
├── PermissionEnforcer.ts        (NEW — pure-function gate: (method, params, ctx, trust) → allow|reject)
└── ApprovalQueue.ts             (NEW — debounced approval prompt orchestrator)

src/renderer/
└── components/Approval/
    ├── PermissionApprovalDialog.tsx       (NEW — modal renders declared capabilities with risk classes)
    └── PermissionApprovalDialog.test.tsx  (NEW)

src/shared/
└── rpc.ts                       (extend RpcResponse with structured rejection variant)
```

## Architectural decisions

### D1. Fully central gate (capability AND path)

`RpcRouter.dispatch` (`src/main/pipe/RpcRouter.ts:53-117`) is already the single entry point that pulls `clientName`/`clientVersion` into `RpcContext` and runs the legacy-contact recorder. The permission gate goes at the same layer — for **both** the capability check and the path-glob check. Path extraction is data-driven from `methodCapabilityMap` via a `pathFromParams?: (params) => string | string[] | undefined` extractor.

- **One place to audit.** Future reviewer reads `RpcRouter.dispatch` + `methodCapabilityMap` and sees every rejection path. No handler can quietly skip gating.
- **`tsc` enforces totality.** `Record<RpcMethod, RequiredCapability>` makes a new RPC method without a map entry a compile-time error. "I added a method but forgot to gate it" is caught at build, not in review.
- **Blast radius is asymmetric in the right direction.** Misconfigured `pathFromParams` extractor fails *closed* (legitimate calls rejected, surfaced by shadow-mode metric in D7 step 3). Forgotten handler-local check fails *open* (silent over-grant — exactly the bug enforcement exists to prevent). Centralization makes the dangerous failure mode loud.
- **Multi-path support is built into the extractor return type.** `string | string[] | undefined` covers `pane.setMetadata` (single path), `events.poll` (subscriber may pass a topic array), and the no-path methods (`undefined`). The enforcer returns `{ allowed: string[], rejected: { path, declared }[] }` for the multi-path case so handlers can subscribe to the allowed subset and surface the rejected list per @alphabeen's structured-rejection ask (D3) — handlers never reimplement rejection plumbing.
- **Escape hatch for state-dependent paths.** A method that needs handler-resolved state (e.g. `paneId → workspaceId` lookup before path is knowable) uses an explicit sentinel `pathFromParams: 'handler-resolves'` in the map and the handler MUST call `PermissionEnforcer.checkPath(ctx, capability, resolvedPath)` itself. Documented sentinel keeps the table the single source of truth even for exceptions.

**Resolves Q1** (architect-reviewer + backend-architect concurrence, both citing the "audit + compile-time totality" argument).

### D2. Method → capability mapping in a single declarative table

```ts
// src/main/mcp/methodCapabilityMap.ts
//
// Capability and method are DIFFERENT layers: `events.subscribe` is the
// capability name (spec §3.5, see permissionGrammar.ts KNOWN_CAPABILITIES),
// while `events.poll` is the actual RPC method on the wire (src/shared/rpc.ts).
// The map keys are RPC methods; `capability` is the declared name that
// `wmuxPermissions` grants. Same logic for `terminal.read` capability vs
// `terminal.readEvents` / `input.readScreen` methods.

import type { RpcMethod } from '../../shared/rpc';

type Capability = string;  // values from KNOWN_CAPABILITIES, intersected at runtime
type PathExtractor = (params: Record<string, unknown>) => string | string[] | undefined;

export interface RequiredCapability {
  /** Null means "no capability required" — identity bootstrap RPCs only. */
  capability: Capability | null;
  /** Optional extractor; if absent the gate only checks capability. */
  pathFromParams?: PathExtractor | 'handler-resolves';
  /** Risk class drives approval-dialog wording (D5). */
  riskClass?: 'terminal-content' | 'terminal-input' | 'system';
}

export const METHOD_CAPABILITY: Record<RpcMethod, RequiredCapability> = {
  // Identity bootstrap — MUST stay unconditionally callable so a fresh
  // plugin can declare itself. Mirrors IDENTITY_OWN_METHODS in RpcRouter.ts.
  'mcp.identify': { capability: null },
  'mcp.declarePermissions': { capability: null },

  // Pane lifecycle
  'pane.list': { capability: 'pane.read' },
  'pane.split': { capability: 'pane.create' },
  'pane.focus': { capability: 'pane.read' },
  'pane.search': { capability: 'pane.search', riskClass: 'terminal-content' },

  // Metadata — path is the dotted JSON path into PaneMetadata (spec §3.4)
  'pane.setMetadata': { capability: 'meta.write', pathFromParams: (p) => p.path as string | undefined },
  'pane.getMetadata': { capability: 'meta.read',  pathFromParams: (p) => p.path as string | undefined },
  'pane.clearMetadata': { capability: 'meta.write', pathFromParams: (p) => p.path as string | undefined },

  // Events — capability is `events.subscribe`, wire method is `events.poll`.
  // Topic filter for the poll comes off `p.topics` (array) or `p.topic`.
  'events.poll': {
    capability: 'events.subscribe',
    pathFromParams: (p) => (Array.isArray(p.topics) ? p.topics as string[] : p.topic as string | undefined),
  },

  // Terminal IO
  'input.send':         { capability: 'terminal.send', riskClass: 'terminal-input' },
  'input.sendKey':      { capability: 'terminal.send', riskClass: 'terminal-input' },
  'input.readScreen':   { capability: 'terminal.read', riskClass: 'terminal-content' },
  'terminal.readEvents': { capability: 'terminal.read', riskClass: 'terminal-content' },

  // ...full surface covered when the table is implemented; tsc enforces totality.
};
```

This is **the** opinionated piece of substrate. One table, one place to add a method, one place to argue about classification. `tsc` enforces totality via `Record<RpcMethod, ...>` so a new RPC method that doesn't appear in the table fails compilation. Identity bootstrap RPCs (`mcp.identify`, `mcp.declarePermissions`) appear in the table with `capability: null` rather than as a hard-coded enforcer special case — the table stays the single source of truth (architect-reviewer + backend-architect both flagged this).

### D3. Structured per-path rejection (alphabeen's ask)

`RpcResponse` in `src/shared/rpc.ts` is **already a discriminated union** (`{ id; ok: true; result } | { id; ok: false; error }`). Phase 2.2 extends the failure arm only, preserving narrowing semantics for every existing `switch (r.ok)` site (architect-reviewer caught this — earlier draft incorrectly flattened the shape).

```ts
// src/shared/rpc.ts — additive ONLY to the ok:false arm
export type RpcRejection =
  | { reason: 'capability-not-declared'; method: RpcMethod; capability: string }
  | { reason: 'path-not-allowed'; method: RpcMethod; capability: string;
      path: string; declared: string[] }   // single-path methods (pane.setMetadata)
  | { reason: 'paths-partially-allowed'; method: RpcMethod; capability: string;
      allowed: string[]; rejected: { path: string; declared: string[] }[] }
                                            // multi-path methods (events.poll)
  | { reason: 'identity-status'; method: RpcMethod; status: 'denied' | 'unconfirmed';
      capability: string; pendingApproval?: { promptId: string } }
  | { reason: 'unknown-method'; method: string };

export type RpcResponse =
  | { id: string; ok: true;  result: unknown }
  | { id: string; ok: false; error: string; rejection?: RpcRejection };  // rejection is ADDITIVE on the existing failure arm
```

Mirrors PR #49's discriminated-union pattern: callers that read `error` keep working; new plugin authors branch on `rejection.reason` for precise diagnostics. The generic `error` string for `path-not-allowed` reads:

> `pane.setMetadata: path "status" not allowed by declared meta.write globs [custom.myPlugin.*]`

— so it's also useful without consulting the union.

`paths-partially-allowed` (the multi-path variant) lets `events.poll` return successful results for the allowed topic subset while surfacing the rejected ones in the same response. Without that split, an MCP client subscribing to `[pane.created, agent.lifecycle]` with only `events.subscribe:pane.*` declared would have to either get a wholesale reject (poor UX) or silently lose the `agent.lifecycle` events (worse). Backend-architect specifically called this shape out as the natural extension of @alphabeen's per-path-rejection ask.

### D4. Trust-state ladder during enforcement (resolves Q2)

| Status | What gate does |
|---|---|
| `trusted` | Allow if capability + path match declaration. |
| `unconfirmed` | **Reject** with `{reason: 'identity-status', status: 'unconfirmed', pendingApproval: {promptId}}`. Do NOT block the socket. ApprovalQueue dedupes prompts per `(clientName, declaredCapabilities-hash)`. Client retries on `pendingApproval`; on user approve → `trusted`, next call (or retry) succeeds. |
| `legacy` | Allow + audit (preserve v2.x callers). Eligible for promotion to `unconfirmed` when the caller learns to send `clientName`. Spec §2.3 already exempts `legacy` from automated demotion. |
| `denied` | Reject with `{reason: 'identity-status', status: 'denied'}`. No prompt. User must edit `plugin-trust.json` manually to restore. Spec §4.3: "`denied` never regresses." |

**Why reject-with-retry, not block** (both reviewers concurrent):

- `PipeServer.MAX_CONNECTIONS = 50` is a hard socket cap. Blocking pins sockets across a human-scale modal interaction (seconds-to-minutes). 5 unconfirmed plugins × 3 boot-time calls = 15 sockets parked = 30% of the pool gone behind one AFK user. Reject-with-retry releases the socket immediately.
- The approval dialog is on the Electron renderer. Blocking RPC handlers in main waiting on a renderer round-trip creates a substrate-wide failure mode when the renderer stalls (xterm fit churn, GPU stall, devtools open — all observed wmux pathologies per `[[reference_terminal_fit_guards]]`). Reject-with-retry decouples renderer health from RPC throughput.
- Deadlock risk: a plugin making a gated call from inside a synchronous MCP `tools/call` would block the host LLM-side conversation if we held the socket. Reject-with-retry is the same shape as OAuth `authorization_pending` — well-established async pattern with documented client idiom.
- IPC timeouts compound the blocking failure mode: most MCP clients use 30s–60s RPC timeout; if the user doesn't pick in time the plugin sees a generic timeout and may auto-retry, creating duplicate prompts. With explicit `pendingApproval` the wait is in the protocol — the client decides whether to back off, batch, or surface "waiting for approval" UI to its own user.

`@wmux/orchestrator` (already shipped, see `[[project_orchestrator_v0_1_1_shipped]]`) gets a `withApprovalRetry()` helper documenting the idiom (~20 LOC). External integrators copy the pattern from the orchestrator README.

`legacy` allow-list keeps existing integrations alive across the v2 → v3 cut. **Resolves Q3**: surfacing legacy calls as user-visible warnings is deferred to v3.1 — Phase 2.2 logs them to shadow-mode telemetry (D7) so v3.1 can build a settings panel on top of populated data, but doesn't ship the panel itself. Both reviewers concurrent: a warning a user can't act on is an anti-pattern, and post-enforcement-launch warning noise undermines trust in the warning system when real rejections start firing.

### D5. Approval dialog wording asymmetry (alphabeen reminder)

Single modal component reads the declared `wmuxPermissions` array, groups by risk class from `methodCapabilityMap`, and renders:

- **Metadata + events** (low risk) — neutral wording: *"can label your panes, can subscribe to pane lifecycle events"*.
- **Terminal content** (`terminal.read`, `pane.search`) — bold + warning color: *"can read what's on your screen, including secrets, agent output, and command history"*.
- **Terminal input** (`terminal.send`) — bold + warning color: *"can type into your panes as if you were typing"*.
- **A2A / browser / others** — case-by-case wording in the same risk-class table.

The wording table lives next to `methodCapabilityMap` so risk class and label move together.

### D6. Test strategy

Three layers:

1. **Unit** — `PermissionEnforcer.check(...)` is pure-function; cover all rejection branches + every `riskClass` × capability matrix in `methodCapabilityMap`.
2. **Integration** — RpcRouter dispatch tests using a synthetic `RpcRequest` and a fake `PluginTrustStore`. Cover identity-state ladder transitions.
3. **E2E dynamic** — extend `phase-2-1-e2e.test.ts` (or new `phase-2-2-e2e.test.ts`) using `[[reference_dynamic_test_pattern]]`: bundled daemon subprocess + RPC probe. Drives the full envelope-with-clientName + declare + attempt-call + observe-rejection-shape cycle through the production code path. This is the test that gives external integrators confidence.

Approval dialog has its own RTL/Vitest UI tests separate from the gate logic.

### D7. Phased rollout inside the PR

To keep the diff legible and dogfood-safe:

1. **Pre-commit 1**: `methodCapabilityMap` + `PermissionEnforcer` (pure modules, fully central per D1, identity-bootstrap sentinel `capability: null`, unit tests).
2. **Pre-commit 2**: extend `RpcResponse` failure arm with `rejection` (additive type, preserves discriminated union, no behavior change).
3. **Pre-commit 3**: `RpcRouter.dispatch` wires `PermissionEnforcer` in **shadow mode** — runs the check, logs the would-be rejection, does NOT block. Logged to a dedicated ring buffer / append-only log under `~/.wmux/shadow-rejections.log`, **NOT** persisted on `PluginIdentityRecord` (backend-architect: trust-DB LRU cap can evict shadow evidence under hostile churn).
4. **Pre-commit 4**: legacy-recorder upgrade — `RpcRouter.legacyContactPersisted` (line 40) is process-once today, which under-counts legacy traffic during a dogfood window. Lift to per-`(clientName-or-pid, method)` counts (best-effort, capped, written to the same shadow log) so v3.1 can build the legacy-surfacing UI on real data. Stays a no-op for `clientName`-stamped requests.
5. **Pre-commit 5**: `ApprovalQueue` + `PermissionApprovalDialog` (UI + queue dedupe by `(clientName, declaredCapabilities-hash)`, no wiring yet).
6. **Pre-commit 6**: flip from shadow → enforce, **gated by a user-toggleable feature flag** in `~/.wmux/config.json` (default `enforce` in v3.0 release; dev wmux defaults to `shadow` so dogfood can flip back on a bad delta without rebuilding). This is the load-bearing commit reviewers focus on.
7. **Pre-commit 7**: docs (spec §4.4 enforcement contract incl. worked `*` vs `**` example for `custom.foo` vs `custom.foo.bar` semantics — backend-architect: trailing-dot glob behavior will trip @alphabeen's first integration if undocumented; inventory.md per-tool capability rows).

Commits 1–5 don't change runtime behavior. Commit 6 does, and only after dogfood proves shadow-mode rejection counts match expectations across at least one full multi-plugin session.

## Open questions — RESOLVED (sub-agent second opinion, 2026-05-27)

Two reviewers (architect-reviewer + backend-architect) skimmed this plan independently, each grounded in fresh reads of `RpcRouter.ts`, `permissionGrammar.ts`, `rpc.ts`, `PipeServer.ts`, `PluginIdentity.ts`, `PluginTrustStore.ts`, and spec §3-§5. All three calls came back with concurrent recommendations.

- **Q1 → D1 fully-central.** Both reviewers preferred lifting the path-glob check into the central gate via `pathFromParams: (params) => string | string[] | undefined`. The earlier "hybrid" framing was a half-measure: handler-local path checks fail *open* (silent over-grant — the exact bug enforcement exists to prevent) while a misconfigured central extractor fails *closed* (caught by shadow mode in D7 step 3). `Record<RpcMethod, ...>` totality gives a compile-time error for any new method that forgets to gate.
- **Q2 → D4 reject-with-pendingApproval.** Both reviewers rejected the "block server-side" alternative on socket-cap grounds (`MAX_CONNECTIONS = 50` × human-scale approval latency = DoS vector against own pool), renderer-stall fault tolerance, deadlock from synchronous MCP tool calls, and OAuth `authorization_pending` precedent. The discriminated union (D3) already names `pendingApproval: { promptId }` — the wire contract is built for retry.
- **Q3 → D4 silent grandfather for v3.0, surfacing deferred to v3.1.** Both reviewers flagged that a warning the user can't act on (they can't add `clientName` to someone else's code) is an anti-pattern, and warning noise immediately after launching enforcement undermines trust when real rejections start firing. Shadow-mode telemetry (D7 step 3+4) collects the data without shipping UI, so v3.1 can build the panel on real counts.

## Additional substantive concerns from review

Surfaced by one or both sub-agent skims; folded into the design above.

- **`mcp.identify` / `mcp.declarePermissions` self-exemption** — D2 table now has them with `capability: null` instead of hard-coded special case in the enforcer. Mirrors `IDENTITY_OWN_METHODS` in `RpcRouter.ts:27-30`. Without this, a fresh plugin can't declare itself (chicken-and-egg deadlock).
- **`RpcResponse` is already a discriminated union** — D3 rewritten to preserve `{ok:true; result} | {ok:false; error}` narrowing; `rejection` is additive to the failure arm only. The earlier draft flattened the shape and would have broken every `switch (r.ok)` site in the codebase.
- **Capability ≠ method layer** — D2 commentary now spells out `events.subscribe` (capability) vs `events.poll` (method); the `terminal.read` capability covers `terminal.readEvents` / `input.readScreen` methods. Caught by architect-reviewer; the live spec §3.5 + `KNOWN_CAPABILITIES` are internally consistent — only the plan example was mislabeled.
- **Shadow metrics on a separate log, not on `PluginIdentityRecord`** — `MAX_PLUGIN_TRUST_ENTRIES = 1024` LRU eviction (`PluginTrustStore.ts:35-58`) can evict shadow-mode evidence under hostile churn. D7 step 3 now writes shadow rejections to a dedicated ring buffer / log file.
- **Process-once legacy recorder is wrong for shadow accounting** — `RpcRouter.legacyContactPersisted` (line 40) fires only on the first envelope-less RPC per process. Three different legacy callers in one session = only the first recorded. D7 step 4 lifts this to per-(client-or-pid, method) counts in the shadow log so v3.1 has accurate data.
- **Shadow → enforce should be a user-toggleable feature flag**, not a one-way code switch. D7 step 6 amended: `~/.wmux/config.json` flag, prod defaults to `enforce`, dev defaults to `shadow` for rollback safety during the dogfood window.
- **`*` doesn't match `.` — counterintuitive glob behavior must be documented.** `permissionGrammar.ts:78` makes `*` stop at the path separator, so `meta.write:custom.foo` does NOT grant `custom.foo.bar`; the declaration must be `custom.foo.*` (single segment) or `custom.foo.**` (recursive). D7 step 7 adds a worked example in spec §4.4 so @alphabeen's first integration doesn't misdeclare.
- **Multi-path rejection shape `{allowed, rejected}`** — backend-architect suggestion folded into D3. `events.poll` with mixed-grant topic array gets the subset that passed plus structured per-rejected-path detail, no wholesale-reject penalty.

## What's NOT in this plan

- Capability revocation CLI (`wmux mcp permissions <name> --revoke <capability>`) — spec §5 calls it out as a follow-up PR. Manual edit of `plugin-trust.json` is the v3.0 workflow.
- Per-connection identity pinning (preventing a plugin from rotating `clientName` mid-session) — spec §7 defers.
- Cryptographic plugin tokens / signed manifests — v3.1+ roadmap.
- WASM sandbox — out of scope forever (plugins run as their own OS process).
- Marketplace UI — out of band.

## Ship checklist (when implementation starts, NOT this session)

- [ ] D1–D7 design decisions resolved (after Q1–Q3 second opinion).
- [ ] Pre-commit 1–4 implemented + unit/integration tests green + `tsc --noEmit` clean.
- [ ] Shadow-mode metric collected in dev wmux dogfood for ≥30 minutes across at least 2 plugin clients (Claude Code + Codex). Shadow rejections match expectations.
- [ ] Pre-commit 5–7 implemented; dialog approved by user in dev wmux.
- [ ] E2E dynamic test passes on local Windows + at least one POSIX leg.
- [ ] CHANGELOG entry under v2.x.x (release flow).
- [ ] PR body: link issue #31, PR #48, PR #49, PR #68, this plan.
- [ ] cc @alphabeen in PR body — no expectation of review cycles.
- [ ] User confirms push (memory rule).
