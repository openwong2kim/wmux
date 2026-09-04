// ─── C-5: one pane, one name, everywhere in the channel UI ───────────────────
//
// A channel member row and a transcript author line both stand for a PANE, but
// they identified it by its stored `memberId`. That id is the pane auto name
// only when the pane joined through the GUI; a pane that joined over MCP/CLI
// carries an opaque spawn-stamped id, so the roster and the transcript showed
// `pty-9f31c2…` where the composer's @-picker and the pane title bar showed
// `w26-1(claude)`. Same pane, three different names.
//
// These pure helpers resolve the pane's OWN display name (user rename ?? auto
// name) from the principal coordinate the member row already records, using the
// exact representative-surface rule `buildMentionCandidates` uses — the roster,
// the mention tokens and the pane title cannot drift apart because they now
// compute the name the same way.
//
// Store-free and side-effect-free so they are unit-testable and safe to call
// from a selector.

import type { Workspace } from '../../shared/types';
import type { AgentSlug } from '../../shared/events';
import type { ChannelMember } from '../../shared/channels';
import { panePrincipalId } from '../../shared/principals';
import { findLeafPanes } from '../hooks/a2aAddressing';
import { computePaneAutoName, paneDisplayName } from '../utils/paneNaming';

/** The renderer's ptyId → detected-agent mirror (`store.surfaceAgent`). */
export type SurfaceAgentMirror = Record<string, { name: string; slug?: AgentSlug } | undefined>;

export interface PaneNameSources {
  workspaces: readonly Workspace[];
  surfaceAgent: SurfaceAgentMirror;
  /** paneId → user rename (`store.paneLabel`). */
  paneLabel: Record<string, string>;
}

/**
 * Every live pane's display name, keyed by its principal coordinate
 * (`panePrincipalId(workspaceId, paneId)`) — the same key a channel member row
 * stores in `principalId`.
 *
 * Panes with no live agent are included: a member whose agent has exited still
 * has a pane, and `w26-1` is a truer answer than an opaque member id. The agent
 * suffix comes from the pane's representative agent surface (the active one
 * when it runs an agent, else the first that does), so a multi-tab pane yields
 * one name instead of one per tab.
 */
export function buildPaneNamesByPrincipal({
  workspaces,
  surfaceAgent,
  paneLabel,
}: PaneNameSources): Map<string, string> {
  const names = new Map<string, string>();
  for (const w of workspaces) {
    const wsOrdinal = w.wsOrdinal ?? 0;
    for (const leaf of findLeafPanes(w.rootPane)) {
      const agentSurfaces = leaf.surfaces.filter(
        (s) => s.surfaceType !== 'browser' && !!s.ptyId && !!surfaceAgent[s.ptyId]?.name,
      );
      const repr = agentSurfaces.find((s) => s.id === leaf.activeSurfaceId) ?? agentSurfaces[0];
      const autoName = computePaneAutoName(
        wsOrdinal,
        leaf.ordinal ?? 0,
        repr ? surfaceAgent[repr.ptyId]?.slug : undefined,
      );
      names.set(panePrincipalId(w.id, leaf.id), paneDisplayName(paneLabel[leaf.id], autoName));
    }
  }
  return names;
}

/**
 * The pane display name behind one roster member, or `undefined` when the row
 * has no principal (legacy/external MCP member) or its pane is gone. Callers
 * fall back to the stored member label rather than inventing a name.
 */
export function paneNameForMember(
  member: Pick<ChannelMember, 'principalId'>,
  names: ReadonlyMap<string, string>,
): string | undefined {
  return member.principalId ? names.get(member.principalId) : undefined;
}

/**
 * The pane display name behind a transcript author, resolved through the
 * channel roster: a message carries (workspaceId, memberId), the roster row for
 * that pair carries the principal, and the principal names the pane.
 */
export function paneNameForAuthor(args: {
  members: readonly ChannelMember[];
  names: ReadonlyMap<string, string>;
  workspaceId: string;
  memberId: string;
}): string | undefined {
  const row = args.members.find(
    (m) => m.workspaceId === args.workspaceId && m.memberId === args.memberId,
  );
  return row ? paneNameForMember(row, args.names) : undefined;
}

// Control characters, so a pane rename containing any printable separator
// cannot forge a pair boundary. Same scheme as ChannelView's workspace-name key.
const FIELD_SEP = '\u0000';
const PAIR_SEP = '\u0001';

/**
 * A stable STRING projection of the pane-name map, for components that must
 * subscribe from a store selector. `ChannelView` cannot depend on the workspace
 * array itself — its reference churns on every pane-tree mutation (titles, cwd,
 * layout) and would repaint the whole transcript while agents are active. The
 * joined key only changes when a pane's NAME changes, so `parsePaneNamesKey`
 * behind a `useMemo` gives a reference-stable map.
 */
export function paneNamesKey(sources: PaneNameSources): string {
  const parts: string[] = [];
  for (const [principalId, name] of buildPaneNamesByPrincipal(sources)) {
    parts.push(`${principalId}${FIELD_SEP}${name}`);
  }
  return parts.join(PAIR_SEP);
}

/** Inverse of {@link paneNamesKey}. */
export function parsePaneNamesKey(key: string): Map<string, string> {
  const names = new Map<string, string>();
  if (!key) return names;
  for (const pair of key.split(PAIR_SEP)) {
    const sep = pair.indexOf(FIELD_SEP);
    if (sep > 0) names.set(pair.slice(0, sep), pair.slice(sep + 1));
  }
  return names;
}
