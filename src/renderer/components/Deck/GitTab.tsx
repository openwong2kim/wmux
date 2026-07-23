// ─── Deck Git tab — the workspace's git surface (worktrees v1) ───────────────
//
// Repo context = the active pane's live cwd (OSC 7-tracked surface.cwd),
// normalized to its worktree toplevel by diff:resolveRepo — the same
// resolution the workspace-diff palette command uses. Pull-only: fetch on
// mount / workspace switch / manual refresh / after each mutation. git is the
// source of truth on disk, so there is nothing to persist or push here.
//
// Actions per worktree row: "Open" (new workspace whose startupCwd is the
// worktree) and "Remove" (`git worktree remove`, no --force — a dirty
// worktree is refused by git itself and the stderr is surfaced as-is).
// The main worktree shows a badge instead of Remove.
//
// Design contract (DESIGN.md): monochrome glyphs only, paths in mono, and at
// most ONE amber point — the dot marking the worktree the active pane is in.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { Pane, PaneLeaf } from '../../../shared/types';
import type { WorktreeEntry } from '../../../shared/worktreeParse';
import type { MergeSessionStatus } from '../../../main/git/mergeSession';
import { PrSection } from './PrSection';
import { isPlausibleCwd } from '../../../shared/cwdShape';

// worktree list row — optional MERGING derived field from main for restart recovery.
type WorktreeRowUI = WorktreeEntry & { merging?: boolean; integration?: boolean; conflicts?: number };

type MergeStart = { ok: true; status: MergeSessionStatus } | { ok: false; error: string };
type MergeStatus = { ok: true; status: MergeSessionStatus | null } | { ok: false; error: string };
type MergeAction = { ok: true } | { ok: false; error: string };

// Active workspace active pane → repo-base cwd candidate list (priority order).
// Also reused by selector (converge to raw string from store — minimize re-renders).
//
// Why a list (2026-07-21 measured): agent TUI pane surface.cwd (shell cwd) may be
// outside repo — shell at home while agent works in repo
// (observed: surface.cwd=C:\Users\me, metadata.cwd=D:\wmux). metadata.cwd is hook-reported
// agent cwd already trusted by sidebar branch so second candidate.
// load() tries resolveRepo in order and adopts first success.
function selectActivePaneCwdCandidates(state: StoreState): string {
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return '';
  const findLeaf = (pane: Pane): PaneLeaf | null => {
    if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
    for (const child of pane.children) {
      const found = findLeaf(child);
      if (found) return found;
    }
    return null;
  };
  const leaf = findLeaf(ws.rootPane);
  const surface = leaf?.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  // Skip tainted cwd (impossible shape saved by scrape false positive) and use fallback.
  // platform is host OS (same source as ReviewTab.normRepo) — renderer
  // process.platform default rejects Windows paths on CI POSIX runners.
  const plat = (window as unknown as { electronAPI?: { platform?: string } }).electronAPI?.platform;
  const surfaceCwd = surface?.cwd && isPlausibleCwd(surface.cwd, plat ?? undefined) ? surface.cwd : '';
  const candidates = [
    surfaceCwd,
    ws.metadata?.cwd ?? '',
    ws.profile?.startupCwd ?? '',
    state.startupDirectory || '',
  ].filter(Boolean);
  return [...new Set(candidates)].join('\0');
}

function pathLeaf(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

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
  // Merge session (isolated integration worktree). optional on older preload.
  mergeStart?: (repoPath: string, sourcePath: string) => Promise<MergeStart>;
  mergeStatus?: (repoPath: string) => Promise<MergeStatus>;
  mergeLand?: (repoPath: string) => Promise<MergeAction>;
  mergeDiscard?: (repoPath: string) => Promise<MergeAction>;
}

function getBridges(): { worktree: WorktreeBridge | null; resolveRepo: ((cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }>) | null } {
  const api = (
    window as unknown as {
      electronAPI?: { worktree?: WorktreeBridge; diff?: { resolveRepo?: (cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }> } };
    }
  ).electronAPI;
  return { worktree: api?.worktree ?? null, resolveRepo: api?.diff?.resolveRepo ?? null };
}

