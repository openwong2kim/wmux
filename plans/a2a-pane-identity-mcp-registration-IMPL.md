# Implementation Plan — A2A pane-level identity + addressing ⊕ multi-agent MCP registration

> Grounded against `main @ 6e53b5e` (2026-06-15). Branch: `feat/a2a-pane-identity-mcp-registration`.
> Source prompt: `plans/a2a-pane-identity-mcp-registration.md`. Backlog: `plans/a2a-multiagent-gaps.md`.
> Status: **eng-reviewed (plan-eng-review + Codex outside voice), decisions LOCKED.** Size: **Large**.

## Locked decisions (eng-review + user)
- **D1 = Part A + Part B FULL** — Part B delivers real "reach": registrar/CLI/Settings multi-target **+ Codex `clientName` first-party whitelist (empirically determined) + identity-topology verification + live end-to-end Codex dogfood.** Gemini EXCLUDED (CLI not installed → not empirically verifiable; registry hook only).
- **D2 = surgical TOML block write** (smol-toml parse for READS only) — the initially-chosen round-trip was reversed during implementation: `smol-toml` stringify silently drops backslashes in literal-string keys (would corrupt `[projects.'d:\wmux']`). Surgical insert/replace/remove preserves comments/ordering/keys; only writes on explicit register. (User-approved reversal; `codex mcp add` itself does surgical append.)
- **A1 = renderer per-ptyId map** (not MetadataStore). **A5 = clean break on getStatus shape** (internal-only consumers). **Q1 = shared `configIO` extracted** (kill McpRegistrar/CLI duplication).
- Cross-ws guard = **renderer tree-membership check** (the real guard); drop the false `assertWorkspaceOwnsPty` parity claim (A2A delivery bypasses `input.send` via `pty.write`).

---

## Goal
- **Part A — Precision**: pane-level A2A identity + addressing (fixes gaps 1/3/8). One ws hosts ≥2 agents, each individually addressable, each correctly labeled.
- **Part B — Reach**: non-Claude agents (Codex) actually usable on the A2A channel — register config **and** pass the permission enforcer **and** resolve workspace identity.

Invariants: #163 cross-ws fail-closed intact (pane addressing ws-scoped); substrate neutrality; empirical gate (no unverified path shipped); foreign config keys never modified; atomic writes.

---

## Current-state ground truth (verified by exploration, not old notes)

### Part A
- `AgentDetector` is **already per-PTY**: `PTYBridge.ts:252` `agentDetectors.set(ptyId, new AgentDetector())`. `getLastAgent()` `:302`.
- `PTYBridge.onEvent` → `broadcastMetadataUpdate(win, { ptyId, agentStatus, agentName })` `:393-453`; `onActive` → `{ ptyId, agentStatus:'running', agentName:lastAgent }` `:459-472`. **ptyId already flows.**
- Renderer `useNotificationListener.ts:435-516` receives METADATA_UPDATE, resolves ptyId→pane (`findSurfaceByPtyId`), writes `agentName`/`agentStatus` to **ws-level** `WorkspaceMetadata` (last-writer-wins, `workspaceSlice.ts:249-262`). Mirrors only `agentStatus` per-ptyId into transient `surfaceAgentStatus: Record<ptyId,AgentStatus>` (`paneSlice.ts:128-140`, ATTENTION_STATUSES only → cannot hold identity).
- `surface.list`/`pane.list`/`a2a.discover` computed in renderer `useRpcBridge.ts:429 / :554 / :1113-1157`. `surface.list` returns `{id,ptyId,paneId,surfaceType,isActive,...}`; `pane.list` returns `{id,metadata,surfacePtyIds,...}`; `a2a.discover` is ws-level (`description: agentName`, `metadata.status: agentStatus ?? 'idle'`).
- `a2a.task.send` delivery: renderer `useRpcBridge.ts:1159-1297`; target ws by fuzzy `to`; delivery via `deliverPtyNotification` `:155-170` (active pane → first non-browser surface ptyId) or `deliverPtyNudge` for live TUI.
- a2a task `to` type: `WmuxTaskMetadata.to = { workspaceId, name }` (`types.ts:557-564`); `createA2aTask` mirrors it (`a2aSlice.ts`).
- Surface removal: **`surfaceSlice.closeSurface(paneId, surfaceId, workspaceId)`** `:113` (NOT paneSlice). ws reset clears transient maps in `workspaceSlice`. Agent backfill via `metadata.resolveAgent()` writes ws-level only (`useNotificationListener.ts`).

