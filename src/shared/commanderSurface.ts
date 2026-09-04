// ─── Commander brain surface manifest (BYOB P4 role-gate SSOT) ──────────────
//
// The single source of truth for WHAT an orchestrator brain may touch, shared
// by every enforcement layer so the lists cannot drift:
//
//   Layer 1  src/mcp/index.ts        — in `--commander` mode the MCP child
//            registers ONLY COMMANDER_TOOL_SURFACE, so a brain's tools/list
//            simply does not contain teardown tools (fail-closed: an
//            unregistered tool cannot be called by ANY brain runtime, SDK,
//            ACP or otherwise).
//   Layer 2  src/main/pipe/RpcRouter — a request claiming the commander role
//            (a `commanderToken` field on the envelope) is validated BEFORE
//            trust/permission processing: invalid token → the whole request
//            is rejected (never demoted to an ordinary external caller);
//            valid token → TEARDOWN_DENY_METHODS are refused server-side.
//   Allow    src/main/mcp/PermissionEnforcer — a VALIDATED commander may call
//   lane     exactly COMMANDER_RPC_METHODS regardless of its MCP host's
//            clientInfo name. This is what lets a non-first-party brain host
//            (Hermes/OpenClaw) operate under production `enforce` mode: the
//            per-spawn token is the auth, not the self-declared client name.
//   SDK      src/main/deck/ClaudeSdkAdapter — DEFAULT_ALLOWED_TOOLS derives
//            from COMMANDER_TOOL_SURFACE, so the SDK auto-allow list and the
//            registered surface are the same list by construction.
//
// Threat model (plans/byob-role-gate-2026-07-17.md): a MISJUDGING brain, not
// a malicious same-user process — the #113 same-user pipe-token ceiling is
// unchanged. Design review basis: D2 (PR #401 era) allow-list, eng review +
// Codex outside voice 2026-07-17 (P0: enforce-mode lane, arg-vs-env split).

/** wmux MCP tool names (no `mcp__wmux__` prefix) a commander brain may hold.
 *  Mirrors D2: the whole read/observe family, pane spawn + drive (NEVER
 *  close/teardown), the channel/A2A comms bus, and the decision gate.
 *  browser_* and company_* are deliberately absent (out of commander scope).
 *
 *  Scope decision (GLM review, PR #475): READS are fleet-global, WRITES are
 *  confined to the commander's workspace. The brain legitimately reads other
 *  workspaces (fleet context, recovery, cross-workspace awareness) but every
 *  mutating path — terminal IO (deck.resolvePaneRoute token binding),
 *  pane.focus / pane.split / surface.new (ctx.commanderWorkspace pinning) —
 *  is server-confined to its own workspace. Same-user reads are already
 *  inside the #113 ceiling.
 *
 *  channel_mission_close is deliberately IN scope (not teardown): missions
 *  are the commander's own work objects — starting and closing them is the
 *  orchestration loop itself, unlike pane/surface teardown which destroys
 *  human terminal state. */
export const COMMANDER_TOOL_SURFACE: readonly string[] = [
  // Read / observe.
  'pane_list',
  'pane_get_metadata',
  'surface_list',
  'workspace_list',
  'terminal_read',
  'terminal_read_events',
  'wmux_search_panes',
  'wmux_events_poll',
  'channel_list',
  'channel_read',
  'channel_unread',
  'channel_get_members',
  'a2a_discover',
  'a2a_whoami',
  'a2a_task_query',
  // Spawn + drive panes (create yes; close/teardown NO — P3 gate).
  'pane_split',
  'pane_focus',
  'pane_set_metadata',
  // #977 — layout, not teardown. Stashing takes a pane off the screen and keeps
  // its session running; unstashing puts it back. pane_unstash in particular is
  // NOT optional here: pane_focus is on this surface, a stashed target answers
  // it with a PANE_STASHED error naming pane_unstash as the fix, and a remedy
  // the caller is not allowed to invoke is not a remedy.
  'pane_stash',
  'pane_unstash',
  'surface_new',
  'terminal_send',
  'terminal_send_key',
  // Fan out one job into N isolated worktrees. In scope for the same reason
  // pane_split is: it CREATES work, it never tears any down. It is also the
  // only way a brain can put a worker on its own branch at all — the brain has
  // no shell, so `git worktree add` is not an alternative it could reach. The
  // powers a wire caller might have abused are already server-derived rather
  // than caller-stated (repository, owning workspace, agent command) and the
  // spawn is gated on a human approval prompt that is never auto-approved, so
  // adding it here widens what the brain can ASK for, not what it can do
  // unattended.
  'fanout_start',
  // Channel + A2A messaging.
  'channel_create',
  'channel_post',
  'channel_join',
  'channel_leave',
  'channel_invite',
  'channel_ack',
  'channel_mission_start',
  'channel_mission_close',
  'a2a_task_send',
  'a2a_task_update',
  'a2a_task_cancel',
  'a2a_broadcast',
  'a2a_set_skills',
  'send_message',
  // Final-response barrier for the active human request. It can only close the
  // commander's own durable work after server-side worker/A2A checks.
  'deck_complete_work',
  // Decision gate — pause-and-ask, the opposite of destructive.
  'deck_ask_decision',
  // WP3 — self-resolve of the brain's OWN stale decision (server-gated:
  // auto mode + TTL elapsed + substance floor, enforced in deck.rpc.ts).
  'deck_resolve_decision',
];

