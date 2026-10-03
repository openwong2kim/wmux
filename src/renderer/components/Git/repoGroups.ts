// All repos on the Git page: every open workspace resolved once to its
// worktree and that worktree's repo (the main worktree), grouped by repo.
// The groups then hand their workspaces to GitTab, so no group resolves the
// whole workspace list again.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { PrStatus } from '../../../shared/types';
import { normWorktreePath, type WorkspaceOnRepo } from './worktreeRows';
import { hostPlatform, pathLeaf, repoCwdCandidates } from './GitTab';

export interface ResolvedWorkspace {
  workspaceId: string;
  name: string;
  pr: PrStatus | null;
  /** The workspace's worktree toplevel. */
  repoPath: string;
  /** That worktree's main worktree — the repo's identity. */
  mainPath: string;
}

export interface RepoGroup {
  key: string;
  mainPath: string;
  name: string;
  workspaces: WorkspaceOnRepo[];
  /** The active workspace sits in this repo. */
  active: boolean;
  /** The repo path a group's GitTab opens on: the active workspace's own
   *  worktree for the active repo (so its row gets the dot), else the main one. */
  cwd: string;
}

/** Group resolved workspaces by repo; the active workspace's repo first, then by name. */
export function groupWorkspacesByRepo(list: readonly ResolvedWorkspace[], activeWorkspaceId: string | null, platform?: string): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const w of list) {
    const key = normWorktreePath(w.mainPath, platform);
    let g = groups.get(key);
    if (!g) {
      g = { key, mainPath: w.mainPath, name: pathLeaf(w.mainPath), workspaces: [], active: false, cwd: w.mainPath };
      groups.set(key, g);
    }
    g.workspaces.push({ workspaceId: w.workspaceId, name: w.name, pr: w.pr, repoPath: w.repoPath });
    if (w.workspaceId === activeWorkspaceId) {
      g.active = true;
      g.cwd = w.repoPath;
    }
  }
  return [...groups.values()].sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1));
}

type ResolveRepo = (cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }>;
type ListWorktrees = (repoPath: string) => Promise<{ ok: true; mainPath: string } | { ok: false }>;

/** Resolves every open workspace's repo once per roster change or refresh. null while loading. */
export function useRepoGroups(refreshKey: number): RepoGroup[] | null {
  const workspaceIds = useStore((s) => s.workspaces.map((w) => w.id).join('\0'));
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const [resolved, setResolved] = useState<ResolvedWorkspace[] | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    const api = (window as unknown as { electronAPI?: { diff?: { resolveRepo?: ResolveRepo }; worktree?: { list?: ListWorktrees } } }).electronAPI;
    const resolveRepo = api?.diff?.resolveRepo;
    const list = api?.worktree?.list;
    if (!resolveRepo || !list) {
      setResolved([]);
      return undefined;
    }
    void (async () => {
      const state = useStore.getState();
      const plat = hostPlatform();
      const mainOf = new Map<string, string | null>();
      const out: ResolvedWorkspace[] = [];
      for (const ws of state.workspaces) {
        let top: string | null = null;
        for (const cwd of repoCwdCandidates(ws, state.startupDirectory || '', true)) {
          try {
            const r = await resolveRepo(cwd);
            if (r.ok) { top = r.repoPath; break; }
          } catch { /* next candidate */ }
        }
        if (seq.current !== mine) return;
        if (top === null) continue;
        const k = normWorktreePath(top, plat);
        if (!mainOf.has(k)) {
          try {
            const l = await list(top);
            mainOf.set(k, l.ok ? (l.mainPath || top) : null);
          } catch {
            mainOf.set(k, null);
          }
          if (seq.current !== mine) return;
        }
        const mainPath = mainOf.get(k);
        if (!mainPath) continue;
        out.push({ workspaceId: ws.id, name: ws.name, pr: ws.metadata?.pr ?? null, repoPath: top, mainPath });
      }
      if (seq.current === mine) setResolved(out);
    })();
    return () => { seq.current++; };
  }, [workspaceIds, refreshKey]);
  if (resolved === null) return null;
  return groupWorkspacesByRepo(resolved, activeWorkspaceId, hostPlatform());
}