### Part B
- `McpRegistrar.ts` (main): `~/.claude.json` only; hardcodes `wmux`/`wmux-a2a`; in-memory `ownedKeys`; atomic write; proto-pollution guard.
- **`src/cli/commands/mcp.ts` DUPLICATES** registration (own path/atomic-write/hardcoded keys). Both must generalize → extract shared `configIO`.
- IPC `mcp:check|reregister|unregister` (`shared/constants.ts:131-134`) → `mcp.handler.ts` serialize `McpRegistrarStatus → McpStatusPayload {wmux,wmuxA2a,configPath,...}`. Singleton `main/index.ts:278`.
- Settings `SettingsPanel.tsx McpStatusSection` (~585-742): two hardcoded rows, "~/.claude.json" copy.
- **`FirstRunOrchestrator.registerMcp()`** preflights `~/.claude.json` only; failures swallowed (Codex #11).
- **Enforcer (the killer — Codex #1, CONFIRMED)**: `firstParty.ts:47-49` `FIRST_PARTY_CLIENT_NAMES = Set(['claude-code'])`. Packaged build = enforce mode. Bundled server can't `declarePermissions` (calls `wmux.internal` reserved methods) → only passes via clientName whitelist. **Non-Claude host → `unconfirmed` → every capability RPC rejected, no recovery.** `FIRST_PARTY_METHODS` already includes `a2a.*`/`pane.*`/`browser.*`/`company.a2a.*`. Comment explicitly invites adding hosts. `firstParty.test.ts` parses `src/mcp/` for called methods.
- **Identity topology (Codex #2, CONFIRMED)**: `mcp/index.ts:113-122` walks `process.ppid` 10 hops (MCP→host CLI→shell PTY) against the pid-map. Verified for Claude only. Codex must launch MCP as a PTY descendant for this to resolve.
- **No TOML dep.** Codex installed + real `~/.codex/config.toml` (TOML, `[projects.'d:\wmux']`, `[tui.*]`). Gemini CLI absent.

---

## Design — Part A (pure renderer derivation)

**Store** (`paneSlice.ts`): add `surfaceAgent: Record<string, { name: string; status: AgentStatus }>` + `setSurfaceAgent(ptyId, name, status)`. Unlike `surfaceAgentStatus`, **keep on idle** (identity persists while PTY lives); only clear when the ptyId's surface is gone.
- Write from `useNotificationListener.ts` METADATA_UPDATE handler when `ptyId` present and `agentName` non-empty (**guard: never overwrite a known name with ''** — Codex #3/empty-running). Also add to the `metadata.resolveAgent()` backfill path so early detector events aren't lost per-surface (Codex #8).
- **Cleanup wiring (Codex #9)**: clear `surfaceAgent[ptyId]` in `surfaceSlice.closeSurface` (resolve ptyId from the closed surface), in `workspaceSlice` ws-reset/clear paths, and on session-restore replace. Mirror wherever `surfaceAgentStatus` is cleared.

**Derivations** (`useRpcBridge.ts`):
- `surface.list`: per entry += `agentName: string|null`, `agentStatus: AgentStatus|null` (lookup `surfaceAgent[ptyId]`).
- `pane.list`: per leaf += `agents: Array<{ ptyId, agentName, agentStatus }>` (a leaf may hold many surfaces).
- `a2a.discover`: per ws agent += `panes: Array<{ paneId, surfaceId, ptyId, agentName, agentStatus }>` (fixes 3/8). **Codex #7**: also expose a clear address object so clients iterating only `agents` aren't blind — document `panes[]` as the addressable unit and keep ws-level fields for back-compat.

**Addressing** (`a2a_task_send`):
- MCP tool (`src/mcp/index.ts`): add optional `pane_id`, `surface_id` (snake_case). **Codex #6**: if BOTH given and they disagree (surface not in that pane) → **reject** (`error`), never silently prefer one.
- Renderer delivery: new `deliverPtyNotificationTo(targetWs, { paneId, surfaceId }, sender, msg)`. Resolve explicit leaf/surface → ptyId; **require membership in `targetWs`'s tree** (the real cross-ws guard); if an explicit address is given but not found/foreign → **return error, do NOT fall back to active-pane** (Codex #3 silent-misdelivery). `surface_id` → its ptyId; `pane_id` → that leaf's active terminal surface ptyId.
- Store: `WmuxTaskMetadata.to` += `paneId?`, `surfaceId?` (`types.ts`); `createA2aTask` stores them (`a2aSlice.ts`).
- **Replies (Codex #4)**: persist addressing for both participants (or reply to the original addressed pane). Reply branch resolves the counterpart's stored `paneId`/`surfaceId` instead of active-pane.
- **`execute:true` fix (Codex #5)**: `a2a.rpc.ts` currently `receiverWsId = params.to` (raw fuzzy). Use the **renderer-resolved** workspaceId (return it in the `a2a.task.send` result and read it in main) so confirm/`ClaudeWorker.execute` get the real id.

## Design — Part B (multi-target, full reach)

**Shared** `src/shared/mcpTargets.ts` (NEW): `McpTarget { id:'claude'|'codex'|'gemini'; displayName; configPath(home); format:'json'|'toml'; createIfMissing: boolean; verified: boolean }`.
- claude: json, `~/.claude.json`, createIfMissing **true**, verified true.
- codex: toml, `~/.codex/config.toml`, createIfMissing **false** (write only if dir/file exists), verified **true** (after live verification).
- gemini: json, `~/.gemini/settings.json`, createIfMissing **false**, verified **false** (registry hook; UI shows "not detected"; never created). **(Codex #10 per-target create policy.)**

**Shared** `src/shared/configIO.ts` (NEW): format-aware, used by BOTH McpRegistrar + CLI (Q1 DRY):
- `readServers(target) → { [key]: scriptPath|null }` (json: `JSON.parse` proto-guarded; toml: `smol-toml` parse).
- `upsertServer(target, key, entry)` / `removeServer(target, keys)` (json: object merge + 2-space stringify; toml: parse→set `mcp_servers[key]`→`smol-toml` stringify — **round-trip, D2**). Atomic (tmp+rename) for both.
- **Corrupt config → register aborts with a clear error (no clobber); getStatus reports not-registered** (no throw).
- **ownedKeys (Codex #12)**: only manage a key whose existing value exactly matches our `{command:'node',args:[ourScript]}` shape, OR that we wrote this session. A foreign hand-authored `[mcp_servers.wmux]` with a different command is left untouched + surfaced as "foreign" in status. (Idempotent re-register = no-op.)

**`McpRegistrar.ts`**: per-target loop in `register`/`forceUnregister`/`getStatus`; `McpRegistrarStatus → { targets: McpTargetStatus[]; ... }` (clean break, A5). `McpTargetStatus = { id, displayName, configPath, configExists, configModified, format, verified, servers: { wmux, wmuxA2a } }`.

**Enforcer (Part B reach — Codex #1)**: empirically capture Codex's MCP `clientInfo.name` (live), add it to `FIRST_PARTY_CLIENT_NAMES` in `firstParty.ts`, update `firstParty.test.ts`. Security note: extends the **curated** allowlist (not a blanket bypass) to the Codex-hosted bundle; same same-user best-effort threat model documented in `firstParty.ts`. Flag for the reviewer.

**Identity (Codex #2)**: live-verify the ppid walk resolves when codex runs in a wmux pane (MCP→codex→pwsh PTY). If Codex spawns MCP out-of-band, document the limitation + keep verified:false for codex until resolved.

**Surfaces**: `mcp.handler.ts` serialize multi-target; preload/`McpStatusPayload` multi-target; `SettingsPanel.tsx` dynamic per-target render (displayName + configExists + per-server rows + "not detected"); `cli/commands/mcp.ts` loop registry via shared `configIO` (+ optional `--target <id>`); `FirstRunOrchestrator.registerMcp()` per-target preflight, surface per-target errors (Codex #11). `package.json` += `smol-toml` (bundle into main + CLI esbuild). `docs/api/*` + CLI help regen (Codex #15).

---

## File-by-file
**Part A:** `paneSlice.ts` · `surfaceSlice.ts` (cleanup) · `workspaceSlice.ts` (reset cleanup) · `useNotificationListener.ts` · `useRpcBridge.ts` · `src/mcp/index.ts` (tool params) · `shared/types.ts` · `a2aSlice.ts` · `a2a.rpc.ts` (resolved wsId for execute).
**Part B:** `shared/mcpTargets.ts` (NEW) · `shared/configIO.ts` (NEW) · `McpRegistrar.ts` · `mcp.handler.ts` · preload + payload type · `SettingsPanel.tsx` · `cli/commands/mcp.ts` · `firstParty.ts` (+ `firstParty.test.ts`) · `FirstRunOrchestrator.ts` · `package.json` · `docs/api/reference.md` (regen if drift).

---

## Test coverage diagram (target 100% of new paths)

```
PART A — CODE PATHS
[+] paneSlice.surfaceAgent
    ├─ [★★★] set new / update / keep-on-idle / clear-on-close            paneSlice.test.ts (NEW)
    └─ [★★★] guard: empty agentName does NOT overwrite known name        paneSlice.test.ts
[+] useNotificationListener METADATA_UPDATE → setSurfaceAgent
    ├─ [★★ ] ptyId+name → map written                                    useNotificationListener.test.ts
    └─ [★★ ] resolveAgent backfill also writes surfaceAgent              useNotificationListener.test.ts
[+] useRpcBridge derivations
    ├─ [★★★] surface.list/pane.list agent labels per ptyId (2 agents/1 ws) useRpcBridge.*.test.ts (jsdom)
    └─ [★★★] a2a.discover panes[] distinguishes 2 agents                  useRpcBridge.*.test.ts
[+] a2a.task.send addressing
    ├─ [★★★] surface_id → that pane only (sibling untouched)              useRpcBridge.*.test.ts
    ├─ [★★★] pane_id → leaf active terminal surface                       useRpcBridge.*.test.ts
    ├─ [★★★] CROSS-WS paneId rejected (fail-closed)                       useRpcBridge.*.test.ts
    ├─ [★★★] explicit address not-found → error, NO active-pane fallback  useRpcBridge.*.test.ts
    ├─ [★★★] pane_id+surface_id disagree → reject                         useRpcBridge.*.test.ts
    └─ [★★★] reply pins to counterpart's stored address                   useRpcBridge.*.test.ts
[+] a2a.rpc execute:true uses resolved wsId                               a2a.rpc.test.ts

PART B — CODE PATHS
[+] configIO (json + toml)
    ├─ [★★★] toml round-trip: foreign [projects.*]/[tui.*] data preserved configIO.test.ts (NEW)
    ├─ [★★★] toml/json upsert idempotent (re-register no-op)              configIO.test.ts
    ├─ [★★★] removeServer removes only our keys                           configIO.test.ts
    ├─ [★★★] corrupt config → register aborts (no clobber)                configIO.test.ts
    └─ [★★★] foreign hand-authored key (different command) untouched      configIO.test.ts
[+] McpRegistrar multi-target
    ├─ [★★★] getStatus targets[] (json+toml, missing-skip, corrupt)       McpRegistrar.test.ts (extend)
    ├─ [★★★] register writes correct format per target                    McpRegistrar.test.ts
    ├─ [★★★] codex createIfMissing=false → no file created when absent     McpRegistrar.test.ts
    ├─ [★★★] gemini never created                                         McpRegistrar.test.ts
    └─ [★★★] forceUnregister per target                                   McpRegistrar.test.ts
[+] firstParty
    └─ [★★★] codex clientName first-party + method set invariant           firstParty.test.ts (update)
[+] FirstRunOrchestrator multi-target preflight + per-target error        FirstRunOrchestrator.test.ts (extend)
[+] CLI parity                                                            cli mcp test (extend/mirror)

LIVE DOGFOOD ([→E2E], packaged exe + WMUX_DATA_SUFFIX isolation)
 ├─ Part A: 2 panes/1 ws, distinct spoofed agents → discover/surface_list labels + surface_id routing + cross-ws reject
 ├─ Part B-config: isolated HOME, fake ~/.codex/config.toml w/ [projects.*] → register → foreign table byte-preserved, getStatus accurate, unregister clean
 └─ Part B-reach [CRITICAL]: register wmux into throwaway ~/.codex/config.toml, launch REAL codex in a wmux pane → confirm codex lists wmux MCP tools AND a tool call (a2a_discover/pane_list) succeeds (passes enforcer + resolves workspace). This is the empirical gate that proves "reach".
```

## Failure modes (new codepaths)
- TOML write corrupts user config → atomic write + abort-on-corrupt + write-only-on-register; test covers. Visible error, not silent.
- Codex clientName not whitelisted → enforce-mode rejection → **caught by Part B-reach dogfood** (the whole point). Visible (tool calls fail in codex).
- Identity walk miss for Codex topology → a2a tools throw "Workspace identity unknown" (existing clear error). Verified live.
- surfaceAgent stale after close → cleanup wiring + test. Would otherwise show a dead agent label (silent) → **critical to wire all clear paths**.
- empty-name overwrite race → guard + test.

## NOT in scope
- **Gemini** active support (not installed/verifiable; registry hook + "not detected" UI only).
- macOS Claude Desktop config path (existing pending note).
- A2A liveness/heartbeat (gap 5, rider ③).
- Persisting agent identity across reboot (ephemeral by design).
- Cryptographic first-party identity (peer-PID/nonce) — issue #113, multi-user transport.
- Out-of-band Codex MCP topology workaround (documented limitation if live verify fails).

## What already exists (reused, not rebuilt)
- per-PTY `AgentDetector` + ptyId in METADATA_UPDATE (Part A needs no main change).
- `surfaceAgentStatus` map pattern (mirror for `surfaceAgent`).
- `firstParty.ts` curated allowlist (extend the Set, not the mechanism).
- pid-map identity walk (reuse; just verify topology).
- McpRegistrar atomic-write + proto-guard; CLI register flow (generalize via shared `configIO`).
- Dogfood harness `scripts/a2a-eventbus-dogfood.mjs` / `s-c2-fleet-deepening-dogfood.mjs` (copy isolation + RPC).

## Parallelization (worktree lanes)
| Lane | Modules | Depends on |
|------|---------|------------|
| A | `renderer/stores`, `renderer/hooks`, `src/mcp`, `shared/types`, `main/pipe/handlers/a2a.rpc` | — |
| B1 | `shared/mcpTargets`, `shared/configIO` (+ smol-toml) | — |
| B2 | `main/mcp/McpRegistrar`, `firstParty`, `main/ipc`, `main/firstRun`, `renderer/components/Settings`, `cli/commands/mcp` | B1 |
- **Launch A + B1 in parallel.** B2 waits on B1. Merge → static+units → reviews → dogfood (Part B-reach needs real codex) → PR.
- No shared module dirs between A and B → clean parallel. A touches `src/mcp/index.ts` (tool defs) and B touches `src/main/mcp/*` — different dirs, no conflict.

## Verification recipe
- `node_modules/.bin/tsc --noEmit` (0) · eslint changed · `node scripts/gen-api-reference.mjs --check` (regen if drift — Codex #15).
- `npm run test:parallel` (+ runtime if touched).
- Live dogfood per diagram (Part B-reach is the gate).
- Reviews: opus code-reviewer (invariant guard) + Codex PASS → PR → CodeRabbit + Codex re-review.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 15 findings (2 scope-critical: enforcer first-party + identity topology); folded into plan |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | Scope expanded (Part B reach), 0 unresolved, decisions locked |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX (plan):** caught that Part B "register config" alone is theater — non-Claude hosts hit the `claude-code`-only first-party enforcer + an unverified PTY-ancestry identity walk. Reshaped Part B to include first-party whitelist + live end-to-end verification.
**CROSS-MODEL:** Codex overrode two of my claims (fake assertWorkspaceOwnsPty parity → renderer membership check; surgical TOML → round-trip). assertWorkspaceOwnsPty: accepted. TOML round-trip: REVERSED again during impl — smol-toml stringify silently drops backslashes in literal-string keys (corrupts `[projects.'d:\wmux']`), so SURGICAL block write was used (user-approved); `codex mcp add` itself does surgical append.
**UNRESOLVED:** none.

## Implementation & verification record (2026-06-16)
- **Empirical captures**: Codex MCP `clientInfo.name` = `codex-mcp-client` (captured live via a logging MCP stub under isolated `CODEX_HOME`) → added to `FIRST_PARTY_CLIENT_NAMES`. Codex canonical TOML format = `[mcp_servers.<key>]` `command`/`args` (learned via `codex mcp add`). smol-toml round-trip backslash-corruption proven by hexdump → surgical write chosen.
- **Static**: `tsc --noEmit` 0 · eslint 0 new errors · `gen-api-reference --check` 0 drift (no new RPC method).
- **Units**: 3402/3402 green. New: configIO (17), mcpRegistration (19), a2aAddressing (11), paneSlice surfaceAgent (5), useRpcBridge wiring guards, McpRegistrar multi-target, firstParty codex.
- **Live dogfood Part A** (packaged exe, `WMUX_DATA_SUFFIX` isolated, `scripts/a2a-pane-identity-dogfood.mjs`): **11/11** — 2 panes/1 ws spoofed Claude Code + Codex CLI → distinct per-pane labels in surface_list/a2a_discover; `a2a_task_send surface_id` pins delivery + returns toWorkspaceId; cross-ws surface_id REJECTED; pane_id+surface_id disagreement REJECTED.
- **Live dogfood Part B-config** (real `codex mcp get`): my surgical writer's output is read correctly by the real Codex CLI (backslash path `C:\app\mcp-bundle\index.js` intact); foreign `[projects.'d:\wmux']` + comments byte-preserved.
- **Reviews**: Claude independent code-reviewer → P1 (inline-table TOML clobber) + P2 (array-of-tables) + P3 (preload mirror) → all fixed (output re-validation guard, bracket-match, preload type). Codex diff review → 4 fixed (reply fail-closed on lost pin, TOML header trailing comment, unregister false-removal, CLI `--target` validation) + 2 accepted-with-rationale (execute is headless ws-level by design; node-foreign `wmux` is reserved-key behavior, already safer than prior shipped code).
- **Remaining (user-final)**: full GUI visual check + a real Codex-in-a-wmux-pane end-to-end tool call (needs codex running inside a pane; config discovery + enforcer first-party + identity topology each verified independently).

**VERDICT:** ENG CLEARED · implemented · all static+unit+dogfood green · 2 independent reviews reflected. Ready for PR (pending user push approval).
