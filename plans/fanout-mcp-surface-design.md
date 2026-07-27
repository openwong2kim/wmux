# Fan-out on the MCP / pipe surface — design (2026-07-28)

## 0. Why

`plans/as-is-to-be-2026-07-28.md` §0.3 concludes that two moats survived: **reboot
survival** and **wmux exposing itself as MCP**. Fan-out — the marquee journey (J1)
— is missing from the second one. `src/main/ipc/handlers/fanout.handler.ts` is a
renderer-only `ipcMain.handle` surface; it is not registered on the pipe
`RpcRouter`, so an MCP client cannot run a fan-out. A human has to open the GUI
modal. This PR closes that gap.

The interesting part of this change is not the plumbing — `pane.rpc.ts` already
imports `sendToRenderer`, so there was never a technical barrier. The barrier was
a **trust decision**: the IPC path treats every field of the request as
renderer-authored, i.e. human-authored. The wire is not. So the wire handler is a
*different* handler with a *narrower* input contract that happens to reuse the
same service.

## 1. Scope

**In**

- One new pipe RPC: `task.fanout.start` (+ `RpcMethod` union, capability map,
  first-party allowlist, generated API reference).
- One new MCP tool: `fanout_start`.
- One new MCP tool for the status read: `channel_mission_list` — a thin wrapper
  over the **existing** `task.mission.list` RPC (already registered on the pipe
  router at `a2a.channel.rpc.ts:287`). **No new query RPC is added.**
- `FanOutService` becomes a single shared instance injected into both the IPC
  handler and the pipe handler.

**Out (explicitly not this PR)**

- Diff adoption, PR creation, task close from the wire.
- Any change to the renderer IPC path's input contract (`agentCmd`, `repoPath`,
  `verifiedWorkspaceId` stay caller-supplied there — they are human-typed).

### 1.1 Reusing the existing query RPC (scope requirement)

`task.mission.list` is already pipe-registered and already returns exactly what a
fan-out caller needs: for the caller's workspace, every WorkTask with `taskId`,
`title`, `status`, `missionChannelId`, and the materialised `branch` /
`worktreePath` / `paneGroupId` fields that `FanOutService` step ④ commits. Fan-out
tasks are born owned by the calling workspace (`§5.1 born-owned`), and
`task.mission.list` is owner-scoped, so a caller's fan-out tasks are precisely its
`task.mission.list` result. **No new RPC.** The only thing missing was an MCP
*tool* over it (J0 shipped `channel_mission_start` / `channel_mission_close` but
not `list`), so this PR adds the tool and nothing else on the server.

## 2. Trust boundary

### 2.1 What the two paths actually are

| | renderer IPC (`fanout:start`) | pipe RPC (`task.fanout.start`) |
|---|---|---|
| transport | `ipcMain.handle`, Electron process boundary | named pipe / loopback TCP, `RpcRouter` |
| who authored the fields | a human, in the GUI modal | an agent, possibly one wmux is supervising |
| `agentCmd` | typed by the human → trusted | **never read** |
| `repoPath` | typed by the human → trusted | must be the caller's own repo |
| `verifiedWorkspaceId` | the renderer's active workspace → trusted | **never read**, derived server-side |
| identity basis | Electron process boundary | `senderPtyId` → `input.findOwnerWorkspace` (D5) |

The pipe handler is therefore not "the IPC handler with a router registration". It
is a separate registrar that constructs a `FanOutRequest` from a **strict subset**
of caller input plus server-derived values.

### 2.2 Ceiling being claimed

Identity here rides the same D5 anchor as `a2a.channel.*` mutations: a
caller-supplied `senderPtyId` resolved by the renderer to the workspace that owns
that pty *right now*. Per the honesty note in `a2a.channel.rpc.ts:34-43`, that is
**advisory attribution under the #113 same-user ceiling**, not an unforgeable
cross-user boundary: a same-user process can enumerate live ptyIds via
`a2a.discover` and assert one. This PR does not claim to fix #113 and does not
widen it — it deliberately reuses the *strongest anchor the pipe currently has*
rather than inventing a weaker one (e.g. trusting `WMUX_WORKSPACE_ID`, or
accepting a self-asserted `verifiedWorkspaceId`).

What the anchor *does* buy, and why it matters here: a caller that cannot resolve
a pty at all (headless script, renderer composer, LAN bridge) gets **zero**
fan-out, fail-closed. That is the same posture channel mutations already take.

## 3. The seven security requirements

### R1 — `agentCmd` is never read from the wire

