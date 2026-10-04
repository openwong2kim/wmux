// The repo the Git page shows in This repo: the worktree the active pane is
// in, that repo's main worktree and its remote identity (host/owner/repo).
// Read through the shared caches, so the Worktrees tab (which reads the same
// answers when open) and All repos cost no second round of git calls. Nothing
// is read while the window is hidden; a refresh reads past the caches.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { hostPlatform, selectActivePaneCwdCandidates } from './GitTab';
import { mainPathCached, repoKeyCached, resolveRepoCached } from './repoCache';

export interface ActiveRepo {
  /** The active pane's worktree (what the lists read through gh). */
  repoPath: string;
  /** The repo's main worktree. */
  mainPath: string;
  /** host/owner/repo of its remote, or null without one. */
  remoteKey: string | null;
}

type Bridges = {
  diff?: { resolveRepo?: (cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }> };
  worktree?: { list?: (p: string) => Promise<{ ok: true; mainPath: string; worktrees: { path: string }[] } | { ok: false }> };
  github?: { repoKey?: (p: string) => Promise<{ key: string | null }> };
};

export function useActiveRepo(refreshKey: number): { repo: ActiveRepo | null; loading: boolean } {
  const candidates = useStore(selectActivePaneCwdCandidates);
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  const [state, setState] = useState<{ repo: ActiveRepo | null; loading: boolean }>({ repo: null, loading: true });
  const lastCandidates = useRef(candidates);
  const lastRefresh = useRef(refreshKey);

  useEffect(() => {
    if (hidden) return undefined;
    let live = true;
    const force = lastRefresh.current !== refreshKey;
    lastRefresh.current = refreshKey;
    // Another pane or workspace: nothing on screen still points at the old repo.
    if (lastCandidates.current !== candidates) {
      lastCandidates.current = candidates;
      setState({ repo: null, loading: true });
    }
    const done = (repo: ActiveRepo | null) => {
      if (!live) return;
      setState((s) => (s.repo && repo && s.repo.repoPath === repo.repoPath && s.repo.mainPath === repo.mainPath
        && s.repo.remoteKey === repo.remoteKey && !s.loading ? s : { repo, loading: false }));
    };
    void (async () => {
      const api = (window as unknown as { electronAPI?: Bridges }).electronAPI;
      const resolveRepo = api?.diff?.resolveRepo;
      const list = api?.worktree?.list;
      if (!resolveRepo || !list) return done(null);
      let top: string | null = null;
      for (const cwd of candidates.split('\0').filter(Boolean)) {
        top = await resolveRepoCached(resolveRepo, cwd, force);
        if (!live) return;
        if (top !== null) break;
      }
      if (top === null) return done(null);
      const plat = hostPlatform();
      const mainPath = await mainPathCached(list, top, plat, force);
      if (!live) return;
      if (!mainPath) return done(null);
      const remoteKey = await repoKeyCached(api?.github?.repoKey, mainPath, plat, force);
      done({ repoPath: top, mainPath, remoteKey });
    })();
    return () => { live = false; };
  }, [candidates, refreshKey, hidden]);

  return state;
}