/** Tools registered ONLY under `--commander` — never in the full or core
 *  profile (the full tools/list sits a few hundred bytes under its budget, and
 *  these are brain-only anyway: a pane agent has no ledger to read). A second
 *  SSOT list beside COMMANDER_TOOL_SURFACE, which is a FILTER of the full
 *  registration; this one is an ADDITION. The probe's subset invariant reads
 *  `commander ⊆ core ∪ COMMANDER_ONLY_TOOLS`, and the SDK auto-allow list
 *  derives from both lists. */
export const COMMANDER_ONLY_TOOLS: readonly string[] = [
  // Task ledger read: every task this brain owns, with rev/status/summary.
  'ledger_list',
  // The BRAIN-scoped variant of ledger_update (see COMMANDER_VARIANT_TOOLS):
  // the full/core registration of the same name is the worker's, filtered
  // out of the commander profile; this one carries the brain's statuses
  // (completed / failed / cancelled) and the force+reason override.
  'ledger_update',
  // Task lifecycle (orchestrator track, lane O2 — src/mcp/worktask.ts and
  // src/mcp/git.ts). `fanout_start` could open N tasks and nothing could
  // finish one; these are the other half of that loop, and they are
  // brain-only for the same reason the ledger tools are — a pane agent has no
  // task of its own to gate, adopt, close or open a PR for.
  'task_gate_run',
  // The cancel beside the run. Not "rare enough to skip": the gate holds a
  // one-per-task slot for up to 15 minutes, so without this a brain that
  // started a gate on a hung test suite can only wait it out — and the RPC was
  // already registered and already granted, which is a capability reachable by
  // nothing, the worst of both.
  'task_gate_cancel',
  'task_adopt',
  'task_close',
  'task_pr',
  'git_status',
  'git_log',
  'gh_pr_view',
];

/** Names in COMMANDER_ONLY_TOOLS that ALSO exist in full/core under a
 *  different (narrower) schema. The commander lane registers the brain
 *  variant after the manifest filter dropped the worker one, so the commander
 *  profile still lists each name exactly once. Everything else in
 *  COMMANDER_ONLY_TOOLS must be absent from full and core. */
export const COMMANDER_VARIANT_TOOLS: readonly string[] = ['ledger_update'];

/** Commander-only names RESERVED for a tool that does not exist yet. The list
 *  is the staging area COMMANDER_ONLY_TOOLS names arrive through: a test
 *  asserts every entry stays ABSENT from every profile and from every
 *  src/mcp registration until it is wired, at which point it moves into
 *  COMMANDER_ONLY_TOOLS in the same commit.
 *
 *  Empty since the lane-O2 task tools landed (task_gate_run, task_adopt,
 *  task_close, task_pr, git_status, git_log, gh_pr_view — now in
 *  COMMANDER_ONLY_TOOLS above). Kept rather than deleted: it is the mechanism,
 *  not the batch. */
export const COMMANDER_ONLY_RESERVED_TOOLS: readonly string[] = [];

/** Pipe RPC methods the commander tool surface actually invokes — the
 *  PermissionEnforcer allow lane for a VALIDATED commander token. Least
 *  privilege: derived from what the tools above call (see the invariant test
 *  commanderSurface.test.ts, which parses src/mcp/ the same way
 *  firstParty.test.ts does), never a blanket grant. Notably ABSENT:
 *  pane.close, surface.close, workspace.close, browser.*, company.*,
 *  daemon.*. */
