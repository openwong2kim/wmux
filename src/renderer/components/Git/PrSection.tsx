// Git page: a repo's open pull requests (gh CLI, pull-only), the list half
// of the Pull requests view. A row selects the PR; the detail pane beside the
// list shows it. Reading, polling and freshness are useGitList's.
//
// fail-closed: gh missing / signed out / another host is a notice, never a
// silently empty list.
import { useCallback, useEffect } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { GhGateNotice } from './GhGateNotice';
import { ListFreshness } from './ListFreshness';
import { relTime, useGitList, type ListAnswer } from './useGitList';
import { PR_STEP_IS_PROBLEM, prNextStep } from '../../../shared/prNextStep';
import { PR_DRAG_TYPE, prUrlParts, serializePrDragRef } from '../../../shared/prDragRef';
import { useStore } from '../../stores';
import type { GitDragContext } from './gitPageState';
import type { PrSummary, PrComment } from '../../../shared/prSurface';

export { relTime };

export interface GithubBridge {
  prList: (repoPath: string, force?: boolean) => Promise<
    { ok: true; prs: PrSummary[] } | { ok: false; code: string; message: string; provider?: 'github' | 'gitlab' }
  >;
  prDetail: (repoPath: string, number: number, updatedAt: string) => Promise<
    { ok: true; detail: { number: number; comments: PrComment[] } } | { ok: false; code: string; message: string }
  >;
}

export function getGithubBridge(): GithubBridge | null {
  const api = (window as unknown as { electronAPI?: { github?: GithubBridge } }).electronAPI;
  return api?.github ?? null;
}

function checksClass(checks: PrSummary['checks']): string {
  // Diff-content rule: status colour is its own green/red (never the theme accent).
  if (checks === 'passing') return 'text-[var(--accent-green)]';
  if (checks === 'failing') return 'text-[var(--accent-red)]';
  if (checks === 'pending') return 'text-[var(--text-muted)]';
  return 'text-transparent';
}

/** A PR's next step in words, drawn red only when something is broken. */
export function PrStepText({ pr }: { pr: Pick<PrSummary, 'state' | 'checks' | 'mergeable' | 'reviewDecision'> }): React.ReactElement {
  const t = useT();
  const step = prNextStep(pr);
  return (
    <span className="wmux-git-step" data-pr-step={step} data-problem={PR_STEP_IS_PROBLEM.has(step) ? 'true' : undefined}>
      {t(`git.pr.step.${step}`)}
    </span>
  );
}

export function PrSection({ repoPath, refreshKey = 0, shown = true, poll = true, lazy = false, selected = null, onSelect, onItems, dragContext }: {
  repoPath: string | null;
  refreshKey?: number;
  /** The list is on screen. */
  shown?: boolean;
  /** Whether it polls (only the active repo's does). */
  poll?: boolean;
  /** Read nothing until first shown (another repo's list). */
  lazy?: boolean;
  /** The selected PR number in this list. */
  selected?: number | null;
  onSelect?: (pr: PrSummary) => void;
  /** Every good answer, so the page can keep the selected PR's summary fresh. */
  onItems?: (prs: PrSummary[]) => void;
  /** The repo a dragged row comes from (for the drop's "Start in a new worktree"). */
  dragContext?: GitDragContext;
}): React.ReactElement | null {
  const t = useT();
  const read = useCallback(async (force: boolean): Promise<ListAnswer<PrSummary[]>> => {
    const bridge = getGithubBridge();
    if (!bridge || !repoPath) return { ok: false, kind: 'error', message: t('git.bridgeUnavailable') };
    const res = await bridge.prList(repoPath, force);
    if (res.ok) return { ok: true, data: res.prs };
    if (res.code === 'error') return { ok: false, kind: 'error', message: res.message };
    return { ok: false, kind: 'gate', gate: { code: res.code, message: res.message, provider: res.provider } };
  }, [repoPath, t]);
  const list = useGitList({ listKey: repoPath, read, shown, poll, lazy, refreshKey });

  useEffect(() => {
    if (list.data) onItems?.(list.data);
    // onItems is the page's setter; a new data array is the signal.
  }, [list.data]);

  if (!repoPath) return null;
  const prs = list.data;

  return (
    <div data-pr-section className="wmux-git-listblock">
      {!list.gate && (
        <ListFreshness fetchedAt={list.fetchedAt} error={list.error} retryAt={list.retryAt} onRetry={() => list.reload(true)} />
      )}
      {list.loading && !list.gate && <div className="wmux-git-note">{t('git.loading')}</div>}
      {list.gate && (
        <GhGateNotice
          gate={list.gate}
          onRecheck={() => list.reload(true)}
          fallback={list.gate.code === 'no-remote'
            ? t('git.noRemote')
            : list.gate.message || (list.gate.code === 'cli-missing' ? t('git.ghMissing') : t('git.ghUnauth'))}
        />
      )}
      {prs && prs.length === 0 && !list.gate && <div className="wmux-git-note" data-pr-empty>{t('git.noPrs')}</div>}
      {prs && prs.length > 0 && (
        <ul className="wmux-git-list" aria-label={t('git.pullRequests')} data-pr-list>
          {prs.map((pr) => (
            <li key={pr.number} data-pr-row={pr.number}>
              <button
                type="button"
                className={`wmux-git-item ${FOCUS_RING}`}
                aria-current={selected === pr.number ? 'true' : undefined}
                onClick={() => onSelect?.(pr)}
                // Drags as a PR ref (application/x-wmux-pr) onto an agent pane or workspace.
                draggable={!!prUrlParts(pr.url)}
                onDragStart={(e) => {
                  const parts = prUrlParts(pr.url);
                  if (!parts) return;
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData(PR_DRAG_TYPE, serializePrDragRef({ ...parts, title: pr.title, url: pr.url }));
                  useStore.getState().setGitDragContext(dragContext ?? null);
                }}
                onDragEnd={() => useStore.getState().setGitDragContext(null)}
              >
                <span className="wmux-git-item-line">
                  <span className={`wmux-git-item-dot ${checksClass(pr.checks)}`} title={pr.checks ?? ''} aria-hidden="true">●</span>
                  <span className="wmux-git-item-num">#{pr.number}</span>
                  <span className="wmux-git-item-title" title={pr.title}>{pr.title}</span>
                </span>
                <span className="wmux-git-item-meta">
                  <PrStepText pr={pr} />
                  {pr.author && <span>@{pr.author}</span>}
                  <span title={pr.updatedAt}>{relTime(pr.updatedAt, t)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default PrSection;
