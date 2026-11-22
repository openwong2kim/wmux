// ─── A person's pane in the worker fence: what main and the renderer share ──
//
// main/agents/paneFence.ts launches an opted-in pane's claude inside the
// worker fence; the renderer keeps the pane's switch and shows its state.

/** What pty:create and pty:write-launch report for a fenced pane: the
 *  switch is on, and whether an agent launch was fenced just now. */
export interface PaneFenceState {
  on: boolean;
  launched: boolean;
}

/** Every refusal of a fenced launch carries this, after the IPC prefix. */
export const PANE_FENCE_REFUSAL_MARK = 'worker fence: ';

/** The refusal's own sentence from an error message, or null when the error
 *  is not a fence refusal. Pure. */
export function paneFenceRefusalReason(message: string): string | null {
  const at = message.indexOf(PANE_FENCE_REFUSAL_MARK);
  return at < 0 ? null : message.slice(at + PANE_FENCE_REFUSAL_MARK.length).trim() || null;
}
