// Git page: a GitHub repo's open issues (gh CLI, pull-only), the list half of
// the Issues view. The filter lives in the UI store (it survives leaving the
// page); a row selects the issue for the detail pane and drags as an issue
// ref (application/x-wmux-issue). Reading, polling and freshness are
// useGitList's.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import Select from '../ui/Select';
import { Icon } from '../icons';
import { GhGateNotice } from './GhGateNotice';
import { ListFreshness } from './ListFreshness';
import { relTime, useGitList, type ListAnswer } from './useGitList';
import { ISSUE_DRAG_TYPE, issueRepoFromUrl, serializeIssueRef } from '../../../shared/issueRef';
import type { IssueDetailResult, IssueFilter, IssueListResult, IssueSummary } from '../../../shared/issueSurface';
import { useStore } from '../../stores';
import type { GitDragOwner } from './gitPageState';
import { beginHandoffDrag } from './handoffDrag';

/** Label chips drawn on a row; the rest is a +N. */
const ROW_LABELS = 3;

export interface IssueBridge {
  issueList: (repoPath: string, filter: IssueFilter, force?: boolean) => Promise<IssueListResult>;
  issueDetail: (repoPath: string, number: number, updatedAt: string) => Promise<IssueDetailResult>;
}

export function getIssueBridge(): IssueBridge | null {
  const api = (window as unknown as { electronAPI?: { github?: Partial<IssueBridge> } }).electronAPI;
  const gh = api?.github;
  return gh?.issueList && gh.issueDetail ? (gh as IssueBridge) : null;
}

export const filterKeyOf = (f: IssueFilter) => (f.kind === 'label' ? `label:${f.label}` : f.kind);