`normalizeRequest` (IPC) reads `r['agentCmd']` and defaults to `'claude'`. On the
wire that is arbitrary command execution: `FanOutService.buildInitialCommand`
interpolates `agentCmd` verbatim into the shell line
``${agentCmd} "$(cat '${path}')"`` which is then written to a PTY.

The pipe handler **does not have an `agentCmd` input at all**. It sets
`agentCmd: FANOUT_WIRE_AGENT_CMD` unconditionally, where `FANOUT_WIRE_AGENT_CMD`
is the module constant `'claude'` (the same default the GUI pre-fills). A wire
caller that sends `agentCmd` has it silently ignored — not rejected — because
rejecting would leak which fields exist and would break forward compatibility for
clients that mirror the IPC shape. The MCP tool schema does not expose the field,
so a well-behaved caller never sends one.

*Rejected alternative:* an operator-configured allowlist of agent commands. That
is a config surface (`~/.wmux/config.json` read, validation, docs, drift) for a
capability nobody has asked for, and the "one setting, therefore safe" shape
invites a later PR to widen it. A hard-coded constant is a one-line diff to
change later if a real need appears.

### R2 — `verifiedWorkspaceId` is derived, never read from params

`FanOutService` uses `verifiedWorkspaceId` for three things: `task.mission.start`
ownership (born-owned), `task.mission.update` authz, and `a2a.channel.invite`
authz. A wire caller asserting it would create tasks owned by, and mission
channels belonging to, someone else's workspace.

The pipe handler resolves it exactly as `a2a.channel.rpc.ts` does — from
`senderPtyId` via the renderer's `input.findOwnerWorkspace` — and **deletes** any
caller-supplied `verifiedWorkspaceId` by construction (the handler builds a fresh
`FanOutRequest`; it never spreads `params`). An unresolvable caller is rejected.

`memberId` is likewise not read from the wire (it defaults to the resolved
workspace id inside `FanOutService`). The `'local-ui'` / `ws-human` reserved
identities are unreachable as a consequence: they are never copied from params,
and `ws-human` owns no panes so no `senderPtyId` can resolve into it. A defensive
`HUMAN_WORKSPACE_ID` rejection is kept anyway, symmetric with the channel handler.

### R3 — `repoPath` is confined to the caller's own repository

Unconstrained `repoPath` means `git worktree add` against any repository on disk,
plus a new `wtask/*` branch in it.

The handler:

1. resolves the caller's workspace (R2),
2. asks the renderer for `workspace.list` and reads that workspace's
   `metadata.cwd` (the same field the GUI pre-fills `repoPath` from —
   `FanOutDialog.tsx:56`),
