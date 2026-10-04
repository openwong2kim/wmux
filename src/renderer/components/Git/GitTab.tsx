// ─── Git page body — a repo's git surface ────────────────────────────────────
//
// Repo context = the active pane's live cwd (OSC 7-tracked surface.cwd),
// normalized to its worktree toplevel by diff:resolveRepo — the same
// resolution the workspace-diff palette command uses — or, for an All repos
// group, a fixed repo path. Pull-only: fetch on mount / workspace switch /
// manual refresh / after each mutation, and only while the Git page is shown
// and the window visible (hiding it drops whatever is in flight; showing it
// again reloads). git is the source of truth on disk, so there is nothing to
// persist or push here.
//
// Lived in the tools panel as the Git tab with the Review section under it
// until 2026-10-03; the two lists are now one: a row per worktree, saying
// which workspaces sit on it and their uncommitted diff stat (worktreeRows).
//
// Actions per worktree row: "Diff" (diff surface for that worktree in the
// active pane), "Open" (new workspace whose startupCwd is the worktree),
// "Merge" (isolated merge session into the base branch) and "Remove"
// (`git worktree remove`, no --force — a dirty worktree is refused by git
// itself and the stderr is surfaced as-is). The main worktree shows a badge
// instead of Remove. A workspace name on a row switches to that workspace.
//
// Design contract (DESIGN.md): monochrome glyphs, branches and paths in mono,
// diff counts green/red, and at most ONE accent point — the dot marking the
// worktree the active pane is in.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import type { Pane, PaneLeaf } from '../../../shared/types';
import type { WorktreeEntry } from '../../../shared/worktreeParse';
import type { MergeSessionStatus } from '../../../main/git/mergeSession';
import type { DiffReadResult, DiffReadError } from '../../../shared/diffParse';
import { ShipButton } from './ShipButton';
import { PrBadge } from '../Sidebar/WorkspaceItem';
import { isPlausibleCwd } from '../../../shared/cwdShape';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { resolveRepoCached } from './repoCache';
import {
  buildWorktreeRows, groupWorktreeRows, normWorktreePath, worktreeContaining, STALE_WORKTREE_DAYS,
  type DiffStat, type GitWorktreeRow, type WorkspaceOnRepo, type WorktreeRowUI,
} from './worktreeRows';

/** Settle time before the per-worktree diff stats are read. */
export const ROW_STATS_DEBOUNCE_MS = 400;

type MergeStart = { ok: true; status: MergeSessionStatus } | { ok: false; error: string };
type MergeStatus = { ok: true; status: MergeSessionStatus | null } | { ok: false; error: string };
type MergeAction = { ok: true } | { ok: false; error: string };

export function hostPlatform(): string | undefined {
  // The host OS, not the renderer's process.platform default — on a POSIX CI
  // runner that would reject Windows paths.
  return (window as unknown as { electronAPI?: { platform?: string } }).electronAPI?.platform ?? undefined;
}

function findActiveLeaf(root: Pane, activePaneId: string): PaneLeaf | null {
  if (root.type === 'leaf') return root.id === activePaneId ? root : null;
  for (const child of root.children) {
    const found = findActiveLeaf(child, activePaneId);
    if (found) return found;
  }
  return null;
}

/** First leaf fallback — a workspace's activePaneId can point at a just-closed pane. */
function findFirstLeaf(root: Pane): PaneLeaf | null {
  if (root.type === 'leaf') return root;
  for (const child of root.children) {
    const found = findFirstLeaf(child);
    if (found) return found;
  }
  return null;
}

// Repo-base cwd candidates of a workspace, in priority order (2026-07-21): an
// agent TUI pane's shell cwd can sit outside the repo (shell in home, agent in
// the repo), so the hook-reported metadata.cwd is the second candidate. The
// caller tries them in order and keeps the first that resolves.
export function repoCwdCandidates(
  ws: { rootPane: Pane; activePaneId: string; metadata?: { cwd?: string }; profile?: { startupCwd?: string } },
  startupDirectory: string,
  fallbackToFirstLeaf: boolean,
): string[] {
  const leaf = findActiveLeaf(ws.rootPane, ws.activePaneId) ?? (fallbackToFirstLeaf ? findFirstLeaf(ws.rootPane) : null);
  const surface = leaf?.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  // A polluted cwd (an impossible shape saved by a scraping false positive) is skipped.
  const surfaceCwd = surface?.cwd && isPlausibleCwd(surface.cwd, hostPlatform()) ? surface.cwd : '';
  const candidates = [
    surfaceCwd,
    ws.metadata?.cwd ?? '',
    ws.profile?.startupCwd ?? '',
    startupDirectory,
  ].filter(Boolean);
  return [...new Set(candidates)];
}

