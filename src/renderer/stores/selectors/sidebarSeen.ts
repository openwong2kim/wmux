// ─── Sidebar "changed since you last looked" (glance board, 2026-09-25) ──────
//
// Same comparison Fleet uses for its changed dot (fleetChangedSinceSeen: a
// different status, or a different pending question), but the snapshot is
// per pane and taken continuously while the pane's workspace is on screen —
// the sidebar is always open, so "last looked" means "last had it in view".
// A pane is seeded the first time it is seen anywhere, so a new pane does not
// open with a dot; its first real change gives it one.

import type { FleetSeenEntry, FleetSeenSnapshot } from '../slices/uiSlice';
import { fleetChangedSinceSeen } from '../slices/uiSlice';
import {
  fleetAttentionClass,
  fleetTargetPtyId,
  isFleetAgentPane,
  selectFleetPanes,
  type FleetPane,
  type FleetSelectorState,
} from './fleet';

export interface SeenPane {
  ptyId: string;
  workspaceId: string;
  stashed: boolean;
  entry: FleetSeenEntry;
  pane: FleetPane;
}

type SeenState = FleetSelectorState & {
  activeWorkspaceId?: string | null;
  multiviewIds?: readonly string[];
  sidebarSeen?: Record<string, FleetSeenEntry>;
};

export function seenPanes(state: SeenState): SeenPane[] {
  const out: SeenPane[] = [];
  for (const pane of selectFleetPanes(state)) {
    if (!isFleetAgentPane(pane) || pane.remote) continue;
    const ptyId = fleetTargetPtyId(pane);
    if (!ptyId) continue;
    const question = state.surfacePendingQuestion?.[ptyId]?.trim() || undefined;
    out.push({
      ptyId,
      workspaceId: pane.workspaceId,
      stashed: !!pane.stashed,
      entry: question ? { status: pane.agentStatus, question } : { status: pane.agentStatus },
      pane,
    });
  }
  return out;
}

/** Workspaces the user has in view: the active one and any in multiview. */
export function visibleWorkspaceIds(state: Pick<SeenState, 'activeWorkspaceId' | 'multiviewIds'>): Set<string> {
  const ids = new Set<string>(state.multiviewIds ?? []);
  if (state.activeWorkspaceId) ids.add(state.activeWorkspaceId);
  return ids;
}

/**
 * The seen-map writes due now: seed panes never seen; refresh panes that are
 * in view (visible workspace, not stashed). Pure.
 */
export function seenUpdates(
  panes: readonly SeenPane[],
  visible: ReadonlySet<string>,
  seen: Readonly<Record<string, FleetSeenEntry>>,
): Record<string, FleetSeenEntry> {
  const snapshot: FleetSeenSnapshot = { statuses: seen as Record<string, FleetSeenEntry>, at: 0 };
  const out: Record<string, FleetSeenEntry> = {};
  for (const p of panes) {
    if (!seen[p.ptyId]) { out[p.ptyId] = p.entry; continue; }
    if (visible.has(p.workspaceId) && !p.stashed
      && fleetChangedSinceSeen(snapshot, p.ptyId, p.entry.status, p.entry.question)) out[p.ptyId] = p.entry;
  }
  return out;
}

/**
 * ptyId → true for panes whose state changed since they were last in view AND
 * now wants a look (needs you or finished). Out-of-view panes only; a pane
 * with no seen entry yet is not "changed".
 */
const unseenCache = new WeakMap<object, Record<string, true>>();
const unseenWsCache = new WeakMap<object, Record<string, true>>();

export function selectSidebarUnseen(state: SeenState): Record<string, true> {
  const cached = unseenCache.get(state);
  if (cached) return cached;
  const seen = state.sidebarSeen ?? {};
  const snapshot: FleetSeenSnapshot = { statuses: seen, at: 0 };
  const visible = visibleWorkspaceIds(state);
  const out: Record<string, true> = {};
  for (const p of seenPanes(state)) {
    if (!seen[p.ptyId]) continue;
    if (visible.has(p.workspaceId) && !p.stashed) continue;
    const cls = fleetAttentionClass(p.pane, p.entry.question);
    if (cls !== 'needsYou' && cls !== 'finished') continue;
    if (fleetChangedSinceSeen(snapshot, p.ptyId, p.entry.status, p.entry.question)) out[p.ptyId] = true;
  }
  unseenCache.set(state, out);
  return out;
}

/** workspaceId → true when any of its panes is unseen (see selectSidebarUnseen). */
export function selectSidebarUnseenWorkspaces(state: SeenState): Record<string, true> {
  const cached = unseenWsCache.get(state);
  if (cached) return cached;
  const unseen = selectSidebarUnseen(state);
  const out: Record<string, true> = {};
  for (const p of seenPanes(state)) if (unseen[p.ptyId]) out[p.workspaceId] = true;
  unseenWsCache.set(state, out);
  return out;
}