export function GitTab({ cwd }: { cwd?: string } = {}): React.ReactElement {
  const t = useT();
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  // Reactively subscribe active pane cwd — re-fetch when focus moves to different repo pane
  // in same workspace via load dep (Codex P2). When rendered as center surface,
  // prop cwd (captured surface.cwd at creation) takes priority as repo base — prevents
  // reading empty cwd from active pane and wrong repo. Fallback to selectActivePaneCwdCandidates
  // only when prop omitted (deck sub compatibility).
  const activePaneCwdCandidates = useStore(selectActivePaneCwdCandidates);
  // When prop cwd (captured at center surface creation) present try only that — no active pane fallback
  // (prevents wrong repo from empty active pane cwd — GitTab.cwdProp test).
  const activeCwdCandidates = cwd != null ? cwd : activePaneCwdCandidates;
  const pushToast = useStore((s) => s.pushToast);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  // Main worktree path — "main" badge·Remove hide basis. Distinct from current worktree
  // (dot basis): differ when opened from linked worktree (dogfood measured).
  const [mainPath, setMainPath] = useState<string>('');
  const [currentWorktree, setCurrentWorktree] = useState<string>('');
  const [worktrees, setWorktrees] = useState<WorktreeRowUI[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState('');
  const [busy, setBusy] = useState(false);
  // Active merge session (isolated integration worktree). null = no session. main is source of truth so
  // rehydrate via mergeStatus each load (includes post-restart recovery), poll transient stages.
  const [session, setSession] = useState<MergeSessionStatus | null>(null);
  // Monotonic load token — prevent late stale response from older repo(pane cwd) switch
  // overwriting newer result (ReviewTab:97 pattern). Only latest load() commits.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    const { worktree, resolveRepo } = getBridges();
    if (!worktree || !resolveRepo) {
      if (seq !== loadSeq.current) return;
      setError('bridge unavailable');
      setLoading(false);
      return;
    }
    // Try candidates in order, adopt first git-resolve success (agent pane shell cwd
    // outside repo still caught by metadata.cwd fallback — 2026-07-21).
    let resolved: { ok: true; repoPath: string } | { ok: false } = { ok: false };
    for (const candidate of activeCwdCandidates.split('\0').filter(Boolean)) {
      resolved = await resolveRepo(candidate);
      if (seq !== loadSeq.current) return; // superseded by a newer load
      if (resolved.ok) break;
    }
    if (!resolved.ok) {
      setRepoPath(null);
      setWorktrees([]);
      setLoading(false);
      return;
    }
    setCurrentWorktree(resolved.repoPath);
    const res = await worktree.list(resolved.repoPath);
    if (seq !== loadSeq.current) return; // superseded by a newer load
    if (!res.ok) {
      setError(res.error);
      setRepoPath(null);
      setWorktrees([]);
    } else {
      setRepoPath(res.repoPath);
      setMainPath(res.mainPath);
      setWorktrees(res.worktrees);
    }
    setLoading(false);
    // Merge session rehydration — main is source of truth (disk MERGE_HEAD derived) so after app restart
    // recover in-progress session and offer Land/Discard. Older preload may lack mergeStatus.
    if (res.ok && worktree.mergeStatus) {
      const ms = await worktree.mergeStatus(res.repoPath);
      if (seq !== loadSeq.current) return; // superseded by a newer load
      if (ms.ok) setSession(ms.status);
    }
  }, [activeCwdCandidates]);

  // Re-fetch on tab mount + active workspace/pane cwd change (pull-only).
  // load depends on activeCwd so pane focus switch also re-fetches here.
  useEffect(() => {
    void load();
  }, [load, activeWorkspaceId]);

  const handleCreate = useCallback(async () => {
    const branch = newBranch.trim();
    if (!branch || !repoPath || busy) return;
    const { worktree } = getBridges();
    if (!worktree) return;
    setBusy(true);
    // try/finally: release busy even when IPC rejects instead of {ok:false} (Codex P2).
    try {
      const res = await worktree.add(repoPath, branch);
      if (!res.ok) {
        pushToast({ level: 'warn', message: `${t('git.createFailed')}: ${res.error}` });
        return;
      }
      setNewBranch('');
      void load();
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
          // dirty worktree etc — surface git rejection reason as-is (no --force).
          pushToast({ level: 'warn', message: `${t('git.removeFailed')}: ${res.error}` });
          return;
        }
        void load();
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
  }, []);

  // Open diff surface — worktree path already toplevel so no resolveRepo,
  // same as palette "Show Git Diff" (existing tab switch dedup when same repoPath).
  // Mount tab on active workspace active leaf pane.
  const handleDiff = useCallback((targetPath: string) => {
    const st = useStore.getState();
    const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId);
    if (!ws) return;
    const findLeaf = (pane: Pane): PaneLeaf | null => {
      if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
      for (const child of pane.children) {
        const found = findLeaf(child);
        if (found) return found;
      }
      return null;
    };
    const leaf = findLeaf(ws.rootPane);
    if (!leaf) return;
    st.addWorkspaceDiffSurface(leaf.id, targetPath, `diff: ${pathLeaf(targetPath)}`);
  }, []);

  // Start merge — isolated merge with this worktree (source) as base. Only one session allowed.
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

  // Land — fast-forward base to result only when verify passes. On success session ends + re-fetch.
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
      void load();
    } catch (e) {
      pushToast({ level: 'warn', message: `${t('git.landFailed') || 'Land failed'}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [repoPath, busy, pushToast, t, load]);

  // Discard — merge --abort + remove integration worktree. base unchanged.
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
      void load();
    } catch (e) {
      pushToast({ level: 'warn', message: `${t('git.discardFailed') || 'Discard failed'}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [repoPath, busy, pushToast, t, load]);

  // Manual entry on conflict — open integration worktree as new workspace (startupCwd)
  // for user to resolve with Claude (B-MVP: no auto-resolve, reuse handleOpen pattern).
  const openIntegration = useCallback(() => {
    if (!session) return;
    const st = useStore.getState();
    // #515: attach the profile atomically with creation (see handleOpen).
    st.addWorkspace(`merge: ${session.sourceBranch ?? pathLeaf(session.integrationPath)}`, { startupCwd: session.integrationPath });
  }, [session]);

  // Poll status only during transient stages (merging/verifying) — stop at terminal stage.
  const sessionPhase = session?.phase;
  useEffect(() => {
    if (sessionPhase !== 'merging' && sessionPhase !== 'verifying') return;
    const { worktree } = getBridges();
    const mergeStatus = worktree?.mergeStatus;
    if (!mergeStatus || !repoPath) return;
    let cancelled = false;
    const id = setInterval(async () => {
      const res = await mergeStatus(repoPath);
      if (cancelled) return;
      if (res.ok) setSession(res.status);
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionPhase, repoPath]);

  const norm = (p: string) => p.replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
  const isMain = (wt: WorktreeEntry) => mainPath !== '' && norm(wt.path) === norm(mainPath);
  const isCurrent = (wt: WorktreeEntry) => currentWorktree !== '' && norm(wt.path) === norm(currentWorktree);
  // Hide our-owned integration worktree from display list (implementation detail, replaced by session panel).
  const visibleWorktrees = worktrees.filter((w) => !w.integration);

  return (
    <div data-git-tab className="flex flex-col flex-1 min-h-0 text-[12px]">
      {/* Pull Requests section — gh based (not installed/non-GitHub degraded to notice). */}
      <PrSection repoPath={repoPath} />
      {/* Worktrees section header — 36px chrome row. */}
      <div
        className="flex items-center gap-2 h-9 px-3 shrink-0 border-b border-[var(--bg-surface)]"
        style={{ borderColor: 'var(--border-soft)' }}
        {...tokenAttrs('bgSurface', 'border')}
      >
        <span className="font-semibold text-[var(--text-main)]" {...tokenAttrs('textMain', 'text')}>
          {t('git.worktrees') || 'Worktrees'}
        </span>
        {repoPath && (
          <span
            className="font-mono text-[10.5px] text-[var(--text-muted)] truncate"
            title={repoPath}
            {...tokenAttrs('textMuted', 'text')}
          >
            {pathLeaf(repoPath)}
          </span>
        )}
        <div className="flex-1" />
        {/* Current repo (active pane worktree) diff — button entry for palette command. */}
        {repoPath && (
          <button
            type="button"
            onClick={() => handleDiff(currentWorktree || repoPath)}
            title={t('git.diffDesc') || 'Open the diff view for this repo'}
            data-git-diff-current
            className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] ${FOCUS_RING}`}
            {...tokenAttrs('textSub', 'text')}
          >
            {t('git.diff') || 'Diff'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void load()}
          title={t('git.refresh') || 'Refresh'}
          aria-label={t('git.refresh') || 'Refresh'}
          className={`flex items-center justify-center w-6 h-6 rounded text-[var(--text-muted)] hover:text-[var(--text-sub)] transition-colors ${FOCUS_RING}`}
          {...tokenAttrs('textMuted', 'text')}
        >
          {/* monochrome refresh glyph */}
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M12 7a5 5 0 11-1.5-3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M12 1v2.6H9.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="px-3 py-4 text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            {t('git.loading') || 'Loading…'}
          </div>
        )}
        {!loading && error && (
          <div className="px-3 py-4 text-[var(--text-muted)] break-all" {...tokenAttrs('textMuted', 'text')}>
            {error}
          </div>
        )}
        {!loading && !error && !repoPath && (
          <div className="px-3 py-4 text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            {t('git.noRepo') || 'Not a git repository — focus a pane inside a repo.'}
          </div>
        )}
        {!loading && !error && repoPath && (
          <ul data-git-worktree-list>
            {visibleWorktrees.map((wt) => (
              <li
                key={wt.path}
                className="group flex items-center gap-2 px-3 h-9 border-b border-[var(--bg-surface)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)]"
                style={{ borderColor: 'var(--border-soft)' }}
              >
                {/* Only current (worktree active pane belongs to) gets amber 1-point. */}
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isCurrent(wt) ? 'bg-[var(--accent)]' : 'bg-[var(--bg-overlay)]'
                  }`}
                  {...(isCurrent(wt) ? tokenAttrs('accent', 'bg') : {})}
                />
                <div className="flex flex-col min-w-0 flex-1 leading-tight">
                  <span className="text-[var(--text-main)] truncate" {...tokenAttrs('textMain', 'text')}>
                    {wt.branch ?? `(${t('git.detached') || 'detached'} ${wt.headOid.slice(0, 7)})`}
                  </span>
                  <span
                    className="font-mono text-[10px] text-[var(--text-muted)] truncate"
                    title={wt.path}
                    {...tokenAttrs('textMuted', 'text')}
                  >
                    {pathLeaf(wt.path)}
                    {wt.locked !== null && ` · ${t('git.locked') || 'locked'}`}
                    {wt.prunable !== null && ` · ${t('git.prunable') || 'prunable'}`}
                  </span>
                </div>
                {/* Open diff surface for this worktree (path=toplevel as-is). */}
                <button
                  type="button"
                  onClick={() => handleDiff(wt.path)}
                  className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] opacity-0 group-hover:opacity-100 transition-opacity ${FOCUS_RING}`}
                  title={t('git.diffDesc') || 'Open the diff view for this worktree'}
                  {...tokenAttrs('textMuted', 'text')}
                >
                  {t('git.diff') || 'Diff'}
                </button>
                <button
                  type="button"
                  onClick={() => handleOpen(wt)}
                  className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] opacity-0 group-hover:opacity-100 transition-opacity ${FOCUS_RING}`}
                  title={t('git.openDesc') || 'Open as a new workspace'}
                  {...tokenAttrs('textMuted', 'text')}
                >
                  {t('git.open') || 'Open'}
                </button>
                {/* Isolated merge with this worktree (source) as base — feature rows only, when one session max. */}
                {!isMain(wt) && wt.branch && (
                  <button
                    type="button"
                    onClick={() => void handleMerge(wt)}
                    disabled={busy || session !== null}
                    className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40 ${FOCUS_RING}`}
                    title={t('git.mergeDesc') || 'Merge this worktree into the base branch (isolated, verified)'}
                    {...tokenAttrs('textMuted', 'text')}
                  >
                    {t('git.merge') || 'Merge'}
                  </button>
                )}
                {isMain(wt) ? (
                  <span className="text-[10px] text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                    {t('git.main') || 'main'}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleRemove(wt)}
                    disabled={busy}
                    className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--accent-red,#f87171)] border border-[var(--bg-surface)] opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40 ${FOCUS_RING}`}
                    title={t('git.removeDesc') || 'Remove worktree (refused if dirty)'}
                    {...tokenAttrs('textMuted', 'text')}
                  >
                    {t('git.remove') || 'Remove'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Merge session panel — when active session only. plain-language summary + Land/Discard. */}
      {session && (
        <div
          data-git-merge-session
          className="shrink-0 flex flex-col gap-1.5 px-3 py-2 border-t text-[11px]"
          style={{ borderColor: 'var(--border-soft)' }}
          {...tokenAttrs('bgSurface', 'border')}
        >
          <div className="flex items-center gap-2">
            {/* Stage dot: alive=amber(merging/verifying) · ok=green · problem=red. */}
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
            <span className="text-[var(--text-main)] truncate" {...tokenAttrs('textMain', 'text')}>
              {(session.sourceBranch ?? pathLeaf(session.integrationPath))} → {session.baseBranch}
            </span>
            <div className="flex-1" />
            <span className="text-[var(--text-sub)] shrink-0" {...tokenAttrs('textSub', 'text')}>
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
          {/* Plain-language summary — changed file count + verify result (for diff-blind users). */}
          <div className="text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            {session.phase === 'conflicted'
              ? `${session.conflicts.length} conflicting file(s) — open with Claude to resolve`
              : session.phase === 'verifying'
                ? `${session.changedFiles} file(s) changed · verifying`
                : session.phase === 'verified'
                  ? session.changedFiles > 0
                    ? `${session.changedFiles} file(s) changed · verify passed`
                    : 'Nothing to merge (already up to date)'
                  : session.phase === 'failed'
                    ? `${session.changedFiles} file(s) changed · verify failed${session.verify?.failedStep ? ` (${session.verify.failedStep})` : ''}${session.verify?.timedOut ? ' · timed out' : ''}`
                    : `${session.changedFiles} file(s) changed`}
          </div>
          <div className="flex items-center gap-1.5">
            {session.phase === 'conflicted' && (
              <button
                type="button"
                onClick={openIntegration}
                className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] ${FOCUS_RING}`}
                title={t('git.mergeOpenConflictDesc') || 'Open the integration worktree as a workspace to resolve conflicts with Claude'}
                {...tokenAttrs('textSub', 'text')}
              >
                {t('git.mergeOpenConflict') || 'Conflict — open with Claude'}
              </button>
            )}
            {session.phase === 'verified' && (
              <button
                type="button"
                onClick={() => void handleLand()}
                disabled={busy}
                className={`px-2 py-0.5 rounded text-[10.5px] text-[var(--text-main)] border border-[var(--bg-surface)] disabled:opacity-40 ${FOCUS_RING}`}
                title={t('git.landDesc') || 'Commit the verified merge and fast-forward the base branch'}
                {...tokenAttrs('textMain', 'text')}
              >
                {t('git.land') || 'Land'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleDiscard()}
              disabled={busy}
              className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--accent-red)] border border-[var(--bg-surface)] disabled:opacity-40 ${FOCUS_RING}`}
              title={t('git.discardDesc') || 'Abort the merge and remove the integration worktree (base unchanged)'}
              {...tokenAttrs('textMuted', 'text')}
            >
              {t('git.discard') || 'Discard'}
            </button>
          </div>
        </div>
      )}

      {/* New worktree — single branch name input (main derived by convention). */}
      {repoPath && (
        <div
          className="flex items-center gap-1.5 h-9 px-2 shrink-0 border-t border-[var(--bg-surface)]"
          style={{ borderColor: 'var(--border-soft)' }}
          {...tokenAttrs('bgSurface', 'border')}
        >
          <input
            type="text"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder={t('git.newBranchPlaceholder') || 'new branch name…'}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent font-mono text-[11px] text-[var(--text-main)] placeholder-[var(--text-muted)] outline-none px-1"
            {...tokenAttrs('textMain', 'text')}
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={busy || !newBranch.trim()}
            className={`px-2 py-0.5 rounded text-[10.5px] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] disabled:opacity-40 ${FOCUS_RING}`}
            {...tokenAttrs('textSub', 'text')}
          >
            {t('git.create') || 'Create'}
          </button>
        </div>
      )}
    </div>
  );
}

export default GitTab;
