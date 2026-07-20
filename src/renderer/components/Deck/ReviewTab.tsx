// ─── Deck Review tab — diff-first review of THIS repo's workspaces ───────────
//
// Conductor-style review surface (owner decision 2026-07-18). Scope 교정
// (owner 2026-07-20): 전체 워크스페이스가 아니라 **현재 컨텍스트 repo와 같은
// repo**(그 repo의 워크트리 위에 있는) 워크스페이스만 보여준다 — Git 탭 상단의
// 워크트리·머지 워크플로우와 스코프를 일치시켜 "지금 이 repo" 맥락을 지킨다.
// 같은 repo 판정 = 활성 pane cwd로 해결한 repo의 `worktree.list`가 주는 워크트리
// 경로 집합에 그 워크스페이스의 resolved 토플레벨이 들어있는가(추가 git 호출 1번).
// One row per in-scope workspace: name, branch, PR badge, uncommitted diff stat
// (files / +adds / −dels) — one-click entry into the EXISTING DiffPanel surface.
// 이 탭은 집계·라우팅만; hunk 단위 review/adopt는 DiffPanel(J2)에 남는다.
//
// Pull-only, like GitTab: stats load on mount / tab focus / manual refresh —
// no polling, no daemon involvement. Each row resolves its repo from the
// workspace's active pane cwd (falling back to profile.startupCwd), the same
// rule the palette's Show Git Diff uses, then reads `diff:read` in 'workspace'
// mode and sums the numstat.
//
// Design contract (DESIGN.md): monochrome glyphs, mono paths/counts, and at
// most ONE amber point — the dot marking the ACTIVE workspace's row.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { Pane, PaneLeaf, PrStatus } from '../../../shared/types';
import { isPlausibleCwd } from '../../../shared/cwdShape';
import type { DiffReadResult, DiffReadError } from '../../../shared/diffParse';

// A workspace's review row — resolved repo + summed numstat, or the reason
// there is nothing to review (no repo / clean / read error).
interface ReviewRow {
  workspaceId: string;
  name: string;
  branch: string;
  pr: PrStatus | null;
  repoPath: string | null;
  files: number;
  additions: number;
  deletions: number;
  error: string | null;
}

function findActiveLeaf(root: Pane, activePaneId: string): PaneLeaf | null {
  if (root.type === 'leaf') return root.id === activePaneId ? root : null;
  for (const child of root.children) {
    const found = findActiveLeaf(child, activePaneId);
    if (found) return found;
  }
  return null;
}

/** First leaf fallback — a diff surface needs SOME leaf to mount on when the
 *  workspace's activePaneId is stale (e.g. points at a just-closed pane). */
function findFirstLeaf(root: Pane): PaneLeaf | null {
  if (root.type === 'leaf') return root;
  for (const child of root.children) {
    const found = findFirstLeaf(child);
    if (found) return found;
  }
  return null;
}

