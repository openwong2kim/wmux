// Agent markers: while several agents drive apps at once, each one's halo,
// name pill, pointer and caret on screen are drawn in its own colour, and the
// same colour marks its pane in wmux (DESIGN.md › Agent identity colours).
//
// Main assigns the colour per agent key (computer.rpc.ts callerAgent) the first
// time that agent sends input and keeps it until wmux quits: the first palette
// colour no agent active in the last 30 minutes holds. With all ten taken the
// next agent starts the palette over; its name pill still tells it apart.

/**
 * Fills drawn behind dark ink (#0B0C0E, ≥ 4.5:1 on each). Red is left out: it
 * is the error colour. Index 0 is the attention orange the single overlay used
 * before, so a lone agent looks as it did.
 */
export const AGENT_MARKER_COLORS = [
  '#FF8A3D', // orange
  '#5AA2FF', // blue
  '#A98BFF', // violet
  '#FF77B7', // pink
  '#2FD4C0', // teal
  '#F5C518', // yellow
  '#9BDB4D', // lime
  '#4FD1F5', // sky
  '#E879F9', // magenta
  '#D3D9E2', // silver
] as const;

/** The ink drawn on a marker fill (pill text, pointer outline). */
export const AGENT_MARKER_INK = '#0B0C0E';

/**
 * What main sends the helper with an input action so the overlay can draw
 * that agent's marker. `id` is stable per agent for the session and opaque to
 * the helper; `label` is the short pill text (the pane's #tag or workspace,
 * then the client, e.g. "#api-1 · Claude Code"); `color` is one of
 * AGENT_MARKER_COLORS.
 */
export interface AgentMarker {
  id: string;
  label: string;
  color: string;
}

/** The palette slot for the n-th agent (0-based) to get a marker. */
export function agentMarkerColor(order: number): string {
  const n = AGENT_MARKER_COLORS.length;
  return AGENT_MARKER_COLORS[((order % n) + n) % n];
}

/**
 * Params of the optional helper method `markerWait`: show `marker` as waiting
 * on the target window (dimmed halo, hollow dot, "waiting for <waitingFor>")
 * while its input waits for the foreground lease another agent holds. The
 * marker's next input action, or `markerClear`, replaces it.
 */
export interface AgentMarkerWaitParams {
  marker: AgentMarker;
  pid: number;
  windowId: string;
  /** The label of the agent holding real input, as its pill shows it. */
  waitingFor: string;
}

/** Params of the optional helper method `markerClear`: drop that agent's marker now. */
export interface AgentMarkerClearParams {
  id: string;
}

/**
 * One pane's marker colour, pushed to the renderer (IPC.COMPUTER_AGENT_MARKERS)
 * so the sidebar row and pane title can carry the same colour dot. Only agents
 * keyed on a pane (senderPtyId) have a `ptyId`; others are not listed.
 */
export interface AgentMarkerEntry {
  ptyId: string;
  color: string;
}
