// Hook kinds that report a pane's tool calls. A pane whose agent sends any of
// these has a hook-driven Fleet activity line, so the daemon's transcript
// watcher stands down for it and main drops transcript lines for it. One
// definition, read by both sides, so they can never disagree on who owns a
// pane's line.
export const HOOK_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  'agent.activity',
  'agent.tool_started',
  'agent.awaiting_permission',
]);
