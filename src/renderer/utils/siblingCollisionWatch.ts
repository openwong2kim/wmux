// Sibling worktree collision watch, renderer half: send main the folders of
// the live local terminal panes (and the Settings switch and interval), keep
// main's answer in the store, and ask for a check when an agent's turn ends.
// The marker itself is Pane/SiblingCollisionChip.tsx. Main does the git work
// (main/git/siblingCollision.ts).
import { useStore } from '../stores';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import type { PaneLeaf, Workspace } from '../../shared/types';
import type { SiblingCollisionSnapshot } from '../../shared/siblingCollision';
import { isTerminalSurfaceType } from '../components/Pane/surfaceKinds';
import { paneTag } from './paneNaming';

/**
 * The folder a pane works in, for the watch: its active local terminal's cwd,
 * else another local terminal's, else the workspace's reported cwd when the
 * pane has a local terminal at all. Browser-only and remote panes have none.
 */
export function paneWatchCwd(ws: Pick<Workspace, 'metadata'>, leaf: Pick<PaneLeaf, 'surfaces' | 'activeSurfaceId'>): string | null {
  const local = leaf.surfaces.filter((s) => isTerminalSurfaceType(s.surfaceType) && !!s.ptyId);
  if (local.length === 0) return null;
  const active = local.find((s) => s.id === leaf.activeSurfaceId);
  return active?.cwd || local.find((s) => !!s.cwd)?.cwd || ws.metadata?.cwd || null;
}

/** Every distinct pane folder across the workspaces, sorted. */
export function watchedCwds(workspaces: readonly Workspace[]): string[] {
  const out = new Set<string>();
  for (const ws of workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      const cwd = paneWatchCwd(ws, leaf);
      if (cwd) out.add(cwd);
    }
  }
  return [...out].sort();
}

export interface PaneCollisionPeer {
  /** The sibling's panes, as their tags (`#w1-2`). */
  tags: string[];
  /** The first of those panes (the marker's "Go to"). */
  workspaceId: string;
  paneId: string;
  worktreePath: string;
  conflicts: string[];
  overlaps: string[];
}

export interface PaneCollision {
  worktreePath: string;
  peers: PaneCollisionPeer[];
}

/** What the marker on `leaf` shows: its worktree's colliding siblings, mapped to their panes. */
export function paneCollision(
  snapshot: SiblingCollisionSnapshot,
  workspaces: readonly Workspace[],
  ws: Workspace,
  leaf: PaneLeaf,
): PaneCollision | null {
  const cwd = paneWatchCwd(ws, leaf);
  const entry = cwd ? snapshot.byCwd[cwd] : undefined;
  if (!entry) return null;
  const peers: PaneCollisionPeer[] = [];
  for (const peer of entry.peers) {
    const cwds = new Set(snapshot.cwdsByWorktree[peer.worktreePath] ?? []);
    const tags: string[] = [];
    let first: { workspaceId: string; paneId: string } | null = null;
    for (const w of workspaces) {
      for (const l of getWorkspaceLeafPanes(w)) {
        const c = paneWatchCwd(w, l);
        if (!c || !cwds.has(c)) continue;
        tags.push(paneTag(w, l));
        first ??= { workspaceId: w.id, paneId: l.id };
      }
    }
    // A sibling whose pane closed since main answered is not shown.
    if (!first) continue;
    peers.push({ tags, ...first, worktreePath: peer.worktreePath, conflicts: peer.conflicts, overlaps: peer.overlaps });
  }
  return peers.length ? { worktreePath: entry.worktreePath, peers } : null;
}

type WatchBridge = {
  watchSiblings?: (req: { enabled: boolean; intervalMs: number; cwds: string[] }) => void;
  pokeSiblings?: () => void;
  onSiblingCollisions?: (cb: (s: SiblingCollisionSnapshot) => void) => () => void;
};

// Statuses that end a turn: the pane "went idle", so its worktree may have changed.
const TURN_ENDED = new Set(['complete', 'waiting', 'awaiting_input', 'error', 'idle']);

/** Start the watch; returns its stop. Waits for the saved settings before sending anything. */
export function startSiblingCollisionWatch(): () => void {
  const bridge = (window as unknown as { electronAPI?: { worktree?: WatchBridge } }).electronAPI?.worktree;
  if (!bridge?.watchSiblings) return () => undefined;
  const offUpdate = bridge.onSiblingCollisions?.((snapshot) => useStore.getState().setSiblingCollisions(snapshot));
  let lastSent = '';
  const send = (): void => {
    const s = useStore.getState();
    if (!s.sessionSettingsLoaded) return;
    const req = {
      enabled: s.siblingCollisionWatch,
      intervalMs: s.siblingCollisionIntervalMin * 60_000,
      cwds: s.siblingCollisionWatch ? watchedCwds(s.workspaces) : [],
    };
    const key = JSON.stringify(req);
    if (key === lastSent) return;
    lastSent = key;
    bridge.watchSiblings?.(req);
  };
  send();
  let lastAgent = useStore.getState().surfaceAgent;
  const offStore = useStore.subscribe((s, prev) => {
    if (s.workspaces !== prev.workspaces || s.siblingCollisionWatch !== prev.siblingCollisionWatch
      || s.siblingCollisionIntervalMin !== prev.siblingCollisionIntervalMin || s.sessionSettingsLoaded !== prev.sessionSettingsLoaded) {
      send();
    }
    if (s.surfaceAgent !== lastAgent) {
      const before = lastAgent;
      lastAgent = s.surfaceAgent;
      if (!s.siblingCollisionWatch) return;
      for (const [ptyId, a] of Object.entries(s.surfaceAgent)) {
        if (before[ptyId]?.status === 'running' && TURN_ENDED.has(a.status)) {
          bridge.pokeSiblings?.();
          break;
        }
      }
    }
  });
  return () => {
    offStore();
    offUpdate?.();
  };
}
