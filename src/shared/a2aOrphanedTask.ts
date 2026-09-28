/**
 * Orphaned A2A tasks (#1598): a task pinned to a receiver pane (`to.paneId`)
 * whose pane no longer exists in the receiver workspace. The pane gate only
 * lets the addressed pane move a pinned task, so without this rule such a task
 * could never be closed by anyone and piled up in the workspace inbox.
 *
 * The rule is the same everywhere (daemon gate, renderer fallback writer,
 * a2a_task_query flag): the task counts as orphaned only when the live pane
 * list of its receiver workspace is KNOWN and lacks `to.paneId`. An unknown
 * list (pane tree unreadable) never makes a task orphaned.
 */

/** Upper bound on pane ids accepted from the wire (main → daemon/renderer). */
const MAX_LIVE_PANE_IDS = 2000;

/**
 * Whether `to` names a receiver pane in `workspaceId` that is not among
 * `livePaneIds` (that workspace's panes, stashed ones included).
 */
export function isReceiverPaneGone(
  to: { workspaceId?: unknown; paneId?: unknown } | undefined,
  workspaceId: string,
  livePaneIds: readonly string[] | undefined,
): boolean {
  if (!to || !livePaneIds) return false;
  if (to.workspaceId !== workspaceId) return false;
  if (typeof to.paneId !== 'string' || !to.paneId) return false;
  return !livePaneIds.includes(to.paneId);
}

/** Parse a wire `livePaneIds` value; anything malformed means "unknown". */
export function normalizeLivePaneIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_LIVE_PANE_IDS) return undefined;
  if (!raw.every((id) => typeof id === 'string' && id.length > 0)) return undefined;
  return raw as string[];
}
