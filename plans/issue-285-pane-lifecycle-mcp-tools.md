# Issue #285 — Expose pane + surface lifecycle as MCP tools

> Status: PLAN (eng-review decisions baked in)
> Issue: #285 (zhenzoo) — formal follow-up to #236, per @openwong2kim's request to track it.
> Branch base: `main` (currently on `release/v3.9.0` — branch from main for the PR).

## Eng-review decisions (locked)

- **DR-1** `pane_split`/`surface_new` omitted-workspaceId → resolve the **caller's own** ws
  (`resolveScopedReadWorkspaceId`), fall back to active ws on a true identity miss. (Matches
  `surface_list`/`pane_list`.)
- **DR-2** `pane_close`/`pane_focus`/`surface_close` → **mirror the RPC**: take a single id, all-ws
  lookup, no MCP-layer ownership check. The first-party model is method-level (not ws-scoped), so a
  workspaceId param would be a false boundary; paneId/surfaceId are unguessable UUIDs and OS-user is
  the trust ceiling.
- **DR-3** **Include `surface_new` + `surface_close` now** (not deferred). They are `wmux.internal`
  (reserved), so this requires widening `ALLOWED_RESERVED_FIRST_PARTY` with the explicit security
  review in §6. Scope = **5 MCP tools**.
- **DR-4** Test with **both**: extract the 5 tools into an injectable `registerPaneLifecycleTools`
  for captured-handler behavioral tests, AND keep the `workspaceRouting.test.ts` source-invariant
  guard.

## 1. The ask

Surface the pane + surface lifecycle daemon RPCs as **first-class MCP tools** so an external/headless
orchestrator (a Claude Code supervisor spawning + reaping worker panes) can manage panes through the
official MCP instead of a hand-written daemon-JSON-RPC client.

Final tool set (5):

- `pane_split` — `{ workspaceId?, direction? }`
- `pane_close` — `{ paneId }`
- `pane_focus` — `{ paneId }`
- `surface_new` — `{ workspaceId?, shell?, cwd? }`
- `surface_close` — `{ surfaceId }`

Motivation: a supervisor spawns a dedicated worker pane per unit of work and closes it once
committed. The create/close path currently bypasses MCP via a custom daemon client. The
explicit-`workspaceId` requirement mirrors the #236 fix (headless/spawned sessions may lack
`WMUX_WORKSPACE_ID` in env).

## 2. Current state — the RPC + capability layer already exists

