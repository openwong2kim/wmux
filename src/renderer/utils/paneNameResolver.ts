// Pane name → pane address, for `pane.resolveName` (the `#w1-2` / `#backend`
// tags an agent is handed instead of opaque ids). Pure + store-free: the caller
// passes the workspaces and the two volatile mirrors (paneLabel, surfaceAgent).
//
// Resolution only turns a name into ids. It confers no reach: every tool that
// accepts a name resolves it first and then runs its ordinary id-based routing
// and authorization, so a name can address exactly what its ids could.

import type { AgentSlug } from '../../shared/events';
import type { Pane, PaneLeaf, Surface } from '../../shared/types';
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

/** `w1-2`, with the optional terminal-tab number (`.2`, as an A2A name carries
 *  it) and the header's `(agent)` suffix, both of which are ignored. */
const AUTO_NAME_RE = /^w(\d+)-(\d+)(?:\.(\d+))?(?:\([^()]*\))?$/i;

/** A terminal surface (has a pty, is not a browser/editor tab). */
function isTerm(s: Surface): boolean {
  return s.surfaceType !== 'browser' && !!s.ptyId;
}

/** The pane's target surface: its active surface when that is a terminal with
 *  a pty, else its first such terminal (same rule as resolvePaneAddress), else
 *  the active surface itself with no pty. */
function targetSurface(leaf: PaneLeaf): { surfaceId: string; ptyId: string } {
  const active = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  const term = (active && isTerm(active) ? active : undefined) ?? leaf.surfaces.find(isTerm);
  const surface = term ?? active ?? leaf.surfaces[0];
  return { surfaceId: surface?.id ?? '', ptyId: term?.ptyId ?? '' };
}

/** The `tab`-th terminal of a leaf (1-indexed, like the `.N` a party name carries). */
function terminalAt(leaf: PaneLeaf, tab: number): Surface | undefined {
  const terms = leaf.surfaces.filter(isTerm);
  return tab >= 1 && tab <= terms.length ? terms[tab - 1] : undefined;
}

/** `foo.2` → `{ base: 'foo', tab: 2 }`; a party ending in a plain number may be
 *  a label (or coordinate) plus a terminal-tab index. */
function tabSuffix(party: string): { base: string; tab: number } | undefined {
  const m = /^(.*)\.(\d+)$/.exec(party);
  return m ? { base: m[1], tab: Number(m[2]) } : undefined;
}

type Match = { ws: PaneNameWorkspace; leaf: PaneLeaf; surface?: Surface };

/**
 * Match a party name (with an optional workspace-name scope) against the live
 * panes. Returns the three match kinds separately so a coordinate match can
 * still win outright. A `surface` is pinned only for matches that name one
 * specific terminal — a `userName` or a `.N` tab suffix.
 */
function collectMatches(
  workspaces: ReadonlyArray<PaneNameWorkspace>,
  paneLabel: Record<string, string> | undefined,
  wsFilter: string | undefined,
  party: string,
): { coord: Match[]; label: Match[]; name: Match[] } {
  const coord = AUTO_NAME_RE.exec(party);
  const wsOrdinal = coord ? Number(coord[1]) : NaN;
  const paneOrdinal = coord ? Number(coord[2]) : NaN;
  const tab = coord?.[3] !== undefined ? Number(coord[3]) : undefined;
  const wantedLabel = normalizePaneLabel(party);
  const split = tabSuffix(party);

  const coordMatches: Match[] = [];
  const labelMatches: Match[] = [];
  const nameMatches: Match[] = [];

  for (const ws of workspaces) {
    if (wsFilter && ws.name.trim().toLowerCase() !== wsFilter.toLowerCase()) continue;
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      if (coord && ws.wsOrdinal === wsOrdinal && leaf.ordinal === paneOrdinal) {
        const surface = tab !== undefined ? terminalAt(leaf, tab) : undefined;
        // A tab beyond the pane's terminals names nothing.
        if (tab === undefined || surface) coordMatches.push({ ws, leaf, ...(surface ? { surface } : {}) });
      }
      const label = (paneLabel?.[leaf.id] ?? leaf.metadata?.label)?.trim();
      if (label) {
        if (normalizePaneLabel(label) === wantedLabel) labelMatches.push({ ws, leaf });
        if (split && normalizePaneLabel(label) === normalizePaneLabel(split.base)) {
          const surface = terminalAt(leaf, split.tab);
          if (surface) labelMatches.push({ ws, leaf, surface });
        }
      }
      for (const surface of leaf.surfaces) {
        if (!isTerm(surface)) continue;
        const userName = surface.userName?.trim();
        if (userName && userName.toLowerCase() === party.toLowerCase()) {
          nameMatches.push({ ws, leaf, surface });
        }
      }
    }
  }
  return { coord: coordMatches, label: labelMatches, name: nameMatches };
}

