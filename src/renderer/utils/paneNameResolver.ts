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
 * with or without the `(agent)` suffix) or a user label (trimmed,
 * case-insensitive). A coordinate match beats any label. Zero matches →
 * not_found; more than one (legacy duplicate labels, or anything defensive) →
 * ambiguous, listing the candidates by their always-unique tags.
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

  const coord = AUTO_NAME_RE.exec(token);
  const wsOrdinal = coord ? Number(coord[1]) : NaN;
  const paneOrdinal = coord ? Number(coord[2]) : NaN;
  const wantedLabel = normalizePaneLabel(token);

  // The coordinate wins outright: it is the one name guaranteed unique, so a
  // legacy label spelled `w1-2` (refused for new labels) must never make the
  // real `#w1-2` ambiguous.
  const coordMatches: Array<{ ws: PaneNameWorkspace; leaf: PaneLeaf }> = [];
  const labelMatches: Array<{ ws: PaneNameWorkspace; leaf: PaneLeaf }> = [];
  for (const ws of workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      if (coord && ws.wsOrdinal === wsOrdinal && leaf.ordinal === paneOrdinal) coordMatches.push({ ws, leaf });
      const label = paneLabel?.[leaf.id] ?? leaf.metadata?.label;
      if (typeof label === 'string' && label.trim() !== '' && normalizePaneLabel(label) === wantedLabel) {
        labelMatches.push({ ws, leaf });
      }
    }
  }
  const matches = coordMatches.length > 0 ? coordMatches : labelMatches;

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

  const { ws, leaf } = matches[0];
  return {
    ok: true,
    target: {
      workspaceId: ws.id,
      paneId: leaf.id,
      ...targetSurface(leaf),
      ...paneNameFields(paneLabel, surfaceAgent, ws, leaf),
    },
  };
}