function pathLeaf(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

// 워크스페이스의 repo-base cwd 후보(우선순위 순) — GitTab과 동일 규칙(2026-07-21).
// 에이전트 TUI pane은 surface.cwd(셸 cwd)가 repo 밖일 수 있어(셸=홈, 에이전트=repo)
// hook이 보고한 metadata.cwd를 두 번째 후보로 넣고, 호출부가 순서대로
// resolveRepo를 시도해 첫 성공을 채택한다.
function repoCwdCandidates(
  ws: { rootPane: Pane; activePaneId: string; metadata?: { cwd?: string }; profile?: { startupCwd?: string } },
  startupDirectory: string,
): string[] {
  const leaf = findActiveLeaf(ws.rootPane, ws.activePaneId) ?? findFirstLeaf(ws.rootPane);
  const surface = leaf?.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  // platform은 호스트 OS 기준(normRepo와 동일 소스) — 렌더러의 process.platform
  // 기본값은 CI POSIX 러너에서 Windows 경로를 오거부한다.
  const plat = (window as unknown as { electronAPI?: { platform?: string } }).electronAPI?.platform;
  const surfaceCwd = surface?.cwd && isPlausibleCwd(surface.cwd, plat ?? undefined) ? surface.cwd : '';
  const candidates = [
    surfaceCwd,
    ws.metadata?.cwd ?? '',
    ws.profile?.startupCwd ?? '',
    startupDirectory,
  ].filter(Boolean);
  return [...new Set(candidates)];
}

/** 후보를 순서대로 resolveRepo에 넣어 첫 성공을 반환(없으면 null). */
async function resolveFirstRepo(
  bridge: DiffBridge,
  candidates: string[],
): Promise<string | null> {
  for (const cwd of candidates) {
    const r = await bridge.resolveRepo(cwd);
    if (r.ok) return r.repoPath;
  }
  return null;
}

interface DiffBridge {
  resolveRepo: (cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }>;
  read: (
    worktreePath: string,
    targetHeadOid: string,
    mode: 'task' | 'workspace',
  ) => Promise<DiffReadResult | DiffReadError>;
}

function getDiffBridge(): DiffBridge | null {
  const api = (window as unknown as { electronAPI?: { diff?: DiffBridge } }).electronAPI;
  return api?.diff ?? null;
}

type WorktreeListFn = (
  repoPath: string,
) => Promise<{ ok: true; worktrees: { path: string }[] } | { ok: false }>;

function getWorktreeList(): WorktreeListFn | null {
  const api = (window as unknown as { electronAPI?: { worktree?: { list?: WorktreeListFn } } })
    .electronAPI;
  return api?.worktree?.list ?? null;
}

/** repo 경로 정규화 — 대소문자 정책은 파일시스템에 맞춘다(win/mac 무시). */
function normRepo(p: string): string {
  const s = p.replace(/[/\\]+$/, '');
  const plat = (window as unknown as { electronAPI?: { platform?: string } }).electronAPI?.platform;
  return plat === 'win32' || plat === 'darwin' ? s.toLowerCase() : s;
}

/** PR badge colors — same grammar as the sidebar's PrBadge (WorkspaceItem). */
function prColor(pr: PrStatus): string {
  return pr.state === 'open' ? 'var(--accent-green)'
    : pr.state === 'merged' ? 'var(--accent-blue)'
    : pr.state === 'closed' ? 'var(--accent-red)'
    : 'var(--text-muted)';
}

export function ReviewTab(): React.ReactElement {
  const t = useT();
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  // Row identity only — name/metadata are re-read inside load() so a rename
  // or branch switch shows up on the next refresh without a live subscription.
  const workspaceIds = useStore((s) => s.workspaces.map((w) => w.id).join('\0'));
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Monotonic load token — a slower earlier refresh must not overwrite a newer
  // roster (CodeRabbit, PR #496). Only the latest load() commits.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const bridge = getDiffBridge();
    const wtList = getWorktreeList();
    const state = useStore.getState();

    // 현재 컨텍스트 repo의 워크트리 경로 집합 = Review 스코프. 활성 워크스페이스의
    // 활성 pane cwd로 repo를 해결한 뒤 그 repo의 worktree.list를 읽는다(추가 git 1번).
    // 해결 실패(현재 repo 없음)면 scope=null → 폴백으로 전체 표시(기존 동작).
    let scope: Set<string> | null = null;
    const active = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
    if (bridge && wtList && active) {
      const candidates = repoCwdCandidates(active, state.startupDirectory || '');
      if (candidates.length > 0) {
        try {
          const repoPath = await resolveFirstRepo(bridge, candidates);
          if (repoPath !== null) {
            const wl = await wtList(repoPath);
            if (wl.ok) scope = new Set(wl.worktrees.map((w) => normRepo(w.path)));
          }
        } catch {
          // 스코프 해결 실패 → null 유지(전체 폴백).
        }
      }
    }

    const out: ReviewRow[] = [];
    for (const ws of state.workspaces) {
      const candidates = repoCwdCandidates(ws, state.startupDirectory || '');
      const row: ReviewRow = {
        workspaceId: ws.id,
        name: ws.name,
        branch: ws.metadata?.gitBranch ?? '',
        pr: ws.metadata?.pr ?? null,
        repoPath: null,
        files: 0,
        additions: 0,
        deletions: 0,
        error: null,
      };
      if (bridge && candidates.length > 0) {
        try {
          const repoPath = await resolveFirstRepo(bridge, candidates);
          if (repoPath !== null) {
            row.repoPath = repoPath;
            const diff = await bridge.read(repoPath, '', 'workspace');
            if (diff.ok) {
              row.files = diff.numstat.length;
              for (const n of diff.numstat) {
                row.additions += n.additions ?? 0;
                row.deletions += n.deletions ?? 0;
              }
              if (!row.branch) row.branch = diff.snapshot.targetBranch;
            } else {
              row.error = diff.error;
            }
          }
        } catch (e) {
          row.error = e instanceof Error ? e.message : String(e);
        }
      }
      // 스코프가 있으면 같은 repo(그 repo의 워크트리 위)만 통과. 스코프 null이면
      // 전체(현재 repo를 못 잡은 폴백). repo 미해결 행은 스코프 있을 때 제외.
      if (scope) {
        if (row.repoPath && scope.has(normRepo(row.repoPath))) out.push(row);
      } else {
        out.push(row);
      }
    }
    if (seq !== loadSeq.current) return; // superseded by a newer load
    setRows(out);
    setLoading(false);
  }, []);

  // 활성 워크스페이스가 바뀌면 스코프(현재 repo)도 바뀌므로 재조회한다.
  useEffect(() => {
    void load();
  }, [load, workspaceIds, activeWorkspaceId]);

  // Jump into the review: activate the workspace and open the existing
  // DiffPanel surface on its active leaf (same dedup as the palette command —
  // an existing diff tab for the same repo is re-focused, not duplicated).
  const openDiff = useCallback((row: ReviewRow) => {
    if (!row.repoPath) return;
    const st = useStore.getState();
    st.setActiveWorkspace(row.workspaceId);
    const fresh = useStore.getState();
    const ws = fresh.workspaces.find((w) => w.id === row.workspaceId);
    if (!ws) return;
    const leaf = findActiveLeaf(ws.rootPane, ws.activePaneId) ?? findFirstLeaf(ws.rootPane);
    if (!leaf) return;
    fresh.addWorkspaceDiffSurface(leaf.id, row.repoPath, `diff: ${pathLeaf(row.repoPath)}`);
  }, []);

  const goTo = useCallback((workspaceId: string) => {
    useStore.getState().setActiveWorkspace(workspaceId);
  }, []);

  const dirty = rows.filter((r) => r.files > 0);
  const clean = rows.filter((r) => r.files === 0);

  const renderRow = (row: ReviewRow) => {
    const isActive = row.workspaceId === activeWorkspaceId;
    return (
      <li
        key={row.workspaceId}
        className="group flex items-center gap-2 px-3 h-10 border-b border-[var(--bg-surface)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)]"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        {/* ONE amber point per screen: the active workspace's dot. */}
        <span
          aria-hidden="true"
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isActive ? 'bg-[var(--accent)]' : 'bg-[var(--bg-overlay)]'
          }`}
          {...(isActive ? tokenAttrs('accent', 'bg') : {})}
        />
        <div className="flex flex-col min-w-0 flex-1 leading-tight">
          <span className="text-[var(--text-main)] truncate" {...tokenAttrs('textMain', 'text')}>
            {row.name}
          </span>
          <span
            className="font-mono text-[10px] text-[var(--text-muted)] truncate"
            {...tokenAttrs('textMuted', 'text')}
          >
            {/* Branch renders only WITH a resolved repo — stale workspace
                metadata must not mask the missing-repo state (CodeRabbit). */}
            {row.repoPath ? (row.branch ? `⎇ ${row.branch}` : pathLeaf(row.repoPath)) : t('review.noRepo') || 'no repo'}
            {row.pr && (
              <span style={{ color: prColor(row.pr) }}> #{row.pr.number}</span>
            )}
          </span>
        </div>
        {/* Diff stat — mono, monochrome; error degrades to a title tooltip.
            No repo → no stat cell at all (dogfood: "clean" on a no-repo row
            read as a false verdict). */}
        {!row.repoPath ? null : row.error ? (
          <span
            className="font-mono text-[10px] text-[var(--text-muted)]"
            title={row.error}
            {...tokenAttrs('textMuted', 'text')}
          >
            —
          </span>
        ) : row.files > 0 ? (
          <span className="font-mono text-[10.5px] text-[var(--text-sub)] shrink-0" {...tokenAttrs('textSub', 'text')}>
            {row.files}{' '}
            <span className="text-[var(--text-muted)]">{t('review.files') || 'files'}</span>
            {' '}+{row.additions}{' '}−{row.deletions}
          </span>
        ) : (
          <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0" {...tokenAttrs('textMuted', 'text')}>
            {t('review.clean') || 'clean'}
          </span>
        )}
        {row.repoPath && (
          <button
            type="button"
            onClick={() => openDiff(row)}
            className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity ${FOCUS_RING}`}
            title={t('review.openDiffDesc') || 'Open this workspace and review its diff'}
            {...tokenAttrs('textMuted', 'text')}
          >
            {t('review.diff') || 'Diff'}
          </button>
        )}
        {!isActive && (
          <button
            type="button"
            onClick={() => goTo(row.workspaceId)}
            className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity ${FOCUS_RING}`}
            title={t('review.goDesc') || 'Switch to this workspace'}
            {...tokenAttrs('textMuted', 'text')}
          >
            {t('review.go') || 'Go'}
          </button>
        )}
      </li>
    );
  };

  return (
    <div data-review-tab className="flex flex-col flex-1 min-h-0 text-[12px]">
      {/* Header — 36px chrome row, mirrors GitTab's. */}
      <div
        className="flex items-center gap-2 h-9 px-3 shrink-0 border-b border-[var(--bg-surface)]"
        style={{ borderColor: 'var(--border-soft)' }}
        {...tokenAttrs('bgSurface', 'border')}
      >
        <span className="font-semibold text-[var(--text-main)]" {...tokenAttrs('textMain', 'text')}>
          {t('review.title') || 'Review'}
        </span>
        {!loading && (
          <span className="font-mono text-[10.5px] text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            {dirty.length}/{rows.length} {t('review.dirtySuffix') || 'with changes'}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void load()}
          title={t('review.refresh') || 'Refresh'}
          aria-label={t('review.refresh') || 'Refresh'}
          className={`flex items-center justify-center w-6 h-6 rounded text-[var(--text-muted)] hover:text-[var(--text-sub)] transition-colors ${FOCUS_RING}`}
          {...tokenAttrs('textMuted', 'text')}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M12 7a5 5 0 11-1.5-3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M12 1v2.6H9.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="px-3 py-4 text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            {t('review.loading') || 'Reading diffs…'}
          </div>
        )}
        {!loading && rows.length === 0 && (
          <div className="px-3 py-4 text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            {t('review.empty') || 'No workspaces.'}
          </div>
        )}
        {!loading && (
          <ul data-review-list>
            {/* Dirty first — the rows you came here to review. */}
            {dirty.map(renderRow)}
            {clean.map(renderRow)}
          </ul>
        )}
      </div>
    </div>
  );
}

export default ReviewTab;