/** One match's always-unique tag: the coordinate, plus the tab number when the
 *  match pins a specific terminal, so two terminals of one pane read apart. */
function matchTag(
  ws: PaneNameWorkspace,
  leaf: PaneLeaf,
  surface: Surface | undefined,
  surfaceAgent: Record<string, { slug?: AgentSlug }> | undefined,
): string {
  const slug = activeAgentSlug(surfaceAgent, leaf);
  const base = computePaneAutoName(ws.wsOrdinal ?? 0, leaf.ordinal ?? 0, slug);
  if (surface?.ptyId) {
    const terms = leaf.surfaces.filter(isTerm);
    const idx = terms.findIndex((t) => t.ptyId === surface.ptyId);
    if (idx >= 0 && terms.length > 1) {
      return `#${sanitizePaneTitle(`${computePaneAutoName(ws.wsOrdinal ?? 0, leaf.ordinal ?? 0)}.${idx + 1}${slug ? `(${slug})` : ''}`)}`;
    }
  }
  return `#${sanitizePaneTitle(base)}`;
}

function dedup(matches: Match[]): Match[] {
  const seen = new Set<string>();
  const out: Match[] = [];
  for (const m of matches) {
    const key = `${m.ws.id}\u0000${m.leaf.id}\u0000${m.surface?.id ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/**
 * Resolve a pane name. Accepts an optional leading `#`, an auto name (`w1-2`,
 * with or without the `(agent)` and terminal-tab `.N` suffixes), a user label,
 * or a terminal's `userName` (trimmed, case-insensitive). The whole token is
 * matched first — labels and `userName`s may themselves contain a dot
 * (`api.v2`), so a `Workspace.name` form is tried only as a second
 * interpretation. When both interpretations hit different targets the result
 * is ambiguous. A coordinate match beats any label or `userName`. Zero matches
 * → not_found; more than one → ambiguous, listing the candidates by their
 * always-unique tags; it never picks one.
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

  // Interpretation 1: the whole token is the party name (no workspace prefix).
  const full = collectMatches(workspaces, paneLabel, undefined, token);

  // Interpretation 2: `Workspace.name` — split on the FIRST dot.
  let prefixed: { coord: Match[]; label: Match[]; name: Match[] } = { coord: [], label: [], name: [] };
  const dot = token.indexOf('.');
  if (dot > 0) {
    const wsToken = token.slice(0, dot).trim();
    const partyToken = token.slice(dot + 1).trim();
    if (wsToken && partyToken) prefixed = collectMatches(workspaces, paneLabel, wsToken, partyToken);
  }

  // Within ONE interpretation a coordinate match wins outright (it is globally
  // unique); ACROSS interpretations a hit in both is ambiguous — the resolver
  // must never silently choose one target over the other.
  const winnersOf = (r: { coord: Match[]; label: Match[]; name: Match[] }): Match[] =>
    r.coord.length > 0 ? r.coord : [...r.label, ...r.name];
  const matches = dedup([...winnersOf(full), ...winnersOf(prefixed)]);

  if (matches.length === 0) {
    return {
      ok: false,
      reason: 'not_found',
      error: `no pane named "${shown}" (pane_list and a2a_discover list each pane's paneTag and paneName)`,
    };
  }
  if (matches.length > 1) return ambiguous(matches, shown, surfaceAgent);
  return ok(matches[0], paneLabel, surfaceAgent);
}

function ok(
  m: Match,
  paneLabel: Record<string, string> | undefined,
  surfaceAgent: Record<string, { slug?: AgentSlug }> | undefined,
): PaneNameResolution {
  const { ws, leaf, surface } = m;
  // A `userName` / tab-suffixed match pins the exact terminal that was named;
  // a label or coordinate match resolves to the leaf's target terminal as before.
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

function ambiguous(
  matches: Match[],
  shown: string,
  surfaceAgent: Record<string, { slug?: AgentSlug }> | undefined,
): PaneNameResolution {
  const listed = matches.slice(0, AMBIGUOUS_NAME_CAP).map(({ ws, leaf, surface }) =>
    matchTag(ws, leaf, surface, surfaceAgent));
  const more = matches.length > listed.length ? ` (+${matches.length - listed.length} more)` : '';
  return {
    ok: false,
    reason: 'ambiguous',
    error: `pane name "${shown}" matches ${matches.length} panes: ${listed.join(', ')}${more}. Address one by its tag.`,
  };
}
