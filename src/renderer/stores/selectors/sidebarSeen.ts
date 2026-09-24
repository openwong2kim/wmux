// ─── Sidebar "changed since you last looked" (glance board, 2026-09-25) ──────
//
// Per agent TAB (ptyId), not per pane: a background tab's agent can finish or
// ask while another tab is in front. Each tab keeps a small record:
//
//   entry   — the last observed status + pending question (Fleet's
//             FleetSeenEntry shape, compared with fleetChangedSinceSeen)
//   rev     — bumped on every observed change, so a round trip
//             (complete → running → complete) still counts as a change
//   seenRev — the rev the user last had in view
//
// "In view" = the tab's workspace is the one on screen: the active workspace,
// plus the rest of the multiview grid ONLY while the active workspace is part
// of it (the same check the viewport uses), and nothing local while a remote
// mirror is showing. A tab is seeded (seenRev = rev) the first time it is
// observed, so a new tab opens without a dot.

import type { FleetSeenEntry, FleetSeenSnapshot } from '../slices/uiSlice';
import { fleetChangedSinceSeen } from '../slices/uiSlice';
import { fleetAttentionClass, type FleetSelectorState } from './fleet';
import { selectWorkspaceAgentRoster } from './workspaceAgentRoster';
import { isRemoteMirrorVisible } from '../slices/remoteWorkspacesSlice';
import type { StoreState } from '../index';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';

export interface SeenRecord {
  entry: FleetSeenEntry;
  rev: number;
  seenRev: number;
}

export interface SeenTab {
  ptyId: string;
  workspaceId: string;
  stashed: boolean;
  entry: FleetSeenEntry;
}

type SeenState = FleetSelectorState & Pick<StoreState, 'activeWorkspaceId'> & {
  multiviewIds?: readonly string[];
  activeRemoteKey?: string | null;
  sidebarSeen?: Record<string, SeenRecord>;
};

const tabsCache = new WeakMap<object, SeenTab[]>();

/** Every local agent tab, with its sidebar status and pending question. Cached per state. */
export function seenTabs(state: SeenState): SeenTab[] {
  const cached = tabsCache.get(state);
  if (cached) return cached;
  const out: SeenTab[] = [];
  for (const ws of state.workspaces) {
    for (const row of selectWorkspaceAgentRoster(state as unknown as StoreState, ws.id).rows) {
      if (row.remote || !row.ptyId || !row.agentName) continue;
      const question = row.pendingQuestion?.trim() || undefined;
      out.push({
        ptyId: row.ptyId,
        workspaceId: ws.id,
        stashed: !!row.stashed,
        entry: question ? { status: row.status, question } : { status: row.status },
      });
    }
  }
  tabsCache.set(state, out);
  return out;
}

/** Every pty bound to a surface anywhere (stashed panes included). */
export function surfacePtyIds(state: Pick<StoreState, 'workspaces'>): Set<string> {
  const ids = new Set<string>();
  for (const ws of state.workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) for (const s of leaf.surfaces) if (s.ptyId) ids.add(s.ptyId);
  }
  return ids;
}

/** Workspaces the user has in view right now (see the file note). */
export function visibleWorkspaceIds(
  state: Pick<SeenState, 'activeWorkspaceId' | 'multiviewIds' | 'activeRemoteKey'> & { remoteWorkspaces?: StoreState['remoteWorkspaces'] },
): Set<string> {
  const ids = new Set<string>();
  if (state.activeRemoteKey && isRemoteMirrorVisible({
    remoteWorkspaces: state.remoteWorkspaces ?? [],
    activeRemoteKey: state.activeRemoteKey,
  })) return ids;
  const active = state.activeWorkspaceId;
  if (!active) return ids;
  ids.add(active);
  const grid = state.multiviewIds ?? [];
  if (grid.length >= 2 && grid.includes(active)) for (const id of grid) ids.add(id);
  return ids;
}

/**
 * The record writes due now, plus the ptyIds that no longer exist (to prune).
 * Pure: seed new tabs, bump rev on a change, mark in-view tabs seen.
 */
export function seenUpdates(
  tabs: readonly SeenTab[],
  visible: ReadonlySet<string>,
  seen: Readonly<Record<string, SeenRecord>>,
  /** Every pty still bound to a surface. A record is pruned only when its pty
   *  is gone — not when its agent is momentarily undetected (a restart), or
   *  the next status would be compared against a fresh seed and lost. */
  livePtyIds: ReadonlySet<string> = new Set(tabs.map((t) => t.ptyId)),
): { updates: Record<string, SeenRecord>; removed: string[] } {
  const updates: Record<string, SeenRecord> = {};
  for (const tab of tabs) {
    const prior = seen[tab.ptyId];
    const inView = visible.has(tab.workspaceId) && !tab.stashed;
    if (!prior) {
      updates[tab.ptyId] = { entry: tab.entry, rev: 0, seenRev: 0 };
      continue;
    }
    const snapshot: FleetSeenSnapshot = { statuses: { [tab.ptyId]: prior.entry }, at: 0 };
    const changed = fleetChangedSinceSeen(snapshot, tab.ptyId, tab.entry.status, tab.entry.question);
    const rev = changed ? prior.rev + 1 : prior.rev;
    const seenRev = inView ? rev : prior.seenRev;
    if (changed || seenRev !== prior.seenRev) updates[tab.ptyId] = { entry: tab.entry, rev, seenRev };
  }
  const removed = Object.keys(seen).filter((id) => !livePtyIds.has(id));
  return { updates, removed };
}

const unseenCache = new WeakMap<object, Record<string, true>>();
const unseenWsCache = new WeakMap<object, Record<string, true>>();

/** A tab that wants a look: it needs you or it finished. */
function wantsALook(entry: FleetSeenEntry): boolean {
  const cls = fleetAttentionClass({ agentStatus: entry.status, unverifiable: false }, entry.question);
  return cls === 'needsYou' || cls === 'finished';
}

/**
 * ptyId → true for out-of-view tabs that changed since they were last in view
 * (any number of changes, round trips included) and now want a look.
 */
export function selectSidebarUnseen(state: SeenState): Record<string, true> {
  const cached = unseenCache.get(state);
  if (cached) return cached;
  const seen = state.sidebarSeen ?? {};
  const visible = visibleWorkspaceIds(state);
  const out: Record<string, true> = {};
  for (const tab of seenTabs(state)) {
    const rec = seen[tab.ptyId];
    if (!rec) continue;
    if (visible.has(tab.workspaceId) && !tab.stashed) continue;
    if (rec.rev === rec.seenRev) continue;
    if (wantsALook(tab.entry)) out[tab.ptyId] = true;
  }
  unseenCache.set(state, out);
  return out;
}

/** workspaceId → true when any of its tabs is unseen (see selectSidebarUnseen). */
export function selectSidebarUnseenWorkspaces(state: SeenState): Record<string, true> {
  const cached = unseenWsCache.get(state);
  if (cached) return cached;
  const unseen = selectSidebarUnseen(state);
  const out: Record<string, true> = {};
  for (const tab of seenTabs(state)) if (unseen[tab.ptyId]) out[tab.workspaceId] = true;
  unseenWsCache.set(state, out);
  return out;
}