The hard part shipped already (#236 / #238 / #256 / #257). Verified contracts:

| RPC method | File | Real param contract | scoping | capability |
|---|---|---|---|---|
| `pane.split` | `pane.rpc.ts:195` | `{ direction: 'h'\|'v' (required), workspaceId? }` → `{ ok, paneId?, ptyWarning? }` | explicit ws **fail-closed**; omitted → active; bg ws **eager-spawns** PTY; cap 20 | `pane.create` |
| `pane.close` | `pane.rpc.ts:228` | `{ id }` → `{ ok }` | **globally-unique id, all-ws, NO active fallback**; rejects non-leaf/root; disposes PTYs | `pane.create` |
| `pane.focus` | `pane.rpc.ts:184` | `{ id }` → `{ ok }` | all-ws; **non-yank** (no `activeWorkspaceId` move); rejects non-leaf; emits `pane.focused` | `pane.read` |
| `surface.new` | `surface.rpc.ts:32` | `{ workspaceId?, shell?, cwd? }` → `{ id?, ptyId, ... }` | explicit ws fail-closed; eager-spawn; orphan guard | **`wmux.internal`** |
| `surface.close` | `surface.rpc.ts:59` | `{ id }` → `{ ok }` | globally-unique id, all-ws | **`wmux.internal`** |

**The gap is the MCP wrapper + the first-party allowlist entries.** No new RPC, no new capability,
no `methodCapabilityMap.ts` change, no renderer/daemon change.

### Two corrections to the issue's request (verified against source)

1. **`pane_focus`/`pane_close` do NOT take `workspaceId`.** The RPCs take one globally-unique id and
   resolve across all workspaces (by design, #257/#256). Only `pane.split`/`surface.new` (the create
   family) take a `workspaceId`. The issue's `pane_focus { workspaceId, paneId }` is inaccurate; the
   response to the issue should clarify this.
2. **The bypass client "works" because it rides the legacy grandfather.** A hand-written daemon client
   sends `{ id, method, params, token }` with **no `clientName`**, so the enforcer's legacy branch
   (`if (!clientName) allow`) lets it through. Through the bundled MCP every call is stamped
   `clientName='claude-code'`, so it is gated by `FIRST_PARTY_METHODS`. **That allowlist work is the
   real substance of this issue** (§4.2).

## 3. How an MCP tool is wired

`src/mcp/index.ts`, `server.tool(name, description, zodSchema, handler)`. Handler resolves identity
then calls `callRpc('rpc.method', params)` (underscore tool name → dot RPC method).

- **Read tools** (`pane_list`, `surface_list`): `resolveScopedReadWorkspaceId()` — fail-soft, never
  throws, `''` on miss → omit `workspaceId` → RPC active-ws fallback.
- **Write tools** (`pane_set_metadata`): `requireWorkspaceId()` — throws on identity miss.

Precedent for an injectable, testable registration module: `registerChannelTools(server, deps)` in
`src/mcp/channels.ts` (captured-handler tests in `__tests__/index.channel.test.ts`).

## 4. Implementation

### 4.1 New module `src/mcp/paneLifecycle.ts` (DR-4 — injectable + testable)

```ts
import type { RpcMethod } from '../shared/rpc';
import { z } from 'zod';

export interface PaneLifecycleDeps {
  // Wrapped RPC caller (index.ts's callRpc): returns MCP-shaped { content }.
  callRpc: (method: RpcMethod, params?: Record<string, unknown>) => Promise<{ content: unknown }>;
  // Fail-soft caller-own-ws resolver for the create family (= resolveScopedReadWorkspaceId).
  resolveCallerWorkspaceId: () => Promise<string>;
}

export function registerPaneLifecycleTools(server: McpServerLike, deps: PaneLifecycleDeps): void {
  const { callRpc, resolveCallerWorkspaceId } = deps;

  server.tool(
    'pane_split',
    'Split a leaf pane, creating a new sibling pane. Returns the new paneId (and a ptyWarning if a ' +
    'background PTY could not be pre-spawned). Omit workspaceId to split inside your own workspace.',
    {
      workspaceId: z.string().optional().describe('Target workspace. Omit to use your own.'),
      direction: z.enum(['horizontal', 'vertical']).optional().describe('Split direction. Default: horizontal.'),
    },
    async ({ workspaceId, direction }) => {
      const resolved = workspaceId || (await resolveCallerWorkspaceId());          // DR-1
      const params: Record<string, unknown> = { direction: direction ?? 'horizontal' };  // Q: default horizontal
      if (resolved) params['workspaceId'] = resolved;
      return callRpc('pane.split', params);
    },
  );

  server.tool(
    'pane_close',
    'Close a leaf pane and dispose its surfaces\' PTYs. paneId is globally unique and resolved across ' +
    'all workspaces, so a supervisor can reap a worker pane it created in a background workspace. ' +
    'Rejects branch (non-leaf) panes and the root pane.',
    { paneId: z.string().describe('Leaf pane id to close (from pane_list).') },
    async ({ paneId }) => callRpc('pane.close', { id: paneId }),                    // DR-2
  );

  server.tool(
    'pane_focus',
    'Focus a leaf pane. Does NOT switch the on-screen workspace (non-yank): focusing a pane in a ' +
    'background workspace marks it active there without stealing the user\'s screen. Use workspace.focus to switch screens.',
    { paneId: z.string().describe('Leaf pane id to focus (from pane_list).') },
    async ({ paneId }) => callRpc('pane.focus', { id: paneId }),                    // DR-2
  );

  server.tool(
    'surface_new',
    'Open a new surface (terminal) in a workspace\'s active pane. Returns the new surfaceId + ptyId. ' +
    'Omit workspaceId to open in your own workspace.',
    {
      workspaceId: z.string().optional().describe('Target workspace. Omit to use your own.'),
      shell: z.string().optional().describe('Shell override. Omit for the workspace default.'),
      cwd: z.string().optional().describe('Working directory. Omit for the workspace default.'),
    },
    async ({ workspaceId, shell, cwd }) => {
      const resolved = workspaceId || (await resolveCallerWorkspaceId());          // DR-1
      const params: Record<string, unknown> = {};
      if (resolved) params['workspaceId'] = resolved;
      if (shell !== undefined) params['shell'] = shell;
      if (cwd !== undefined) params['cwd'] = cwd;
      return callRpc('surface.new', params);
    },
  );

  server.tool(
    'surface_close',
    'Close a surface and dispose its PTY. surfaceId is globally unique and resolved across all workspaces.',
    { surfaceId: z.string().describe('Surface id to close (from surface_list).') },
    async ({ surfaceId }) => callRpc('surface.close', { id: surfaceId }),          // DR-2
  );
}
```

`src/mcp/index.ts` — one wiring call (after the inline tools, before `// === Start server ===`):

```ts
registerPaneLifecycleTools(server, {
  callRpc,
  resolveCallerWorkspaceId: resolveScopedReadWorkspaceId,
});
```

No circular import (paneLifecycle.ts imports nothing from index.ts — same as channels.ts).

### 4.2 First-party allowlist — `src/main/mcp/firstParty.ts`

Add to `FIRST_PARTY_METHODS`:

```ts
  // pane lifecycle (issue #285)
  'pane.split',
  'pane.close',
  'pane.focus',
  // surface lifecycle (issue #285 — reserved wmux.internal, see security review)
  'surface.new',
  'surface.close',
```

`pane.*` are `pane.create`/`pane.read` (not reserved). `surface.new`/`surface.close` are
`wmux.internal` (reserved) → **also** add to `ALLOWED_RESERVED_FIRST_PARTY` in
`firstParty.test.ts` and rewrite its prose (see §6). The lockstep test forces all of this: the
tools' `callRpc('…')` literals are scanned and must appear in the allowlist, and reserved entries
must appear in the exception set AND actually be called.

### 4.3 Docs

- `docs/api/inventory.md` "## MCP tools / ### Substrate surface": add `pane_split`, `pane_close`,
  `pane_focus`, `surface_new`, `surface_close` rows. Add a Change-history row.
- Fix stale RPC-table rows (#236 drift, opportunistic, same file): `pane.split` params →
  `{ direction, workspaceId? }`; `surface.new` params → `{ workspaceId?, shell?, cwd? }`.
- `docs/api/mcp-plugin-spec.md` §2.4 (the residual-risk + curated-allowlist writeup): record that
  surface lifecycle (new/close) is now consciously first-party-reachable, with the §6 rationale.
- `firstParty.ts` header comment (lines 27-37) + the test's `ALLOWED_RESERVED_FIRST_PARTY` comment:
  soften "observe/message only, not lifecycle/mutation" to reflect the conscious inclusion of
  surface lifecycle for the supervisor use case.
- `CHANGELOG.md` `[Unreleased]`: one line, credit @zhenzoo (issue #285).
- `docs/api/reference.md` (gen-api-reference.mjs): **unchanged** — no new RPC method. Run
  `node scripts/gen-api-reference.mjs --check` to confirm zero drift.

## 5. (removed) — surface_* is now IN scope per DR-3.

## 6. Security review — first-party reserved widening (the DR-3 deliverable)

**Invariant being softened** (`firstParty.test.ts`, #113 follow-up): *"first-party bypass never
reaches a reserved (`wmux.internal`) lifecycle/mutation method."* `surface.new` (PTY create) and
`surface.close` (PTY dispose) ARE reserved lifecycle/mutation. Adding them to
`ALLOWED_RESERVED_FIRST_PARTY` is a conscious erosion of this defense-in-depth invariant.

**Conclusion: ACCEPTABLE within the documented same-user threat model.** Rationale:

1. **Same-user ceiling — no boundary lost.** First-party recognition is best-effort attribution by
   self-asserted `clientName`, explicitly NOT a security boundary (firstParty.ts threat model). A
   same-user impersonator already holds the daemon auth token and can hit the pipe directly. The
   reserved invariant is defense-in-depth, not a wall.
2. **Already reachable today.** (a) `surface.new`/`close` are in `WMUX_CLI_METHODS` — `wmux surface
   new`/`close` already reach them via the wmux-cli tier. (b) The legacy grandfather (clientName
   omitted → allow) is still OPEN (Stage 3 hasn't closed it), so ANY same-user caller reaches them
   today by omitting clientName. The marginal new reach is exactly: the bundled MCP under the named
   hosts `claude-code`/`codex-mcp-client` — the trusted agent hosts, by definition the legitimate
   first-party set.
3. **Forward-looking (post-Stage-3).** Once the grandfather closes, name-recognized clients are
   limited to `FIRST_PARTY_METHODS`. Including surface lifecycle means a `claude-code`/`codex`
   *impersonator* could create/destroy PTYs in any workspace — but that impersonator is same-user
   (holds the token) and has strictly more powerful direct options. No capability is granted that
   the attacker didn't already have.
4. **Mitigations intact.** `surface.new` is workspaceId fail-closed (explicit unknown ws → reject,
   no active fallback). `surface.close` is all-ws-by-id (UUID opacity). Pane cap (20) bounds PTY
   creation. Renderer orphan-guard disposes leaked PTYs.
5. **Blast radius.** Worst case: a same-user process spoofing `clientName=claude-code` spawns/kills
   terminals in the user's own workspaces. Disruptive, not privilege escalation or a cross-user
   breach. Bounded by the OS-user account (the documented trust ceiling, #113 / trust-root epic).

**Least-privilege preserved elsewhere.** We do NOT add `workspace.new`/`workspace.close`/`daemon.*`/
`company.*` mutation. The `firstParty.test.ts` "does not allowlist reserved/destructive surface"
check (daemon.shutdown, workspace.new, ...) stays green.

## 7. Open questions — resolved

- Q1 (DR-1): caller-own-ws → active fallback. **Resolved → A.**
- Q2 (DR-3): include surface_*. **Resolved → include now (with §6 review).**
- Q3: fix stale inventory rows. **Yes (cheap, same file).**
- Q4: `pane_split` direction default. **`horizontal`** (caller can override). ptyWarning echoed
  verbatim via callRpc JSON.

## 8. Test plan (DR-4 — both layers)

**New — `src/mcp/__tests__/paneLifecycle.test.ts`** (captured-handler harness, mirror
`index.channel.test.ts`; fake `server.tool` capture + mocked `callRpc` + identity
`resolveCallerWorkspaceId`):

- `pane_split`: explicit ws → `callRpc('pane.split',{direction,workspaceId})`; omitted ws → resolver
  called, resolved id forwarded; omitted + resolver `''` → `{direction}` only (no ws); `direction`
  omitted → `'horizontal'`; explicit `'vertical'` forwarded.
- `pane_close`: `{paneId:'p1'}` → `callRpc('pane.close',{id:'p1'})`.
- `pane_focus`: `{paneId:'p1'}` → `callRpc('pane.focus',{id:'p1'})`.
- `surface_new`: explicit ws / omitted-resolved; `shell`+`cwd` passthrough; neither → `{}`/resolved only.
- `surface_close`: `{surfaceId:'s1'}` → `callRpc('surface.close',{id:'s1'})`.
- registration: all 5 tools present.

**Extend — `src/main/mcp/__tests__/firstParty.test.ts`** (AUTO-forced):
- "covers every valid RpcMethod" → will fail until the 5 methods are in `FIRST_PARTY_METHODS`.
- reserved exception → will fail until `surface.new`/`surface.close` are in
  `ALLOWED_RESERVED_FIRST_PARTY`; update that set + its prose.

**Extend — `src/mcp/__tests__/workspaceRouting.test.ts`** (DR-4 guard kept):
- The "exactly 3 direct `resolveWorkspaceId()` calls in index.ts" invariant **stays green** because
  paneLifecycle.ts uses the injected resolver, not the weak resolver directly. Add a one-line note
  that the create-family routing for pane_split/surface_new is covered by paneLifecycle.test.ts.
- **Wiring guard (codex P2):** the behavioral tests call `registerPaneLifecycleTools` directly, so
  nothing fails if `index.ts` forgets to wire it (the lockstep only scans for `callRpc` literals,
  which exist in paneLifecycle.ts regardless of wiring). Add a source-level assertion that
  `index.ts` contains `registerPaneLifecycleTools(` — mirrors how `registerChannelTools(` is wired
  at index.ts:894. Cheap, closes the "tool silently never registers" hole.

**Extend — `src/main/mcp/__tests__/PermissionEnforcer.firstParty.test.ts`**:
- Assert `claude-code` is ALLOWED for `pane.split`/`pane.close`/`pane.focus`/`surface.new`/
  `surface.close` under enforce.

**Unchanged (already covered by #238/#256/#257):** the RPC handlers themselves
(fail-closed, eager-spawn, non-leaf/root reject, non-yank, orphan-guard, PTY dispose).

**Live dogfood (enforce mode)** — isolated instance (`WMUX_DATA_SUFFIX`) + packaged build +
`~/.wmux/config.json` `{ "mcp": { "mode": "enforce" } }`, `claude-code`-stamped MCP round-trip:
`pane_split` (own ws + explicit background ws) → `pane_list` confirms new pane → `pane_focus`
(verify non-yank: active ws unchanged) → `surface_new` → `surface_list` confirms → `surface_close`
→ `pane_close` → `pane_list` confirms reap. Assert rejections: non-leaf close, root close, unknown
explicit ws on split.

## 9. Files touched

| File | Change |
|---|---|
| `src/mcp/paneLifecycle.ts` | **NEW** — `registerPaneLifecycleTools` (5 tools) |
| `src/mcp/index.ts` | +1 import, +1 `registerPaneLifecycleTools(...)` call |
| `src/main/mcp/firstParty.ts` | +5 `FIRST_PARTY_METHODS` entries; soften header comment |
| `src/mcp/__tests__/paneLifecycle.test.ts` | **NEW** — behavioral tests (10+ paths) |
| `src/main/mcp/__tests__/firstParty.test.ts` | +2 in `ALLOWED_RESERVED_FIRST_PARTY` + prose |
| `src/main/mcp/__tests__/PermissionEnforcer.firstParty.test.ts` | +5-method enforce assertions |
| `src/mcp/__tests__/workspaceRouting.test.ts` | note (guard already covers) |
| `docs/api/inventory.md` | +5 MCP-tool rows, change-history, stale RPC-param fixes |
| `docs/api/mcp-plugin-spec.md` | §2.4 reserved-surface note |
| `CHANGELOG.md` | `[Unreleased]` line, credit @zhenzoo |

No renderer, no daemon, no new RPC, no new capability, no `methodCapabilityMap.ts` change.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_OPEN | 4 decisions locked (DR-1..4), 0 critical gaps |
| Outside Voice | `/codex review` | Independent 2nd opinion | 1 | issues_found | 2: surface_* widening (defer?), index-wiring test gap |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (no UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** verified plan claims against source; no factual errors, no tool-name collision, no
gen-api drift. Two findings — (1) `surface_*` reserved-widening is thin vs the pane-lifecycle goal →
recommends defer; (2) behavioral tests don't protect index.ts wiring → add a source-level
`registerPaneLifecycleTools(` assertion (folded into §8).

**CROSS-MODEL TENSION** — `surface_new`/`surface_close` scope:
- Eng-review initial read (§5) + Codex finding #1 both recommend **DEFER** surface_* (reserved
  lifecycle widening isn't needed for the worker-pane create/teardown goal; pane.split/close already
  cover it).
- User chose **INCLUDE** (DR-3). Per user sovereignty this stands — but it is the one open tension,
  and it intersects the "release channels first?" question: if #285 is parked, the decision defers
  for free and can be revisited with fresh eyes.

**UNRESOLVED:** 1 (surface_* include-vs-defer — user chose include; codex+eng-initial lean defer).

**VERDICT:** ENG REVIEW COMPLETE — plan is implementation-ready for the 3 pane tools. The 2-tool
surface_* extension carries a conscious security-invariant softening (§6) that the outside voice
would rather defer. No critical gaps. Codex test-gap finding folded in.
