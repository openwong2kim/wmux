import { a2aEndpointAlias, type A2aExposedPane, type A2aLinkRecordV1 } from '../../../shared/a2aRemote';
import type { Workspace } from '../../../shared/types';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { activeAgentSlug, leafDisplayName } from '../../utils/paneNaming';
import type { AgentSlug } from '../../../shared/events';

// Pure helpers behind the cross-PC pane link UI (matching dialog, accept
// cards, link list, exposure checklist), kept store-free for tests.

/** One exposed pane in the matching dialog: `recommended` when it shares my pane's repo. */
export interface RankedPane {
  pane: A2aExposedPane;
  recommended: boolean;
}

/**
 * The other PC's panes, those on the same git remote as mine first (marked
 * recommended), then the rest; the server's order is kept within each group.
 */
export function rankExposedPanes(panes: A2aExposedPane[], myRemote: string | null): RankedPane[] {
  const ranked = panes.map((pane) => ({ pane, recommended: !!myRemote && pane.gitRemote === myRemote }));
  return [...ranked.filter((r) => r.recommended), ...ranked.filter((r) => !r.recommended)];
}

/** Both repos are known and differ. Unknown on either side is not a mismatch. */
export function repoMismatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a !== b;
}

/** Display words for a link state: pending / active / revoked / broken. */
export type LinkStateWord = 'pending' | 'active' | 'revoked' | 'broken';

export function linkStateWord(state: A2aLinkRecordV1['state']): LinkStateWord {
  if (state === 'proposed-in' || state === 'proposed-out') return 'pending';
  return state;
}

/** Which way messages may flow, from this PC's side. */
export function linkDirection(allow: A2aLinkRecordV1['allow']): 'both' | 'send' | 'receive' | 'none' {
  if (allow.outbound && allow.inbound) return 'both';
  if (allow.outbound) return 'send';
  if (allow.inbound) return 'receive';
  return 'none';
}

/** `<PC>/<workspace>/<pane>`, or `<PC>/Moa` for a Moa end — the remote end's alias. */
export function remoteAlias(pcName: string, remote: A2aLinkRecordV1['remote']): string {
  return a2aEndpointAlias(pcName, remote);
}

/**
 * This PC's end of a link, named from the live store BY THE IDS the link
 * stores — so a card shows exactly the pane an accept binds, never a name the
 * other PC reported. Falls back to the ids when the pane is gone.
 */
export function localPaneName(
  workspaces: Workspace[],
  local: A2aLinkRecordV1['local'],
  paneLabel?: Record<string, string>,
  surfaceAgent?: Record<string, { slug?: AgentSlug }>,
): { workspace: string; pane: string } {
  const ws = workspaces.find((w) => w.id === local.workspaceId);
  const leaf = ws ? getWorkspaceLeafPanes(ws).find((p) => p.id === local.paneId) : undefined;
  const pane = ws && leaf ? leafDisplayName(paneLabel, ws, leaf, activeAgentSlug(surfaceAgent, leaf)) : local.paneId ?? '';
  return { workspace: ws?.name ?? local.workspaceId, pane };
}

/** An exposure as the checklist edits it: always an explicit pane list per workspace. */
export interface ExposureLists {
  workspaceIds: string[];
  paneIds: Record<string, string[]>;
  /** This PC's Moa is shown. Absent = false. */
  brain?: boolean;
}

/** Toggle one pane in an exposure (explicit lists only). A workspace left with no pane is dropped. */
export function togglePaneExposure(
  current: ExposureLists,
  workspaceId: string,
  paneId: string,
  on: boolean,
): ExposureLists {
  const paneIds: Record<string, string[]> = {};
  for (const ws of current.workspaceIds) paneIds[ws] = [...(current.paneIds[ws] ?? [])];
  const list = new Set(paneIds[workspaceId] ?? []);
  if (on) list.add(paneId);
  else list.delete(paneId);
  if (list.size > 0) paneIds[workspaceId] = [...list];
  else delete paneIds[workspaceId];
  return { workspaceIds: Object.keys(paneIds), paneIds, ...(current.brain ? { brain: true } : {}) };
}

/** Toggle every pane of a workspace (the workspace row's checkbox). */
export function toggleWorkspaceExposure(
  current: ExposureLists,
  workspaceId: string,
  allPaneIds: string[],
  on: boolean,
): ExposureLists {
  const paneIds: Record<string, string[]> = {};
  for (const ws of current.workspaceIds) paneIds[ws] = [...(current.paneIds[ws] ?? [])];
  if (on && allPaneIds.length > 0) paneIds[workspaceId] = [...allPaneIds];
  else delete paneIds[workspaceId];
  return { workspaceIds: Object.keys(paneIds), paneIds, ...(current.brain ? { brain: true } : {}) };
}
