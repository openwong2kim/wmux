/**
 * Workspace-identity helpers for the MCP server. Kept in their own module so
 * the classification has exactly one implementation rather than drifting
 * between hand-copied copies at each call site.
 */

export type WorkspaceLiveness = 'live' | 'absent' | 'unknown';

/**
 * Classify a `workspace.list` RPC result for the purpose of gating the
 * (frozen, possibly stale) WMUX_WORKSPACE_ID env hint.
 *
 *   - 'live'    : the result is an array of workspaces and one has id === wsId.
 *   - 'absent'  : the result is an array that does NOT contain wsId → a
 *                 confirmed ghost (re-minted / closed). Callers drop the hint.
 *   - 'unknown' : the result is not a workspace array — e.g. the renderer's
 *                 retryable "still starting" envelope during boot reconcile, or
 *                 any other unexpected shape. The hint may be perfectly valid;
 *                 callers must NOT treat this as a confirmed death (mirrors the
 *                 daemon-side prune's "require positive proof" discipline).
 *
 * Accepts either a bare array or a `{ workspaces: [...] }` wrapper so it is
 * robust to either RPC envelope shape.
 */
export function classifyWorkspaceListResult(
  result: unknown,
  wsId: string,
): WorkspaceLiveness {
  const list = Array.isArray(result)
    ? result
    : (result as { workspaces?: unknown[] } | null)?.workspaces;
  if (!Array.isArray(list)) return 'unknown';
  return list.some(
    (w) => w && typeof w === 'object' && (w as Record<string, unknown>)['id'] === wsId,
  )
    ? 'live'
    : 'absent';
}
