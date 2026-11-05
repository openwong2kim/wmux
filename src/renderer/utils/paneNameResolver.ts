// Pane name → pane address, for `pane.resolveName` (the `#w1-2` / `#backend`
// tags an agent is handed instead of opaque ids). Pure + store-free: the caller
// passes the workspaces and the two volatile mirrors (paneLabel, surfaceAgent).
//
// Resolution only turns a name into ids. It confers no reach: every tool that
// accepts a name resolves it first and then runs its ordinary id-based routing
// and authorization, so a name can address exactly what its ids could.

import type { AgentSlug } from '../../shared/events';
import type { Pane, PaneLeaf } from '../../shared/types';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { normalizePaneLabel } from '../../shared/paneLabelRules';
import { sanitizePaneTitle } from '../hooks/a2aAddressing';
import { activeAgentSlug, computePaneAutoName, paneNameFields } from './paneNaming';

export interface PaneNameWorkspace {
  id: string;
  name: string;
  wsOrdinal?: number;
  rootPane: Pane;
  stashedPanes?: ReadonlyArray<{ pane?: Pane } | null | undefined>;
}

export interface PaneNameTarget {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  /** '' when the pane has no local terminal (browser-only, remote). */
  ptyId: string;
  paneName: string;
  paneTag: string;
}

export type PaneNameResolution =
  | { ok: true; target: PaneNameTarget }
  | { ok: false; reason: 'invalid' | 'not_found' | 'ambiguous'; error: string };

/** Candidates listed in an ambiguity refusal; the rest are counted. */
const AMBIGUOUS_NAME_CAP = 8;

/** `w1-2`, optionally with the header's `(agent)` suffix, which is ignored. */
const AUTO_NAME_RE = /^w(\d+)-(\d+)(?:\([^()]*\))?$/i;

/** The pane's target surface: its active surface when that is a terminal with
 *  a pty, else its first such terminal (same rule as resolvePaneAddress), else
 *  the active surface itself with no pty. */
function targetSurface(leaf: PaneLeaf): { surfaceId: string; ptyId: string } {
  const isTerm = (s: PaneLeaf['surfaces'][number]): boolean => s.surfaceType !== 'browser' && !!s.ptyId;
  const active = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  const term = (active && isTerm(active) ? active : undefined) ?? leaf.surfaces.find(isTerm);
  const surface = term ?? active ?? leaf.surfaces[0];
  return { surfaceId: surface?.id ?? '', ptyId: term?.ptyId ?? '' };
}

/**
 * Resolve a pane name. Accepts an optional leading `#`, an auto name (`w1-2`,
 * with or without the `(agent)` suffix), a user label, or a terminal's
 * `userName` (trimmed, case-insensitive). A `Workspace.name` form — the same
 * name an A2A message shows — also resolves, scoping the match to one
 * workspace. A coordinate match beats any label or `userName`. Zero matches →
 * not_found; more than one (legacy duplicate labels, or anything defensive) →
 * ambiguous, listing the candidates by their always-unique tags; it never
 * picks one.
 */
export function resolvePaneName(
  workspaces: ReadonlyArray<PaneNameWorkspace>,
  paneLabel: Record<string, string> | undefined,
  surfaceAgent: Record<string, { slug?: AgentSlug }> | undefined,
  rawName: string,
): PaneNameResolution {
  const token = rawName.trim().replace(/^#/, '').trim();
  const shown = sanitizePaneTitle(rawName);
  if (!token) return { ok: false, reason: 'invalid', error: 'pane name is empty' };

  // `Workspace.name` — an optional workspace prefix, split on the first dot.
  // (A workspace name that itself contains a dot is the known unresolved
  // ambiguity of the `Workspace.<name>` form.)
  const dot = token.indexOf('.');
  const wsToken = dot >= 0 ? token.slice(0, dot).trim() : undefined;
  const partyToken = dot >= 0 ? token.slice(dot + 1).trim() : token;
  if (!partyToken) return { ok: false, reason: 'invalid', error: `pane name "${shown}" is empty` };

  const coord = AUTO_NAME_RE.exec(partyToken);
  const wsOrdinal = coord ? Number(coord[1]) : NaN;
  const paneOrdinal = coord ? Number(coord[2]) : NaN;
  const wantedLabel = normalizePaneLabel(partyToken);

  type Match = { ws: PaneNameWorkspace; leaf: PaneLeaf; surface?: PaneLeaf['surfaces'][number] };
  const coordMatches: Match[] = [];
  const labelMatches: Match[] = [];
  const nameMatches: Match[] = [];
  for (const ws of workspaces) {
    if (wsToken && ws.name.trim().toLowerCase() !== wsToken.toLowerCase()) continue;
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      // The coordinate wins outright: it is the one name guaranteed unique, so
      // a legacy label spelled `w1-2` (refused for new labels) must never make
      // the real `#w1-2` ambiguous.
      if (coord && ws.wsOrdinal === wsOrdinal && leaf.ordinal === paneOrdinal) coordMatches.push({ ws, leaf });
      const label = paneLabel?.[leaf.id] ?? leaf.metadata?.label;
      if (typeof label === 'string' && label.trim() !== '' && normalizePaneLabel(label) === wantedLabel) {
        labelMatches.push({ ws, leaf });
      }
      for (const surface of leaf.surfaces) {
        const userName = surface.userName?.trim();
        if (userName && userName.toLowerCase() === partyToken.toLowerCase()) {
          nameMatches.push({ ws, leaf, surface });
        }
      }
    }
  }
  const matches = coordMatches.length > 0 ? coordMatches : [...labelMatches, ...nameMatches];

  if (matches.length === 0) {
    return {
      ok: false,
      reason: 'not_found',
      error: `no pane named "${shown}" (pane_list and a2a_discover list each pane's paneTag and paneName)`,
    };
  }
  if (matches.length > 1) {
    const listed = matches.slice(0, AMBIGUOUS_NAME_CAP).map(({ ws, leaf }) => {
      const auto = computePaneAutoName(ws.wsOrdinal ?? 0, leaf.ordinal ?? 0, activeAgentSlug(surfaceAgent, leaf));
      return `#${sanitizePaneTitle(auto)}`;
    });
    const more = matches.length > listed.length ? ` (+${matches.length - listed.length} more)` : '';
    return {
      ok: false,
      reason: 'ambiguous',
      error: `pane name "${shown}" matches ${matches.length} panes: ${listed.join(', ')}${more}. Address one by its tag.`,
    };
  }

  const { ws, leaf, surface } = matches[0];
  // A `userName` match pins the exact terminal that was named; a label or
  // coordinate match resolves to the leaf's target terminal as before.
  const target = surface && surface.ptyId
    ? { surfaceId: surface.id, ptyId: surface.ptyId }
    : targetSurface(leaf);
  return {
    ok: true,
    target: {
      workspaceId: ws.id,
      paneId: leaf.id,
      ...target,
      ...paneNameFields(paneLabel, surfaceAgent, ws, leaf),
    },
  };
}