// The active workspace's candidates as one primitive string, so the selector
// only re-renders when they change.
function selectActivePaneCwdCandidates(state: StoreState): string {
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return '';
  return repoCwdCandidates(ws, state.startupDirectory || '', false).join('\0');
}

export function pathLeaf(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

type ResolveRepo = (cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }>;

interface WorktreeBridge {
  list: (repoPath: string) => Promise<
    | { ok: true; repoPath: string; mainPath: string; worktrees: WorktreeRowUI[] }
    | { ok: false; error: string }
  >;
  add: (repoPath: string, branch: string) => Promise<
    { ok: true; worktreePath: string } | { ok: false; error: string }
  >;
  remove: (repoPath: string, worktreePath: string) => Promise<
    { ok: true; worktreePath: string } | { ok: false; error: string }
  >;
  // Merge session (isolated integration worktree). Optional: an older preload lacks it.
  mergeStart?: (repoPath: string, sourcePath: string) => Promise<MergeStart>;
  mergeStatus?: (repoPath: string) => Promise<MergeStatus>;
  mergeLand?: (repoPath: string) => Promise<MergeAction>;
  mergeDiscard?: (repoPath: string) => Promise<MergeAction>;
}

type DiffRead = (worktreePath: string, targetHeadOid: string, mode: 'task' | 'workspace') => Promise<DiffReadResult | DiffReadError>;

function getBridges(): { worktree: WorktreeBridge | null; resolveRepo: ResolveRepo | null; readDiff: DiffRead | null } {
  const api = (
    window as unknown as {
      electronAPI?: { worktree?: WorktreeBridge; diff?: { resolveRepo?: ResolveRepo; read?: DiffRead } };
    }
  ).electronAPI;
  return { worktree: api?.worktree ?? null, resolveRepo: api?.diff?.resolveRepo ?? null, readDiff: api?.diff?.read ?? null };
}

/** Diff counts, coloured like a diff; the changed-path count when only untracked files changed. */
function DiffCounts({ stat, t }: { stat: DiffStat; t: (k: string) => string }): React.ReactElement {
  if (stat.error) {
    return <span className="wmux-git-stat" title={stat.error}>—</span>;
  }
  if (stat.files === 0) return <span className="wmux-git-stat">{t('review.clean') || 'clean'}</span>;
  return (
    <span className="wmux-git-stat" title={`${stat.files} ${t('review.files') || 'files'} +${stat.additions} −${stat.deletions}`}>
      {stat.additions > 0 && <span style={{ color: 'var(--accent-green)' }}>+{stat.additions}</span>}
      {stat.deletions > 0 && <span style={{ color: 'var(--accent-red)' }}>−{stat.deletions}</span>}
      {stat.additions + stat.deletions === 0 && <span>·{stat.files}</span>}
    </span>
  );
}

export interface GitTabProps {
  /** Repo base override; without it the active pane's cwd decides. */
  cwd?: string;
  /** Bumped by the page's refresh button. */
  refreshKey?: number;
  /** Tells the page which repo it is showing (the main worktree's folder name). */
  onRepo?: (name: string | null) => void;
  /** summary = the one-line current-branch bar with Diff, Open PR, Go to
   *  terminal and the ship button (the Git page's top); worktrees = the
   *  grouped worktree list with the new-branch line and the merge session on
   *  top (the Worktrees tab, or one checkout in All repos); full = both. */
  layout?: 'full' | 'summary' | 'worktrees';
  /** Tells the page the repo's paths once resolved (null: no repo). */
  onResolved?: (r: { repoPath: string; mainPath: string } | null) => void;
  /** Drawn right under the card (the page's scope filter), repo or not. */
  slot?: React.ReactNode;
  /** The workspaces on this repo, already resolved by the caller (All repos
   *  resolves every workspace once for all groups), so this skips its own pass. */
  workspacesOnRepo?: readonly WorkspaceOnRepo[];
  /** False for a repo the active pane is not in: no row gets the dot. */
  markCurrent?: boolean;
  /** The worktree that gets the dot when `cwd` pins the repo (All repos):
   *  the active pane's, passed apart so switching panes within the repo does
   *  not change `cwd` and reload the group. */
  currentPath?: string;
}

export function GitTab({
  cwd, refreshKey = 0, onRepo, onResolved, layout = 'full', slot, workspacesOnRepo, markCurrent = true, currentPath,
}: GitTabProps = {}): React.ReactElement {
  const showCard = layout === 'full' || layout === 'summary';
  const showSections = layout !== 'summary';
  // Hidden window: nothing is read, and what is in flight is dropped.
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  const t = useT();
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  // Subscribed so focusing a pane in another repo within the same workspace
  // reloads too. A prop cwd wins outright — no fallback to the active pane.
  const activePaneCwdCandidates = useStore(selectActivePaneCwdCandidates);
  const activeCwdCandidates = cwd != null ? cwd : activePaneCwdCandidates;
  // Row identity only — names and metadata are re-read inside load(). Only
  // the full layout resolves the workspace list itself; a group is handed its
  // workspaces, and the card reads just its own worktree.
  const workspaceIds = useStore((s) => (showSections && !workspacesOnRepo ? s.workspaces.map((w) => w.id).join('\0') : ''));
  // The current-branch card's live parts (pushed by main, no polling here).
  const activeMeta = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.metadata);
  const pushToast = useStore((s) => s.pushToast);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  // The main worktree's path — the "main" badge and the hidden Remove. Not the
  // current worktree (the dot): opened from a linked worktree, the two differ.
  const [mainPath, setMainPath] = useState<string>('');
  const [currentWorktree, setCurrentWorktree] = useState<string>('');
  const [worktrees, setWorktrees] = useState<WorktreeRowUI[]>([]);
  const [onRepoWorkspaces, setOnRepoWorkspaces] = useState<WorkspaceOnRepo[]>([]);
  const [stats, setStats] = useState<Record<string, DiffStat>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState('');
  const [busy, setBusy] = useState(false);
  // Active merge session (isolated integration worktree); null = none. main
  // owns it, so every load rehydrates it (restart recovery included).
  const [session, setSession] = useState<MergeSessionStatus | null>(null);
  // Monotonic load token — on a fast repo switch a late earlier response must
  // not overwrite the newer result. Only the latest load() commits. Unmounting
  // bumps it too, so nothing lands (nor reloads) after the section folds.
  const loadSeq = useRef(0);
  const mounted = useRef(false);
  const onRepoRef = useRef(onRepo);
  onRepoRef.current = onRepo;
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  const givenWorkspaces = useRef(workspacesOnRepo);
  givenWorkspaces.current = workspacesOnRepo;
  const givenKey = workspacesOnRepo?.map((w) => `${w.workspaceId}\0${w.repoPath}`).join('\n') ?? '';

  const load = useCallback(async (force = false) => {
    if (!mounted.current) return;
    if (document.hidden) return;
    const seq = ++loadSeq.current;
    // Every follow-up IPC checks this: still the newest load, still mounted,
    // and the window still visible.
    const live = () => mounted.current && seq === loadSeq.current && !document.hidden;
    setLoading(true);
    setError(null);
    const { worktree, resolveRepo, readDiff } = getBridges();
    if (!worktree || !resolveRepo) {
      setError(t('git.bridgeUnavailable'));
      setLoading(false);
      return;
    }
    let current: string | null = null;
    for (const candidate of activeCwdCandidates.split('\0').filter(Boolean)) {
      const resolved = await resolveRepoCached(resolveRepo, candidate, force);
      if (!live()) return; // superseded by a newer load, or unmounted
      if (resolved !== null) { current = resolved; break; }
    }
    if (current === null) {
      setRepoPath(null);
      setWorktrees([]);
      setOnRepoWorkspaces([]);
      setStats({});
      setSession(null);
      setLoading(false);
      onRepoRef.current?.(null);
      onResolvedRef.current?.(null);
      return;
    }
    const res = await worktree.list(current);
    if (!live()) return;
    setCurrentWorktree(current);
    if (!res.ok) {
      setError(res.error);
      setRepoPath(null);
      setWorktrees([]);
      setSession(null);
      setLoading(false);
      onRepoRef.current?.(null);
      onResolvedRef.current?.(null);
      return;
    }
    setRepoPath(res.repoPath);
    setMainPath(res.mainPath);
    setWorktrees(res.worktrees);
    setLoading(false);
    onRepoRef.current?.(pathLeaf(res.mainPath || res.repoPath));
    onResolvedRef.current?.({ repoPath: res.repoPath, mainPath: res.mainPath || res.repoPath });
    // Merge session rehydrate — main derives it from MERGE_HEAD on disk, so an
    // in-flight session survives an app restart.
    // The summary bar needs it too: the ship button waits while one runs.
    if (worktree.mergeStatus) {
      if (!live()) return;
      const ms = await worktree.mergeStatus(res.repoPath);
      if (!live()) return;
      if (ms.ok) setSession(ms.status);
    }

    // Row stats wait for the pane to settle: a burst of cds or workspace
    // switches costs one round of reads, not one per step.
    await new Promise((r) => setTimeout(r, ROW_STATS_DEBOUNCE_MS));
    if (!live()) return;

    // Workspaces on this repo: each one's repo resolved from its own active
    // pane (first leaf if that is stale), kept when it is one of the worktrees.
    const plat = hostPlatform();
    const keys = new Set(res.worktrees.map((w) => normWorktreePath(w.path, plat)));
    const state = useStore.getState();
    let onRepo: WorkspaceOnRepo[] = [];
    if (givenWorkspaces.current) {
      onRepo = givenWorkspaces.current.filter((w) => keys.has(normWorktreePath(w.repoPath, plat)));
    } else if (showSections) {
      for (const ws of state.workspaces) {
        let rp: string | null = null;
        for (const candidate of repoCwdCandidates(ws, state.startupDirectory || '', true)) {
          rp = await resolveRepoCached(resolveRepo, candidate, force);
          if (!live()) return;
          if (rp !== null) break;
        }
        if (rp !== null && keys.has(normWorktreePath(rp, plat))) {
          onRepo.push({ workspaceId: ws.id, name: ws.name, pr: ws.metadata?.pr ?? null, repoPath: rp });
        }
      }
    }
    setOnRepoWorkspaces(onRepo);

    // Uncommitted diff stats for the worktrees a workspace sits on, as the
    // Review list did; idle worktrees are not read. The card alone reads only
    // its own worktree.
    if (!readDiff) return;
    const paths = new Map<string, string>();
    if (showSections) {
      for (const w of onRepo) paths.set(normWorktreePath(w.repoPath, plat), w.repoPath);
    } else {
      paths.set(normWorktreePath(current, plat), current);
    }
    const next: Record<string, DiffStat> = {};
    for (const [key, path] of paths) {
      const stat: DiffStat = { files: 0, additions: 0, deletions: 0, error: null };
      try {
        const diff = await readDiff(path, '', 'workspace');
        if (diff.ok) {
          stat.files = diff.numstat.length;
          for (const n of diff.numstat) {
            stat.additions += n.additions ?? 0;
            stat.deletions += n.deletions ?? 0;
          }
        } else {
          stat.error = diff.error;
        }
      } catch (e) {
        stat.error = e instanceof Error ? e.message : String(e);
      }
      if (!live()) return;
      next[key] = stat;
    }
    setStats(next);
  }, [activeCwdCandidates, t, showSections]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadSeq.current++;
    };
  }, []);

  // Reload on mount, workspace / pane cwd change, the workspace roster, and
  // the header's refresh (pull-only). A new context (another workspace or
  // pane cwd) first drops the old repo's content, so nothing on screen — and
  // no Diff / Merge / Remove — still points at the previous repo while the
  // new one loads.
  // With a fixed repo (an All repos group) a workspace switch is no new context.
  const context = cwd != null ? cwd : `${activeWorkspaceId}\0${activeCwdCandidates}`;
  const lastContext = useRef(context);
  const lastRefresh = useRef(refreshKey);
  useEffect(() => {
    if (hidden) {
      loadSeq.current++;
      return undefined;
    }
    if (lastContext.current !== context) {
      lastContext.current = context;
      setRepoPath(null);
      setMainPath('');
      setCurrentWorktree('');
      setWorktrees([]);
      setOnRepoWorkspaces([]);
      setStats({});
      setSession(null);
      onRepoRef.current?.(null);
      onResolvedRef.current?.(null);
    }
    const force = lastRefresh.current !== refreshKey;
    lastRefresh.current = refreshKey;
    void load(force);
    return () => {
      loadSeq.current++;
    };
  }, [load, context, workspaceIds, givenKey, refreshKey, hidden]);

  const handleCreate = useCallback(async () => {
    const branch = newBranch.trim();
    if (!branch || !repoPath || busy) return;
    const { worktree } = getBridges();
    if (!worktree) return;
    setBusy(true);
    // try/finally: busy is released even if the IPC rejects instead of returning {ok:false}.
    try {
      const res = await worktree.add(repoPath, branch);
      if (!res.ok) {
        pushToast({ level: 'warn', message: `${t('git.createFailed')}: ${res.error}` });
        return;
      }
      setNewBranch('');
      void load(true);
    } catch (e) {
      pushToast({ level: 'warn', message: `${t('git.createFailed')}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [newBranch, repoPath, busy, pushToast, t, load]);

  const handleRemove = useCallback(
    async (wt: WorktreeEntry) => {
      if (!repoPath || busy) return;
      if (!window.confirm(`${t('git.removeConfirm')}\n${wt.path}`)) return;
      const { worktree } = getBridges();
      if (!worktree) return;
      setBusy(true);
      try {
        const res = await worktree.remove(repoPath, wt.path);
        if (!res.ok) {
          // A dirty worktree and the like — git's refusal surfaces as-is (no --force).
          pushToast({ level: 'warn', message: `${t('git.removeFailed')}: ${res.error}` });
          return;
        }
        void load(true);
      } catch (e) {
        pushToast({ level: 'warn', message: `${t('git.removeFailed')}: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setBusy(false);
      }
    },
    [repoPath, busy, pushToast, t, load],
  );

  const handleOpen = useCallback((wt: WorktreeEntry) => {
    const st = useStore.getState();
    // #515: attach the profile atomically with creation so pane #1 spawns in
    // startupCwd (the create → setWorkspaceProfile pair left pane #1 in home).
    st.addWorkspace(wt.branch ?? pathLeaf(wt.path), { startupCwd: wt.path });
    showWorkspaces(useStore.getState());
  }, []);

  // Diff surface for a worktree on the active workspace's active leaf — the
  // path is already a toplevel, so no resolveRepo; same result (and the same
  // dedup of an existing tab) as the palette's "Show Git Diff".
  const handleDiff = useCallback((targetPath: string) => {
    const st = useStore.getState();
    const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId);
    if (!ws) return;
    const leaf = findActiveLeaf(ws.rootPane, ws.activePaneId) ?? findFirstLeaf(ws.rootPane);
    if (!leaf) return;
    st.addWorkspaceDiffSurface(leaf.id, targetPath, `diff: ${pathLeaf(targetPath)}`);
    // The diff tab lands on a pane, so show the page the panes live on.
    showWorkspaces(useStore.getState());
  }, []);

  const goTo = useCallback((workspaceId: string) => {
    useStore.getState().setActiveWorkspace(workspaceId);
    showWorkspaces(useStore.getState());
  }, []);

  // Start a merge — this worktree (source) into base, isolated. One session at a time.
  const handleMerge = useCallback(
    async (wt: WorktreeRowUI) => {
      if (!repoPath || busy || session) return;
      const { worktree } = getBridges();
      if (!worktree?.mergeStart) return;
      setBusy(true);
      try {
        const res = await worktree.mergeStart(repoPath, wt.path);
        if (!res.ok) {
          pushToast({ level: 'warn', message: `${t('git.mergeFailed') || 'Merge failed'}: ${res.error}` });
          return;
        }
        setSession(res.status);
      } catch (e) {
        pushToast({ level: 'warn', message: `${t('git.mergeFailed') || 'Merge failed'}: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setBusy(false);
      }
    },
    [repoPath, busy, session, pushToast, t],
  );

  // Land — fast-forward base to the result, only after verify passed.
  const handleLand = useCallback(async () => {
    if (!repoPath || busy) return;
    const { worktree } = getBridges();
    if (!worktree?.mergeLand) return;
    setBusy(true);
    try {
      const res = await worktree.mergeLand(repoPath);
      if (!res.ok) {
        pushToast({ level: 'warn', message: `${t('git.landFailed') || 'Land failed'}: ${res.error}` });
        return;
      }
      setSession(null);
      pushToast({ level: 'info', message: t('git.landed') || 'Merged into base.' });
      void load(true);
    } catch (e) {
      pushToast({ level: 'warn', message: `${t('git.landFailed') || 'Land failed'}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [repoPath, busy, pushToast, t, load]);

  // Discard — merge --abort and remove the integration worktree; base unchanged.
  const handleDiscard = useCallback(async () => {
    if (!repoPath || busy) return;
    const { worktree } = getBridges();
    if (!worktree?.mergeDiscard) return;
    setBusy(true);
    try {
      const res = await worktree.mergeDiscard(repoPath);
      if (!res.ok) {
        pushToast({ level: 'warn', message: `${t('git.discardFailed') || 'Discard failed'}: ${res.error}` });
        return;
      }
      setSession(null);
      void load(true);
    } catch (e) {
      pushToast({ level: 'warn', message: `${t('git.discardFailed') || 'Discard failed'}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [repoPath, busy, pushToast, t, load]);

  // On a conflict: open the integration worktree as a new workspace so the
  // user resolves it with an agent (not automatic; the handleOpen pattern).
  const openIntegration = useCallback(() => {
    if (!session) return;
    const st = useStore.getState();
    // #515: attach the profile atomically with creation (see handleOpen).
    st.addWorkspace(`merge: ${session.sourceBranch ?? pathLeaf(session.integrationPath)}`, { startupCwd: session.integrationPath });
    showWorkspaces(useStore.getState());
  }, [session]);

  // Poll the session only through its transient phases (merging/verifying).
  const sessionPhase = session?.phase;
  useEffect(() => {
    if (hidden) return;
    if (sessionPhase !== 'merging' && sessionPhase !== 'verifying') return;
    const { worktree } = getBridges();
    const mergeStatus = worktree?.mergeStatus;
    if (!mergeStatus || !repoPath) return;
    let cancelled = false;
    const id = setInterval(async () => {
      if (document.hidden) return;
      const res = await mergeStatus(repoPath);
      if (cancelled) return;
      if (res.ok) setSession(res.status);
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionPhase, repoPath, hidden]);

  // The merge session is shared through the store: the Worktrees tab starts,
  // lands or discards it while the branch bar's ship button waits on it.
  const mergeKey = mainPath ? normWorktreePath(mainPath, hostPlatform()) : '';
  const setGitMerge = useStore((s) => s.setGitMerge);
  const sharedMerge = useStore((s) => (mergeKey ? s.gitMerge[mergeKey] : undefined));
  useEffect(() => {
    if (mergeKey) setGitMerge(mergeKey, session !== null);
  }, [mergeKey, session, setGitMerge]);
  const mergeActive = sharedMerge ?? session !== null;

  const rows = buildWorktreeRows({
    worktrees,
    mainPath,
    currentPath: currentPath ?? (markCurrent ? currentWorktree : ''),
    // A group's workspaces come live from the page (names and PRs update
    // without a reload); otherwise the ones this load resolved.
    workspaces: workspacesOnRepo ?? onRepoWorkspaces,
    stats,
    platform: hostPlatform(),
  });
  const currentRow = rows.find((r) => r.isCurrent) ?? null;
  const currentBranch = currentRow?.entry.branch ?? null;
  // The workspace's pushed metadata trails the active pane; it describes the
  // card only while it is about this very worktree — the same branch name in
  // another repo (two `main`s) must not lend its ahead/behind, PR or CI.
  const plat = hostPlatform();
  const metaWorktree = activeMeta?.cwd ? worktreeContaining(activeMeta.cwd, worktrees.map((w) => w.path), plat) : null;
  const metaMatches = !!currentBranch
    && activeMeta?.gitBranch === currentBranch
    && metaWorktree !== null
    && normWorktreePath(metaWorktree, plat) === normWorktreePath(currentWorktree, plat);
  const sync = metaMatches && activeMeta?.gitSync?.hasUpstream ? activeMeta.gitSync : null;
  const cardPr = metaMatches ? activeMeta?.pr ?? null : null;
  // Uncommitted changes: the row's own read when there is one (it is read
  // anyway, and fresher than the pushed status), else the pushed git status
  // when it is about this worktree — never an extra git call for the card.
  const cardStat: DiffStat | null = currentRow?.stat
    ?? (metaMatches && activeMeta?.gitSync
      ? { files: activeMeta.gitSync.dirty, additions: activeMeta.gitSync.added ?? 0, deletions: activeMeta.gitSync.removed ?? 0, error: null }
      : null);

  const renderRow = (row: GitWorktreeRow) => {
    const wt = row.entry;
    const firstPr = row.workspaces.find((w) => w.pr)?.pr ?? null;
    return (
      <li key={wt.path} className="wmux-git-row group" data-git-worktree-row data-current={row.isCurrent ? 'true' : undefined}>
        {/* The one accent point: the worktree the active pane is in. */}
        <span aria-hidden="true" className="wmux-git-dot" data-on={row.isCurrent ? 'true' : undefined} />
        <div className="wmux-git-row-text" data-git-row-text>
          <span className="wmux-git-branch" title={wt.branch ?? undefined}>
            {wt.branch ?? `(${t('git.detached') || 'detached'} ${wt.headOid.slice(0, 7)})`}
          </span>
          <span className="wmux-git-sub" title={wt.path}>
            {row.workspaces.length > 0 ? (
              <>
                {row.workspaces.map((w, i) => (
                  <span key={w.workspaceId}>
                    {i > 0 && ', '}
                    {w.workspaceId === activeWorkspaceId ? (
                      w.name
                    ) : (
                      <button
                        type="button"
                        className={`wmux-git-link ${FOCUS_RING}`}
                        onClick={() => goTo(w.workspaceId)}
                        title={t('review.goDesc') || 'Switch to this workspace'}
                      >
                        {w.name}
                      </button>
                    )}
                  </span>
                ))}
              </>
            ) : (
              pathLeaf(wt.path)
            )}
            {wt.locked !== null && ` · ${t('git.locked') || 'locked'}`}
            {wt.prunable !== null && ` · ${t('git.prunable') || 'prunable'}`}
            {firstPr && <span className="wmux-git-sub-pr"><PrBadge pr={firstPr} /></span>}
          </span>
        </div>
        {row.isMain && <span className="wmux-git-main-badge">{t('git.main') || 'main'}</span>}
        {row.stat && <DiffCounts stat={row.stat} t={t} />}
        <div className="wmux-git-row-actions" data-git-row-actions>
          <button
            type="button"
            onClick={() => handleDiff(wt.path)}
            className={`wmux-git-action ${FOCUS_RING}`}
            title={t('git.diffDesc') || 'Open the diff view for this worktree'}
          >
            {t('git.diff') || 'Diff'}
          </button>
          <button
            type="button"
            onClick={() => handleOpen(wt)}
            className={`wmux-git-action ${FOCUS_RING}`}
            title={t('git.openDesc') || 'Open as a new workspace'}
          >
            {t('git.open') || 'Open'}
          </button>
          {/* Isolated merge of this worktree into base — feature rows only, one session at a time. */}
          {!row.isMain && wt.branch && (
            <button
              type="button"
              onClick={() => void handleMerge(wt)}
              disabled={busy || session !== null}
              className={`wmux-git-action ${FOCUS_RING}`}
              title={t('git.mergeDesc') || 'Merge this worktree into the base branch (isolated, verified)'}
            >
              {t('git.merge') || 'Merge'}
            </button>
          )}
          {!row.isMain && (
            <button
              type="button"
              onClick={() => void handleRemove(wt)}
              disabled={busy}
              className={`wmux-git-action wmux-git-action-danger ${FOCUS_RING}`}
              title={t('git.removeDesc') || 'Remove worktree (refused if dirty)'}
            >
              {t('git.remove') || 'Remove'}
            </button>
          )}
        </div>
      </li>
    );
  };

  const bar = repoPath && showCard ? (
    <div className="wmux-git-bar" data-git-current-branch>
      <span className="wmux-git-branch" title={currentWorktree}>
        {currentBranch ?? (currentRow ? `(${t('git.detached') || 'detached'} ${currentRow.entry.headOid.slice(0, 7)})` : pathLeaf(currentWorktree))}
      </span>
      {sync && (sync.ahead > 0 || sync.behind > 0) && (
        <span
          className="wmux-git-stat"
          data-git-ahead-behind
          title={t('workspace.gitSyncTooltip', { ahead: sync.ahead, behind: sync.behind, dirty: sync.dirty })}
        >
          {sync.ahead > 0 && <span style={{ color: 'var(--accent-blue)' }}>↑{sync.ahead}</span>}
          {sync.behind > 0 && <span style={{ color: 'var(--accent-red)' }}>↓{sync.behind}</span>}
        </span>
      )}
      {cardStat && (
        <span className="wmux-git-card-changes" data-git-changes>
          {cardStat.files > 0 && <span>{cardStat.files} {t('review.files') || 'files'}</span>}
          <DiffCounts stat={cardStat} t={t} />
        </span>
      )}
      {cardPr && (
        <span className="wmux-git-card-pr" data-git-current-pr>
          <PrBadge pr={cardPr} />
          <span>
            {t(`workspace.prState.${cardPr.state}`)}
            {cardPr.checks && ` · ${t(`workspace.prChecks.${cardPr.checks}`)}`}
          </span>
        </span>
      )}
      <div className="wmux-git-bar-actions">
        <button
          type="button"
          onClick={() => handleDiff(currentWorktree || repoPath)}
          title={t('git.diffDesc') || 'Open the diff view for this repo'}
          data-git-diff-current
          className={`wmux-git-button ${FOCUS_RING}`}
        >
          {t('git.diff') || 'Diff'}
        </button>
        <button
          type="button"
          onClick={() => showWorkspaces(useStore.getState())}
          title={t('git.goTerminalDesc')}
          data-git-go-terminal
          className={`wmux-git-button ${FOCUS_RING}`}
        >
          {t('git.goTerminal')}
        </button>
        {layout === 'summary' ? (
          // The ship button carries Open PR (beside it, or as its step).
          <ShipButton
            key={currentWorktree || repoPath}
            repoPath={currentWorktree || repoPath}
            mergeActive={mergeActive}
            refreshKey={refreshKey}
            changeKey={activeMeta?.gitSync ? `${activeMeta.gitSync.dirty}:${activeMeta.gitSync.ahead}:${activeMeta.gitSync.behind}:${activeMeta.pr?.state ?? ''}` : ''}
            onShipped={() => void load(true)}
          />
        ) : cardPr && (
          <button
            type="button"
            onClick={() => window.electronAPI?.shell?.openExternal?.(cardPr.url)}
            className={`wmux-git-button ${FOCUS_RING}`}
            title={t('git.openInBrowser') || 'Open in browser'}
          >
            {t('git.openPr') || 'Open PR'}
          </button>
        )}
      </div>
    </div>
  ) : null;

  const mergeEl = session && repoPath ? (
      <div data-git-merge-session className="wmux-git-merge">
        <div className="flex items-center gap-2">
          {/* Phase dot: in flight = accent · verified = green · trouble = red. */}
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{
              backgroundColor:
                session.phase === 'verified'
                  ? 'var(--accent-green)'
                  : session.phase === 'failed' || session.phase === 'conflicted'
                    ? 'var(--accent-red)'
                    : session.phase === 'merging' || session.phase === 'verifying'
                      ? 'var(--accent)'
                      : 'var(--text-muted)',
            }}
          />
          <span className="truncate text-[var(--text-main)]">
            {(session.sourceBranch ?? pathLeaf(session.integrationPath))} → {session.baseBranch}
          </span>
          <div className="flex-1" />
          <span className="shrink-0 text-[var(--text-sub)]">
            {session.phase === 'merging'
              ? t('git.mergePhaseMerging') || 'Merging…'
              : session.phase === 'verifying'
                ? t('git.mergePhaseVerifying') || 'Verifying…'
                : session.phase === 'verified'
                  ? t('git.mergePhaseVerified') || 'Verified'
                  : session.phase === 'failed'
                    ? t('git.mergePhaseFailed') || 'Verify failed'
                    : session.phase === 'conflicted'
                      ? t('git.mergePhaseConflict') || 'Conflict'
                      : t('git.mergePhaseReady') || 'Ready'}
          </span>
        </div>
        {/* Plain-language summary — changed files + verify result. */}
        <div className="text-[var(--text-muted)]">
          {session.phase === 'conflicted'
            ? t('git.mergeSummary.conflicted', { count: session.conflicts.length })
            : session.phase === 'verifying'
              ? t('git.mergeSummary.verifying', { count: session.changedFiles })
              : session.phase === 'verified'
                ? session.changedFiles > 0
                  ? t('git.mergeSummary.verified', { count: session.changedFiles })
                  : t('git.mergeSummary.nothing')
                : session.phase === 'failed'
                  ? `${t('git.mergeSummary.failed', { count: session.changedFiles })}${session.verify?.failedStep ? ` (${session.verify.failedStep})` : ''}${session.verify?.timedOut ? ` · ${t('git.mergeSummary.timedOut')}` : ''}`
                  : t('git.mergeSummary.changed', { count: session.changedFiles })}
        </div>
        <div className="flex items-center gap-1.5">
          {session.phase === 'conflicted' && (
            <button
              type="button"
              onClick={openIntegration}
              className={`wmux-git-button ${FOCUS_RING}`}
              title={t('git.mergeOpenConflictDesc') || 'Open the integration worktree as a workspace to resolve conflicts with Claude'}
            >
              {t('git.mergeOpenConflict') || 'Conflict — open with Claude'}
            </button>
          )}
          {session.phase === 'verified' && (
            <button
              type="button"
              onClick={() => void handleLand()}
              disabled={busy}
              className={`wmux-git-button ${FOCUS_RING}`}
              title={t('git.landDesc') || 'Commit the verified merge and fast-forward the base branch'}
            >
              {t('git.land') || 'Land'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleDiscard()}
            disabled={busy}
            className={`wmux-git-button wmux-git-action-danger ${FOCUS_RING}`}
            title={t('git.discardDesc') || 'Abort the merge and remove the integration worktree (base unchanged)'}
          >
            {t('git.discard') || 'Discard'}
          </button>
        </div>
      </div>
  ) : null;

  const groups = groupWorktreeRows(rows, Date.now());
  const group = (key: 'inUse' | 'idle' | 'cleanup', items: GitWorktreeRow[]) => items.length > 0 && (
    <section key={key} className="wmux-git-wt-group" data-git-wt-group={key} aria-label={t(`git.wt.${key}`)}>
      <h3 className="wmux-git-subhead">{t(`git.wt.${key}`)} · {items.length}</h3>
      {key === 'cleanup' && (
        <p className="wmux-git-wt-caption">{t('git.wt.cleanupCaption', { days: STALE_WORKTREE_DAYS })}</p>
      )}
      <ul data-git-worktree-list>{items.map(renderRow)}</ul>
    </section>
  );

  return (
    <div data-git-tab className="wmux-git-body" data-layout={layout}>
      {loading && !repoPath && <div className="wmux-git-note">{t('git.loading') || 'Loading…'}</div>}
      {!loading && error && <div className="wmux-git-note break-all">{error}</div>}
      {!loading && !error && !repoPath && (
        <div className="wmux-git-note">{t('git.noRepo') || 'Not a git repository — focus a pane inside a repo.'}</div>
      )}
      {/* Current branch, one line: branch, ahead/behind, changes, PR, then Diff / Go to terminal / ship. */}
      {bar}
      {slot}
      {repoPath && showSections && (
        <div className="wmux-git-worktrees" aria-label={t('git.worktrees') || 'Worktrees'}>
          {/* New worktree — one branch-name line (main derives the location) — and the merge session, on top. */}
          <div className="wmux-git-create">
            <input
              type="text"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
              placeholder={t('git.newBranchPlaceholder') || 'new branch name…'}
              aria-label={t('git.newBranchPlaceholder') || 'new branch name…'}
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={busy || !newBranch.trim()}
              className={`wmux-git-button ${FOCUS_RING}`}
            >
              {t('git.create') || 'Create'}
            </button>
          </div>
          {mergeEl}
          {group('inUse', groups.inUse)}
          {group('idle', groups.idle)}
          {group('cleanup', groups.cleanup)}
        </div>
      )}
    </div>
  );
}

export default GitTab;
