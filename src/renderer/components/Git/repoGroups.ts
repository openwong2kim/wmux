// All repos on the Git page: every open workspace resolved to its worktree,
// that worktree's checkout (main worktree) and the checkout's remote, then
// grouped by remote — two clones of one GitHub repo are one group with one
// PR list and each clone's worktrees labelled by checkout. A checkout with no
// remote is its own group.
//
// Resolution goes through the shared TTL caches (repoCache), so N workspaces
// on one repo cost one `worktree.list` and one remote read, and it reruns only
// when a workspace's cwd candidates change, not on every name or PR update:
// names and PR badges are joined from the live store at render.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';
import type { PrStatus } from '../../../shared/types';
import { normWorktreePath, type WorkspaceOnRepo } from './worktreeRows';
import { hostPlatform, pathLeaf, repoCwdCandidates } from './GitTab';
import { mainPathCached, repoKeyCached, resolveRepoCached } from './repoCache';

export interface ResolvedWorkspace {
  workspaceId: string;
  /** The workspace's worktree toplevel. */
  repoPath: string;
  /** That worktree's checkout (main worktree). */
  mainPath: string;
  /** The checkout's remote identity (host/owner/repo), null without one. */
  remoteKey: string | null;
}

export interface Checkout {
  mainPath: string;
  /** The checkout's folder, telling clones of one repo apart. */
  label: string;
  workspaces: WorkspaceOnRepo[];
  /** The active workspace's worktree when it sits in this checkout. */
  currentPath?: string;
}

export interface RepoGroup {
  key: string;
  name: string;
  checkouts: Checkout[];
  /** The active workspace sits in this repo. */
  active: boolean;
  /** Where the group's one PR list is read from (any checkout serves). */
  prPath: string;
  workspaceCount: number;
}

type Live = Record<string, { name: string; pr: PrStatus | null }>;

/** Group resolved workspaces by remote (else checkout); the active repo first, then by name. */
export function groupWorkspacesByRepo(
  list: readonly ResolvedWorkspace[],
  live: Live,
  activeWorkspaceId: string | null,
  platform?: string,
): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const w of list) {
    const info = live[w.workspaceId];
    if (!info) continue; // closed since it was resolved
    const key = w.remoteKey ?? `path:${normWorktreePath(w.mainPath, platform)}`;
    let g = groups.get(key);
    if (!g) {
      const name = w.remoteKey ? w.remoteKey.split('/').pop() ?? pathLeaf(w.mainPath) : pathLeaf(w.mainPath);
      g = { key, name, checkouts: [], active: false, prPath: w.mainPath, workspaceCount: 0 };
      groups.set(key, g);
    }
    const ck = normWorktreePath(w.mainPath, platform);
    let c = g.checkouts.find((x) => normWorktreePath(x.mainPath, platform) === ck);
    if (!c) {
      c = { mainPath: w.mainPath, label: pathLeaf(w.mainPath), workspaces: [] };
      g.checkouts.push(c);
    }
    c.workspaces.push({ workspaceId: w.workspaceId, name: info.name, pr: info.pr, repoPath: w.repoPath });
    g.workspaceCount++;
    if (w.workspaceId === activeWorkspaceId) {
      g.active = true;
      g.prPath = w.mainPath;
      c.currentPath = w.repoPath;
    }
  }
  return [...groups.values()].sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1));
}

type ResolveRepo = (cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }>;
type ListWorktrees = (repoPath: string) => Promise<{ ok: true; mainPath: string; worktrees: { path: string }[] } | { ok: false }>;
type RepoKey = (repoPath: string) => Promise<{ key: string | null }>;

/** Each workspace's id and cwd candidates — the only inputs to resolution. */
function selectResolutionKey(s: StoreState): string {
  return s.workspaces.map((w) => `${w.id}\u0001${repoCwdCandidates(w, s.startupDirectory || '', true).join('\u0002')}`).join('\n');
}

function selectLive(s: StoreState): string[] {
  return s.workspaces.map((w) => `${w.id}\u0001${w.name}\u0001${w.metadata?.pr ? JSON.stringify(w.metadata.pr) : ''}`);
}

/** Groups for All repos; null while the first resolution runs. */
export function useRepoGroups(refreshKey: number): RepoGroup[] | null {
  const resolutionKey = useStore(selectResolutionKey);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const liveRows = useStore(useShallow(selectLive));
  const [resolved, setResolved] = useState<ResolvedWorkspace[] | null>(null);
  // A hidden window reads nothing; showing it again resumes.
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  const seq = useRef(0);
  const lastRefresh = useRef(refreshKey);

  useEffect(() => {
    const mine = ++seq.current;
    if (hidden) return undefined;
    const force = lastRefresh.current !== refreshKey;
    lastRefresh.current = refreshKey;
    const api = (window as unknown as {
      electronAPI?: { diff?: { resolveRepo?: ResolveRepo }; worktree?: { list?: ListWorktrees }; github?: { repoKey?: RepoKey } };
    }).electronAPI;
    const resolveRepo = api?.diff?.resolveRepo;
    const list = api?.worktree?.list;
    if (!resolveRepo || !list) {
      setResolved([]);
      return undefined;
    }
    const live = () => seq.current === mine && !document.hidden;
    void (async () => {
      const state = useStore.getState();
      const plat = hostPlatform();
      const out: ResolvedWorkspace[] = [];
      for (const ws of state.workspaces) {
        let top: string | null = null;
        for (const cwd of repoCwdCandidates(ws, state.startupDirectory || '', true)) {
          top = await resolveRepoCached(resolveRepo, cwd, force);
          if (!live()) return;
          if (top !== null) break;
        }
        if (top === null) continue;
        const mainPath = await mainPathCached(list, top, plat, force);
        if (!live()) return;
        if (!mainPath) continue;
        const remoteKey = await repoKeyCached(api?.github?.repoKey, mainPath, plat, force);
        if (!live()) return;
        out.push({ workspaceId: ws.id, repoPath: top, mainPath, remoteKey });
      }
      if (live()) setResolved(out);
    })();
    return () => { seq.current++; };
  }, [resolutionKey, refreshKey, hidden]);

  const liveMap = useMemo(() => {
    const m: Live = {};
    for (const row of liveRows) {
      const [id, name, pr] = row.split('\u0001');
      m[id] = { name, pr: pr ? (JSON.parse(pr) as PrStatus) : null };
    }
    return m;
  }, [liveRows]);

  return useMemo(
    () => (resolved === null ? null : groupWorkspacesByRepo(resolved, liveMap, activeWorkspaceId, hostPlatform())),
    [resolved, liveMap, activeWorkspaceId],
  );
}