3. runs `git rev-parse --show-toplevel` in that cwd → `callerRepoRoot`
   (realpath'd),
4. if the caller supplied `repoPath`, runs the same resolution on it and requires
   the two roots to be **string-equal after realpath**; otherwise rejects,
5. always passes `callerRepoRoot` (not the caller's string) to `FanOutService`.

Comparing *repository roots* rather than prefix-matching paths is deliberate: a
prefix check is defeated by symlinks and by `..`, and a subdirectory of the same
repo is a legitimate `repoPath` that `--show-toplevel` normalises for free. The
realpath is taken on both sides so a symlinked worktree cannot alias a different
repo.

A workspace with no `metadata.cwd`, or a cwd that is not a git repository, is
rejected — there is no fallback to "the active workspace" (that is how a
background agent would land on the human's foreground repo by surprise).

Before either path is handed to `git`, it is validated: non-empty, no control
characters, not starting with `-`, and `path.resolve`d. `repoPath` is passed as
the child process **cwd**, never as an argv element, so this is belt-and-braces
rather than the load-bearing defence.

### R4 — origin allowlist, fail-closed

Verbatim from the `a2a.task.send` execute precedent (`a2a.rpc.ts:437-445`):

```
local     → proceed
remote / undefined / unknown → reject
```

`RpcContext.origin` is a required field, so a future LAN transport cannot inherit
fan-out by forgetting to classify itself. Fan-out spawns N processes and mutates a
git repository; it belongs in the same lane as the execute spawn that comment
calls "blocks remote RCE".

### R5 — N is capped server-side

The GUI offers 1..8 (`FANOUT_MAX_TASKS`). `FanOutService.run()` already enforces
the same cap, but the handler re-checks it *before* the service is entered, for
three reasons: the rejection is then a wire-shaped error rather than a
`FanOutResult`; the raw array length is bounded before any per-element work (a
million-entry `titles` array is rejected on length, not after a million `trim()`
calls); and the invariant is pinned by a test at the layer a reviewer reads.

The handler also requires ≥1 non-empty title, and caps `taskPrompts.length` at the
same bound.

### R6 — prompt / title length caps server-side

- Each task's *effective* prompt (`shared + "\n\n" + per-task`, empty side
  dropped — the exact rule `FanOutService` applies) must be
  ≤ `FANOUT_PROMPT_MAX_BYTES` (8 KiB), measured in UTF-8 bytes.
- Each title must be ≤ `CHANNEL_TOPIC_MAX` (256) — the daemon's own
  `task.mission.start` limit. Checking it here means N-1 tasks are not spawned
  before task N is rejected by the daemon.

Rejection is all-or-nothing, matching the service's existing "over cap ⇒ zero
tasks created" contract; there is no partial spawn.

### R7 — approval gate: **not added**, and why

The requirement is to reuse the existing execute gate if a gate is needed, or to
justify not adding one. This design does **not** add an approval prompt. The
reasoning:

**What fan-out actually spawns.** `buildInitialCommand` produces
``claude "$(cat '<prompt file>')"`` written into a fresh PTY. That is an ordinary
interactive `claude` session with its own per-tool permission prompts. It is *not*
the `a2a` execute path, which spawns a headless worker in
`--permission-mode bypassPermissions` (`ExecuteApprovalDialog.tsx:9-12`). The
existing gate exists specifically because that mode has no downstream prompts.
Fan-out's spawn does.

**Marginal capability over what the caller already holds.** A first-party MCP
caller that can reach `task.fanout.start` already holds, on the same router:

- `input.send` / `input.sendKey` — type *any* command into a pane. Strictly more
  powerful than a fixed `claude "$(cat …)"`.
- `mcp.claimWorkspace` — create a workspace and a PTY.
- `pane.split`, `surface.new` — create panes/surfaces.
- `task.mission.start` — create WorkTasks and mission channels.

With R1–R6 applied, the only primitive fan-out adds is `git worktree add` on the
caller's **own** repo, ≤8 per call, into `~/.wmux/worktrees/<repoHash>/`, on a
fresh `wtask/*` branch that must not already exist (`TaskWorktreeManager.preflight`
fails on conflict rather than auto-suffixing). It creates no commits, rewrites no
refs, and on failure preserves rather than deletes. Gating that while leaving
`input.send` ungated would be incoherent security theatre.

**Cost of gating it.** The wire call is asynchronous (§4), so an approval prompt
would fire *after* the tool has returned "accepted". The existing gate auto-denies
after 30s. An agent fleet running unattended overnight — the exact positioning in
`as-is-to-be` §4 T1 — would silently lose every fan-out. And reusing
`requestExecuteApproval` verbatim would fold fan-out under the user's existing
`a2aAutoApproveExecute` toggle, silently widening a setting the user agreed to for
a different action.

**What replaces it.** Fan-out is loud, not silent: N workspaces appear in the
sidebar, N missions appear in the Missions section, and every task has a mission
channel with an audit trail. Accumulation is bounded by
`WORKTASK_MAX_OPEN_PER_WORKSPACE` (256) daemon-side. Reach is bounded by the
first-party allowlist plus the `a2a.channel.send` capability gate.

**Open question left for the owner** (§7): if the owner wants a gate anyway, the
cheap version is a one-line `if` in the pipe handler calling into a renderer
round-trip that reuses `requestExecuteApproval` with a `kind: 'fanout'`
discriminator on `PendingExecuteApproval` (so the dialog copy stays truthful).
That is deliberately *not* in this PR: it touches the renderer store, the dialog,
the approval inbox and i18n, and it should be a decision, not a side effect.

## 4. Asynchrony — forced, not chosen

`src/mcp/wmux-client.ts:8` sets a hard `TIMEOUT_MS = 10000` on every MCP→wmux RPC.
A fan-out of N tasks does, per task: a daemon `task.mission.start`, a
`git worktree add`, a renderer workspace+PTY spawn (`SPAWN_TIMEOUT_MS = 30000`), a
`task.mission.update`, and a channel invite — serially. N=2 already blows past 10s
on any real repository. A synchronous `task.fanout.start` would time out *by
construction* and, worse, the client's retry would re-fire it.

So the wire call is **accept-then-poll**, and the poll protocol falls out of the
idempotency LRU that `FanOutService` already maintains:

| call with key K | state | response |
|---|---|---|
| first | not seen | `{ ok: true, status: 'accepted', taskCount: N }`, run starts detached |
| again, mid-flight | in-flight | `{ ok: true, status: 'running' }` |
| again, after completion | cached | `{ ok: true, status: 'completed', result: <FanOutResult> }` |

`idempotencyKey` is therefore **required** on the wire (the GUI mints one per
submit; a wire caller must supply one it can poll with). This is the whole reason
the LRU had to be process-lifetime shared — see §5.

Two small additions to `FanOutService` serve this contract:

- `statusOf(key)` — read-only view of the LRU / in-flight set.
- `start()` no longer propagates a thrown `run()`. A throw now records a failed
  `FanOutResult` under the key instead of releasing it. Releasing the key on a
  throw would let a poll **restart** a fan-out that had already spawned tasks.
  (The GUI is unaffected: it mints a fresh key per submit and surfaces
  `{ok:false,error}` through the same toast path it already uses for service-level
  rejections.)

The detached run's rejection is caught and logged; per-task failures were already
handled inside `run()` and surface in the recorded `FanOutResult`.

## 5. One `FanOutService`, two front doors

`FanOutService`'s idempotency guarantee (`§2 G1 CRITICAL`) is an **instance**
property: the key→result LRU and the in-flight set are instance fields. Two
instances = two LRUs = the same key accepted twice = duplicate worktrees. The IPC
handler's comment already says the instance must live for the process lifetime.

So the wiring moves up:

```
src/main/worktask/createFanOutService.ts   ← port assembly (daemon RPC + renderer spawn)
                    │
     main/index.ts: const fanOutService = createFanOutService(...)   // once
                    ├──→ registerFanOutHandler(fanOutService)        // renderer IPC
                    └──→ registerFanOutRpc(router, fanOutService, …) // pipe RPC
```

`registerFanOutHandler` loses its `getDaemonClient` / `getWindow` parameters and
takes the service. The port-assembly code (including `SPAWN_TIMEOUT_MS`) moves
verbatim into `createFanOutService.ts`; no behaviour changes on the IPC path.

## 6. Surface registration checklist

Adding an `RpcMethod` touches a fixed set of places, each guarded by a test:

| file | why |
|---|---|
| `src/shared/rpc.ts` | `RpcMethod` union + `ALL_RPC_METHODS` (`system.capabilities`) |
| `src/main/mcp/methodCapabilityMap.ts` | `Record<RpcMethod,…>` — a missing entry is a tsc error. `task.fanout.start` → capability `a2a.channel.send`, risk class `a2a` (same grade as `task.mission.start`, which it calls N times) |
| `src/main/mcp/firstParty.ts` | `firstParty.test.ts` parses `src/mcp/**` for `callRpc('…')` literals and fails if a called method is not allowlisted. Adds `task.fanout.start` and `task.mission.list` |
| `docs/api/reference.md` | regenerated via `node scripts/gen-api-reference.mjs`; `scripts/__tests__/genApiReference.test.mjs` fails on drift |

Deliberately **not** touched:

- `COMMANDER_RPC_METHODS` (`shared/commanderSurface.ts`) — the commander brain's
  allow lane stays as-is. It is a supervisor, not a spawner of worktrees; least
  privilege says a new method is out until someone needs it.
- `COMMANDER_TEARDOWN_DENY` — fan-out has no teardown effect.

## 7. Open questions

1. **Approval gate** (§3 R7). Shipped without one, with the reasoning above. If
   the owner disagrees, the reuse path is sketched and is a contained follow-up.
2. **`memberId` on the wire.** Currently forced to the resolved workspace id. If a
   caller ever wants a per-agent member coordinate in the mission channel roster,
   it would need the same reserved-identity guards `a2a.channel.rpc.ts` applies.
   Out of scope here.
3. **`senderPtyId` vs `callerPid`.** `a2a.resolve.identity` supports a server-side
   process-tree walk from a caller-asserted pid, for clients (Codex) that cannot
   walk their own tree. Fan-out uses only the `senderPtyId` anchor, matching the
   channel-mutation gate. A Codex-hosted caller with no walk hit therefore cannot
   fan out. Fixing that means threading the walk into this handler too — a
   separate, mechanical change, and one that should land for *all* D5 mutations at
   once rather than for fan-out alone.
4. **Poll ergonomics.** `status: 'accepted'` returns no task ids (they do not
   exist yet). The caller polls `channel_mission_list`, or re-calls `fanout_start`
   with the same key for the full `FanOutResult`. An event on the wmux event bus
   would be nicer; it is not in scope.
