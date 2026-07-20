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

// worktree list 행 — main이 붙여 내려주는 재시작-복구용 MERGING 파생 필드(선택).
type WorktreeRowUI = WorktreeEntry & { merging?: boolean; integration?: boolean; conflicts?: number };

type MergeStart = { ok: true; status: MergeSessionStatus } | { ok: false; error: string };
type MergeStatus = { ok: true; status: MergeSessionStatus | null } | { ok: false; error: string };
type MergeAction = { ok: true } | { ok: false; error: string };

// 활성 워크스페이스의 활성 pane → repo-base cwd 후보 목록(우선순위 순).
// 셀렉터로도 재사용(store 상태에서 원시 문자열로 수렴 — 리렌더 최소화).
//
// 왜 목록인가(2026-07-21 실측): 에이전트 TUI pane은 surface.cwd(셸의 cwd)가
// repo 밖일 수 있다 — 셸은 홈에 앉아 있고 에이전트만 repo에서 작업하는 경우
// (관측: surface.cwd=C:\Users\me, metadata.cwd=D:\wmux). metadata.cwd는 hook이
// 보고한 에이전트 cwd로 사이드바 브랜치가 이미 신뢰하는 값이므로 두 번째
// 후보로 넣는다. load()가 순서대로 resolveRepo를 시도해 첫 성공을 채택한다.
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
  // 오염된 cwd(스크래핑 오탐으로 저장된 불가능한 모양)는 건너뛰고 폴백 사용.
  // platform은 호스트 OS 기준(ReviewTab.normRepo와 동일 소스) — 렌더러의
  // process.platform 기본값은 CI POSIX 러너에서 Windows 경로를 오거부한다.
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
  // 머지 세션(격리 integration 워크트리). 구 preload에는 없을 수 있어 optional.
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
  // 활성 pane cwd를 reactive 구독 — 같은 워크스페이스에서 다른 repo pane으로
  // 포커스가 옮겨가도 재조회되도록 load의 dep으로 쓴다(Codex P2). 단 중앙 surface로
  // 렌더될 땐 prop cwd(생성 시 캡처된 surface.cwd)가 repo base로 우선한다 — 자기
  // 빈 cwd를 활성 pane에서 읽어 repo가 틀어지는 문제를 막는다. prop 미제공(덱 하위
  // 호환) 시에만 selectActivePaneCwdCandidates 폴백.
  const activePaneCwdCandidates = useStore(selectActivePaneCwdCandidates);
  // prop cwd(중앙 surface 생성 시 캡처)가 있으면 그것만 시도 — 활성 pane 폴백 금지
  // (자기 빈 cwd를 활성 pane에서 읽어 repo가 틀어지는 문제, GitTab.cwdProp 테스트).
  const activeCwdCandidates = cwd != null ? cwd : activePaneCwdCandidates;
  const pushToast = useStore((s) => s.pushToast);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  // 본(main) 워크트리 경로 — "main" 배지·Remove 숨김 기준. 현재 워크트리
  // (dot 기준)와 별개다: linked worktree에서 열면 둘이 다르다(dogfood 실측).
  const [mainPath, setMainPath] = useState<string>('');
  const [currentWorktree, setCurrentWorktree] = useState<string>('');
  const [worktrees, setWorktrees] = useState<WorktreeRowUI[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState('');
  const [busy, setBusy] = useState(false);
  // 활성 머지 세션(격리 integration 워크트리). null = 세션 없음. 정본은 main이라
  // load마다 mergeStatus로 재수화(재시작 후 복구 포함), transient 단계는 폴링.
  const [session, setSession] = useState<MergeSessionStatus | null>(null);
  // Monotonic load token — 빠른 repo(pane cwd) 전환 시 늦게 도착한 이전 응답이
  // 새 결과를 덮지 않게 한다(ReviewTab:97 패턴 복제). 최신 load()만 commit.
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
    // 후보를 순서대로 시도해 첫 git-resolve 성공을 채택한다(에이전트 pane의
    // 셸 cwd가 repo 밖이어도 metadata.cwd 폴백이 잡는다 — 2026-07-21).
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
    // 머지 세션 재수화 — main이 정본(디스크 MERGE_HEAD 파생)이라 앱 재시작 후에도
    // 진행 중 세션을 복구해 Land/Discard를 제시한다. 구 preload면 mergeStatus 부재.
    if (res.ok && worktree.mergeStatus) {
      const ms = await worktree.mergeStatus(res.repoPath);
      if (seq !== loadSeq.current) return; // superseded by a newer load
      if (ms.ok) setSession(ms.status);
    }
  }, [activeCwdCandidates]);

  // 탭 마운트 시 + 활성 워크스페이스/pane cwd 변경 시 재조회(pull-only).
  // load가 activeCwd에 의존하므로 pane 포커스 전환도 여기서 재조회된다.
  useEffect(() => {
    void load();
  }, [load, activeWorkspaceId]);

  const handleCreate = useCallback(async () => {
    const branch = newBranch.trim();
    if (!branch || !repoPath || busy) return;
    const { worktree } = getBridges();
    if (!worktree) return;
    setBusy(true);
    // try/finally: IPC가 {ok:false} 대신 reject해도 busy가 풀리도록(Codex P2).
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
          // dirty 워크트리 등 — git의 거부 사유를 그대로 표면화(--force 미제공).
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
    st.addWorkspace(wt.branch ?? pathLeaf(wt.path));
    // addWorkspace가 새 ws를 활성화하므로 activeWorkspaceId = 새 ws. 새 pane의
    // 터미널은 profile.startupCwd에서 스폰된다(스폰 시 tolerant 폴백 내장).
    const fresh = useStore.getState();
    fresh.setWorkspaceProfile(fresh.activeWorkspaceId, { startupCwd: wt.path });
  }, []);

  // diff 서피스 열기 — 워크트리 path는 이미 toplevel이라 resolveRepo 불요,
  // 팔레트 "Show Git Diff"와 동일 결과(같은 repoPath면 기존 탭 전환 dedup 포함).
  // 활성 워크스페이스의 활성 leaf pane에 탭을 얹는다.
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

  // 머지 시작 — 이 워크트리(source)를 base로 격리 머지. 세션 1개만 허용.
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

  // Land — verify 통과 시에만 base를 결과로 fast-forward. 성공 시 세션 소멸 + 재조회.
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

  // Discard — merge --abort + integration 워크트리 제거. base는 무변경.
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

  // 충돌 시 수동 진입 — integration 워크트리를 새 워크스페이스로 열어(startupCwd)
  // 사용자가 Claude로 충돌을 해결하게 한다(B-MVP: 자동해결 아님, handleOpen 패턴 재사용).
  const openIntegration = useCallback(() => {
    if (!session) return;
    const st = useStore.getState();
    st.addWorkspace(`merge: ${session.sourceBranch ?? pathLeaf(session.integrationPath)}`);
    const fresh = useStore.getState();
    fresh.setWorkspaceProfile(fresh.activeWorkspaceId, { startupCwd: session.integrationPath });
  }, [session]);

  // transient 단계(merging/verifying) 동안만 상태 폴링 — 종결 단계로 가면 정지.
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
  // 표시 목록에서 우리 소유 integration 워크트리는 감춘다(구현 세부, 세션 패널로 대체).
  const visibleWorktrees = worktrees.filter((w) => !w.integration);

  return (
    <div data-git-tab className="flex flex-col flex-1 min-h-0 text-[12px]">
      {/* Pull Requests 섹션 — gh 기반(미설치/비GitHub은 안내문으로 강등). */}
      <PrSection repoPath={repoPath} />
      {/* 워크트리 섹션 헤더 — 36px 크롬 행. */}
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
        {/* 현재 repo(활성 pane의 워크트리) diff — 팔레트 커맨드의 버튼 진입점. */}
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

      {/* 본문 */}
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
                {/* 현재(활성 pane이 속한) 워크트리만 amber 1포인트. */}
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
                {/* 이 워크트리의 diff 서피스 열기(경로=toplevel 그대로). */}
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
                {/* 이 워크트리(source)를 base로 격리 머지 — feature 행에만, 세션 1개일 때만. */}
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

      {/* 머지 세션 패널 — 활성 세션일 때만. plain-language 요약 + Land/Discard. */}
      {session && (
        <div
          data-git-merge-session
          className="shrink-0 flex flex-col gap-1.5 px-3 py-2 border-t text-[11px]"
          style={{ borderColor: 'var(--border-soft)' }}
          {...tokenAttrs('bgSurface', 'border')}
        >
          <div className="flex items-center gap-2">
            {/* 단계 dot: alive=amber(merging/verifying) · ok=green · 문제=red. */}
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
          {/* plain-language 요약 — 변경 파일 수 + verify 결과(diff-blind 사용자용). */}
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

      {/* 새 워크트리 — 브랜치명 입력 한 줄(관례 위치는 main이 도출). */}
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
