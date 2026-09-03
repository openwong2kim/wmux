// ─── Core profile manifest (launch-time optimization surface) ────────────────
//
// `core` is the third launch-time MCP profile alongside `full` (the
// compatibility default) and `commander` (a security role). It exists for
// terminal / pane / workspace / channel / delegation work that never touches
// a browser or the cross-company A2A bus, and it is reserved by the vNext
// design note: docs/design/mcp-vnext-2026-07-28.md ("One server key, static
// profiles").
//
// IMPORTANT — core is an OPTIMIZATION profile, NOT a security boundary.
// Unlike `commander` it grants no role, mints no token, and narrows no RPC
// allow lane: a core-mode child is an ordinary pane agent whose tools/list is
// simply shorter. Everything the process may reach through the pipe is
// unchanged from `full`. Do not add role plumbing (setCommanderRole,
// PermissionEnforcer lanes, TEARDOWN_DENY_METHODS) behind this flag — a
// caller who wanted the wider surface can just launch without the flag, so a
// gate here would protect nothing while implying protection that is not there.
//
// Derivation rule (enforced by src/shared/__tests__/coreSurface.test.ts):
//
//     CORE_TOOL_SURFACE === full surface − browser_* − company_*
//
// in the canonical full registration order. The test derives the expectation
// from scripts/mcp-protocol-baseline.json's `full.toolNames`, so a NEW tool
// added to the full surface fails the build until someone decides, explicitly,
// whether it belongs in core. That drift gate is the point of the list being
// spelled out here rather than computed at runtime, and a second assertion
// pins this list to the baseline's own core.toolNames so regenerating the
// baseline cannot quietly bless a tool that fell out of the surface.
//
// COMMANDER_TOOL_SURFACE ⊆ CORE_TOOL_SURFACE is likewise an asserted
// invariant: commander deliberately omits browser_* and company_* too, so the
// narrower security role can never name a tool the optimization profile drops.

/** Tool names (no `mcp__wmux__` prefix) registered under `--core`, in the
 *  canonical full-profile registration order. */
export const CORE_TOOL_SURFACE: readonly string[] = [
  'terminal_read',
  'terminal_read_events',
  'terminal_send',
  'terminal_send_key',
  'deck_complete_work',
  'deck_ask_decision',
  'deck_resolve_decision',
  'workspace_list',
  'surface_list',
  'pane_list',
  'pane_set_metadata',
  'pane_get_metadata',
  'wmux_search_panes',
  'wmux_events_poll',
  'a2a_whoami',
  'a2a_discover',
  'send_message',
  'a2a_task_send',
  'a2a_task_query',
  'a2a_task_update',
  'a2a_task_cancel',
  'a2a_broadcast',
  'a2a_set_skills',
  'channel_list',
  'channel_create',
  'channel_post',
  'channel_join',
  'channel_leave',
  'channel_read',
  'channel_invite',
  'channel_get_members',
  'channel_ack',
  'channel_unread',
  'channel_mission_start',
  'channel_mission_close',
  'channel_mission_list',
  'fanout_start',
  'ledger_update',
  'pane_split',
  'pane_close',
  'pane_focus',
  'surface_new',
  'surface_close',
  'pane_stash',
  'pane_unstash',
  'repl_run',
  'repl_reset',
  'repl_sessions',
];

/** Launch argument that selects the core profile. An argv flag, never an env
 *  var: the client config declares it in the MCP server `args`, so an
 *  env-stripping host cannot silently change the surface (same rule as
 *  COMMANDER_MODE_ARG — see src/mcp/index.ts). */
export const CORE_MODE_ARG = '--core';