export function IssueSection({
  repoPath, filter, onFilter, refreshKey = 0, shown = true, poll = true, lazy = false, selected = null, onSelect, onItems, dragContext,
}: {
  repoPath: string | null;
  filter: IssueFilter;
  onFilter?: (filter: IssueFilter) => void;
  refreshKey?: number;
  shown?: boolean;
  poll?: boolean;
  lazy?: boolean;
  selected?: number | null;
  onSelect?: (issue: IssueSummary) => void;
  onItems?: (issues: IssueSummary[]) => void;
  /** The repo a dragged row comes from (for the drop's "Start in a new worktree"). */
  dragContext?: GitDragOwner;
}): React.ReactElement | null {
  const t = useT();
  const fkey = filterKeyOf(filter);
  const read = useCallback(async (force: boolean): Promise<ListAnswer<IssueSummary[]>> => {
    const bridge = getIssueBridge();
    if (!bridge || !repoPath) return { ok: false, kind: 'error', message: t('git.bridgeUnavailable') };
    const res = await bridge.issueList(repoPath, filter, force);
    if (res.ok) return { ok: true, data: res.issues };
    if (res.code === 'rate-limited') return { ok: false, kind: 'rate', retryAt: res.retryAt };
    if (res.code === 'error') return { ok: false, kind: 'error', message: res.message };
    return { ok: false, kind: 'gate', gate: { code: res.code, message: res.message, provider: res.provider } };
    // filter is identified by fkey.
  }, [repoPath, fkey, t]);
  const list = useGitList({ listKey: repoPath ? `${repoPath}\0${fkey}` : null, read, shown, poll, lazy, refreshKey });

  useEffect(() => {
    if (list.data) onItems?.(list.data);
  }, [list.data]);

  // The label field edits a draft; Enter or leaving the field applies it.
  const [labelDraft, setLabelDraft] = useState(filter.kind === 'label' ? filter.label : '');
  const [labelMode, setLabelMode] = useState(filter.kind === 'label');
  const applyLabel = () => {
    const name = labelDraft.trim();
    if (name && !(filter.kind === 'label' && filter.label === name)) onFilter?.({ kind: 'label', label: name });
  };

  if (!repoPath) return null;
  const issues = list.data;
  const filtered = filter.kind !== 'all';

  return (
    <div data-issue-section className="wmux-git-listblock">
      {!list.gate && (
        <div className="wmux-git-issue-filter">
          <Select
            value={labelMode ? 'label' : filter.kind}
            onChange={(e) => {
              const kind = e.target.value as IssueFilter['kind'];
              if (kind === 'label') {
                setLabelMode(true);
                if (labelDraft.trim()) onFilter?.({ kind: 'label', label: labelDraft.trim() });
              } else {
                setLabelMode(false);
                onFilter?.({ kind });
              }
            }}
            aria-label={t('git.issues.filter.label')}
            data-issue-filter
          >
            <option value="all">{t('git.issues.filter.all')}</option>
            <option value="assigned">{t('git.issues.filter.assigned')}</option>
            <option value="created">{t('git.issues.filter.created')}</option>
            <option value="label">{t('git.issues.filter.byLabel')}</option>
          </Select>
          {labelMode && (
            <input
              type="text"
              className={`wmux-git-issue-label-input ${FOCUS_RING}`}
              value={labelDraft}
              placeholder={t('git.issues.labelPlaceholder')}
              aria-label={t('git.issues.labelName')}
              maxLength={100}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyLabel(); }}
              onBlur={applyLabel}
              data-issue-label-input
            />
          )}
        </div>
      )}
      {!list.gate && (
        <ListFreshness fetchedAt={list.fetchedAt} error={list.error} retryAt={list.retryAt} onRetry={() => list.reload(true)} />
      )}
      {list.loading && !list.gate && <div className="wmux-git-note">{t('git.loading')}</div>}
      {list.gate && (
        <GhGateNotice
          gate={list.gate}
          onRecheck={() => list.reload(true)}
          fallback={list.gate.code === 'unsupported-host'
            ? t('git.issues.githubOnly')
            : list.gate.code === 'no-remote'
              ? t('git.noRemote')
              : list.gate.message || t('git.issues.listFailed')}
        />
      )}
      {issues && issues.length === 0 && !list.gate && (
        <div className="wmux-git-note" data-issue-empty>{filtered ? t('git.issues.noneFiltered') : t('git.issues.none')}</div>
      )}
      {issues && issues.length > 0 && (
        <ul className="wmux-git-list" aria-label={t('git.issues.listLabel')} data-issue-list>
          {issues.map((issue) => {
            // The drag ref is the URL's own host/owner/repo, which a drop target re-checks.
            const repo = issueRepoFromUrl(issue.url);
            return (
              <li key={issue.number} data-issue-row={issue.number}>
                <button
                  type="button"
                  className={`wmux-git-item ${FOCUS_RING}`}
                  aria-current={selected === issue.number ? 'true' : undefined}
                  onClick={() => onSelect?.(issue)}
                  draggable={!!repo}
                  onDragStart={(e) => {
                    if (!repo) return;
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData(ISSUE_DRAG_TYPE, serializeIssueRef({
                      host: repo.host, owner: repo.owner, repo: repo.repo, number: issue.number, title: issue.title, url: issue.url,
                    }));
                    beginHandoffDrag({ repoPath, ...(dragContext?.workspaceId ? { workspaceId: dragContext.workspaceId } : {}), owner: repo.owner, repo: repo.repo });
                  }}
                >
                  <span className="wmux-git-item-line">
                    <span className="wmux-git-item-num">#{issue.number}</span>
                    <span className="wmux-git-item-title" title={issue.title}>{issue.title}</span>
                  </span>
                  <span className="wmux-git-item-meta">
                    {issue.labels.slice(0, ROW_LABELS).map((l) => (
                      <span key={l.name} className="wmux-git-issue-label">{l.name}</span>
                    ))}
                    {issue.labels.length > ROW_LABELS && <span className="wmux-git-issue-label">+{issue.labels.length - ROW_LABELS}</span>}
                    {issue.comments > 0 && (
                      <span className="wmux-git-issue-comments" aria-label={t('git.issues.comments', { count: issue.comments })}>
                        <Icon size={11}><path d="M2.5 3h9v6H6l-2.5 2.5V9h-1z" /></Icon>
                        {issue.comments}
                      </span>
                    )}
                    <span title={issue.updatedAt}>{relTime(issue.updatedAt, t)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
