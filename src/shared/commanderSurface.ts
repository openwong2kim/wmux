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
  'surface_new',
  'terminal_send',
  'terminal_send_key',
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
  // Decision gate — pause-and-ask, the opposite of destructive.
  'deck_ask_decision',
  // WP3 — self-resolve of the brain's OWN stale decision (server-gated:
  // auto mode + TTL elapsed + substance floor, enforced in deck.rpc.ts).
  'deck_resolve_decision',
];

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
  // terminal IO
  'input.send',
  'input.sendKey',
  'input.readScreen',
  'terminal.readEvents',
  // command deck routing / identity / decision gate
  'deck.resolvePaneRoute',
  'deck.resolveCommanderWorkspace',
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
]);

/** Teardown-EFFECT methods a validated commander is refused server-side
 *  (Layer 2 backstop — none are reachable from the registered tool surface,
 *  this guards a future Layer-1 regression). Inventory is by effect, not
 *  name: browser.close cascades into closePane when it closes a pane's last
 *  surface (useRpcBridge), so it belongs here even though browser_* tools
 *  are outside the surface entirely. */
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