export const COMMANDER_RPC_METHODS: ReadonlySet<string> = new Set<string>([
  // identity / workspace bootstrap
  'mcp.identify',
  'mcp.claimWorkspace',
  'workspace.list',
  'surface.list',
  'surface.new',
  // panes + metadata (no close)
  'pane.list',
  'pane.search',
  'pane.getMetadata',
  'pane.setMetadata',
  'meta.setSkills',
  'pane.split',
  'pane.focus',
  'pane.stash',
  'pane.unstash',
  // terminal IO
  'input.send',
  'input.sendKey',
  'input.readScreen',
  'terminal.readEvents',
  // command deck routing / identity / decision gate
  'deck.resolvePaneRoute',
  'deck.resolveCommanderWorkspace',
  'deck.completeWork',
  'deck.requestDecision',
  'deck.resolveDecision',
  // events
  'events.poll',
  // agent-to-agent + channels + missions
  'a2a.resolve.identity',
  'a2a.whoami',
  'a2a.discover',
  'a2a.task.send',
  'a2a.task.query',
  'a2a.task.update',
  'a2a.task.cancel',
  'a2a.broadcast',
  'a2a.channel.list',
  'a2a.channel.get',
  'a2a.channel.getMessages',
  'a2a.channel.getMembers',
  'a2a.channel.create',
  'a2a.channel.join',
  'a2a.channel.leave',
  'a2a.channel.post',
  'a2a.channel.invite',
  'a2a.channel.ack',
  'a2a.channel.unread',
  'task.mission.start',
  'task.mission.close',
  // fan-out (create-only; the handler resolves the repository and the owning
  // workspace from the validated commander binding, and every spawn still
  // passes the approval prompt).
  'task.fanout.start',
  // task ledger (commander-only ledger_list / brain-scoped ledger_update;
  // the brain's own rows — authz is the ledger's canActorSet)
  'ledger.list',
  'ledger.update',
  // Task lifecycle (the commander-only task_* / git_* / gh_pr_view tools).
  // Create-and-finish, not teardown-of-human-state: what these remove is a
  // worktree the orchestrator itself asked for, which is the same class as
  // channel_mission_close. `task.close` and `task.pr` are additionally
  // approval-gated — see COMMANDER_TEARDOWN_DENY below for why they are
  // prompted rather than denied.
  'task.gate.run',
  'task.gate.cancel',
  'task.adopt',
  'task.close',
  'task.pr',
  'task.git.status',
  'task.git.log',
  'task.gh.prView',
]);

/** Teardown-EFFECT methods a validated commander is refused server-side
 *  (Layer 2 backstop — none are reachable from the registered tool surface,
 *  this guards a future Layer-1 regression). Inventory is by effect, not
 *  name: browser.close cascades into closePane when it closes a pane's last
 *  surface (useRpcBridge), so it belongs here even though browser_* tools
 *  are outside the surface entirely.
 *
 *  `task.close` is deliberately ABSENT, and the omission is the policy call
 *  lane O2 flagged rather than an oversight. This set is an UNCONDITIONAL
 *  refusal in RpcRouter, evaluated before any handler runs — so listing
 *  task.close would mean a brain can open N tasks and close none of them,
 *  which is the half-loop the task tools exist to finish. What it removes is
 *  also a worktree the orchestrator itself asked for, not human terminal
 *  state, which is why it is not the same class as pane.close. The control is
 *  a human approval prompt raised inside the handler instead (with task.pr,
 *  the other irreversible one) — see pipe/handlers/worktask.rpc.ts. */
export const COMMANDER_TEARDOWN_DENY: ReadonlySet<string> = new Set<string>([
  'pane.close',
  'surface.close',
  'workspace.close',
  'browser.tabs',
  'browser.close',
  'daemon.destroySession',
]);

/** The CLI argument that switches the bundled MCP server into commander mode
 *  (Layer 1). An ARG, not an env var, deliberately: the adapter declares it in
 *  the MCP server config's command line, so a brain product that strips env
 *  cannot silently widen the tool surface — arg and token fail independently
 *  (eng review P0-2). */
export const COMMANDER_MODE_ARG = '--commander';
