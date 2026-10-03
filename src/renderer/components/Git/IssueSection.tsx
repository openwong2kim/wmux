// Git page: a GitHub repo's open issues (gh CLI, pull-only), the Issues side
// of the Pull requests | Issues switch.
//
// Same liveness as PrSection: a 30s poll only while the list is open on the
// Git page, the window is visible and this is the active repo (another repo's
// list is `lazy`: read once when opened, never polled); the page's refresh
// forces a read; every answer checks a generation that hiding the window or
// unmounting bumps, so a late answer lands nowhere.
//
// A row opens its detail inline: body and comments through the app's markdown
// subset, which renders React text nodes only (no HTML, inert links), so an
// issue body can carry no markup or script into the page. Each row drags as
// an issue ref (application/x-wmux-issue); nothing takes the drop yet.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { renderBrainMarkdown } from '../Deck/BrainMarkdown';
import Select from '../ui/Select';
import { Icon } from '../icons';
import { GhGateNotice, type GhGate } from './GhGateNotice';
import { relTime } from './PrSection';
import { ISSUE_DRAG_TYPE, issueRepoFromUrl, serializeIssueRef } from '../../../shared/issueRef';
import type {
  IssueDetail,
  IssueDetailResult,
  IssueFilter,
  IssueListResult,
  IssueRepo,
  IssueSummary,
} from '../../../shared/issueSurface';

const POLL_MS = 30_000;
/** Label chips drawn on a row; the rest is a +N. */
const ROW_LABELS = 3;

interface IssueBridge {
  issueList: (repoPath: string, filter: IssueFilter, force?: boolean) => Promise<IssueListResult>;
  issueDetail: (repoPath: string, number: number, updatedAt: string) => Promise<IssueDetailResult>;
}

function getIssueBridge(): IssueBridge | null {
  const api = (window as unknown as { electronAPI?: { github?: Partial<IssueBridge> } }).electronAPI;
  const gh = api?.github;
  return gh?.issueList && gh.issueDetail ? (gh as IssueBridge) : null;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; issues: IssueSummary[]; repo: IssueRepo | null }
  | { kind: 'gated'; gate: GhGate };

type FilterKind = IssueFilter['kind'];

/** HH:MM, local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function IssueSection({ repoPath, refreshKey = 0, open, poll = true, lazy = false, onCount }: {
  repoPath: string | null;
  refreshKey?: number;
  /** The switch's disclosure: the list shows (and may poll) only while open. */
  open: boolean;
  /** Whether the open list polls (only the active repo's does). */
  poll?: boolean;
  /** Read nothing until first opened, then on demand (another repo's list). */
  lazy?: boolean;
  onCount?: (count: number | null) => void;
}): React.ReactElement | null {
  const t = useT();
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  // The breaker's retry time; the last good list stays under the notice.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [filterKind, setFilterKind] = useState<FilterKind>('all');
  const [label, setLabel] = useState('');
  const [labelDraft, setLabelDraft] = useState('');
  const filter: IssueFilter | null =
    filterKind === 'label' ? (label ? { kind: 'label', label } : null) : { kind: filterKind };
  const filterKey = filter ? (filter.kind === 'label' ? `label:${filter.label}` : filter.kind) : '';

  const [expanded, setExpanded] = useState<number | null>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailId = useId();

  // Request generation: bumped on unmount and when the window hides.
  const gen = useRef(0);
  // The repo+filter being read: a poll waits for it, another filter does not.
  const inFlight = useRef<string | null>(null);
  // The repo and filter a response was asked for must still be the current
  // ones, or it would paint over another list.
  const current = useRef({ repoPath, filterKey });
  current.current = { repoPath, filterKey };
  const expandedUpdatedAt = useRef('');

  const fetchDetail = useCallback(async (repo: string, issue: IssueSummary) => {
    const bridge = getIssueBridge();
    if (!bridge) return;
    setDetailLoading(true);
    setDetailError(null);
    const g = gen.current;
    const res = await bridge.issueDetail(repo, issue.number, issue.updatedAt);
    if (g !== gen.current || current.current.repoPath !== repo) return;
    setDetailLoading(false);
    if (res.ok) {
      expandedUpdatedAt.current = issue.updatedAt;
      setDetail(res.detail);
    } else {
      setDetail(null);
      setDetailError(res.code === 'rate-limited'
        ? t('git.issues.rateLimited', { time: clockTime(res.retryAt) })
        : res.message || t('git.issues.detailFailed'));
    }
  }, [t]);

  const load = useCallback(async (force = false) => {
    const repo = repoPath;
    const f = filter;
    const key = filterKey;
    const req = `${repo}\0${key}`;
    if (!repo || !f || inFlight.current === req) return;
    const bridge = getIssueBridge();
    if (!bridge) return;
    inFlight.current = req;
    const g = gen.current;
    try {
      const res = await bridge.issueList(repo, f, force);
      if (g !== gen.current || current.current.repoPath !== repo || current.current.filterKey !== key) return;
      if (res.ok) {
        setRetryAt(null);
        setState({ kind: 'ready', issues: res.issues, repo: res.repo });
        if (expanded !== null) {
          const cur = res.issues.find((i) => i.number === expanded);
          if (cur && cur.updatedAt !== expandedUpdatedAt.current) void fetchDetail(repo, cur);
        }
      } else if (res.code === 'rate-limited') {
        setRetryAt(res.retryAt);
        // Keep the last good list; with none yet, the notice stands alone.
        setState((s) => (s.kind === 'ready' ? s : { kind: 'ready', issues: [], repo: null }));
      } else {
        setRetryAt(null);
        setState({ kind: 'gated', gate: { code: res.code, message: res.message, provider: res.provider } });
      }
    } finally {
      if (inFlight.current === req) inFlight.current = null;
    }
  }, [repoPath, filterKey, expanded, fetchDetail]);
  const loadRef = useRef(load);
  loadRef.current = load;

  // A new repo or filter starts over: one read for the count, unless lazy and
  // never opened.
  const everOpened = useRef(open);
  if (open) everOpened.current = true;
  useEffect(() => {
    setState({ kind: 'loading' });
    setRetryAt(null);
    setExpanded(null);
    setDetail(null);
    setDetailError(null);
    expandedUpdatedAt.current = '';
    if (!repoPath || (lazy && !everOpened.current)) return;
    void loadRef.current();
  }, [repoPath, filterKey]);
  useEffect(() => () => { gen.current++; }, []);

  // A lazy list reads once, the first time it is opened.
  const lazyRead = useRef(false);
  useEffect(() => {
    if (!lazy || !open || lazyRead.current || !repoPath) return;
    lazyRead.current = true;
    void loadRef.current();
  }, [lazy, open, repoPath]);

  // Poll only while someone can see the list.
  const onGitPage = useStore((s) => s.appRoute === 'git');
  const [windowShown, setWindowShown] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => {
      if (document.hidden) gen.current++;
      setWindowShown(!document.hidden);
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  const polling = poll && !!repoPath && open && onGitPage && windowShown;
  useEffect(() => {
    if (!polling) return;
    void loadRef.current();
    const id = window.setInterval(() => void loadRef.current(), POLL_MS);
    return () => window.clearInterval(id);
  }, [polling]);

  // The page's refresh: a forced read past main's TTL (never past its breaker).
  const seenRefresh = useRef(refreshKey);
  useEffect(() => {
    if (seenRefresh.current === refreshKey) return;
    seenRefresh.current = refreshKey;
    void loadRef.current(true);
  }, [refreshKey]);

  const count = state.kind === 'ready' && (retryAt === null || state.issues.length > 0) ? state.issues.length : null;
  const onCountRef = useRef(onCount);
  onCountRef.current = onCount;
  useEffect(() => { onCountRef.current?.(count); }, [count]);

  const toggle = useCallback((issue: IssueSummary) => {
    if (expanded === issue.number) {
      setExpanded(null);
      setDetail(null);
      setDetailError(null);
      return;
    }
    setExpanded(issue.number);
    setDetail(null);
    setDetailError(null);
    if (repoPath) void fetchDetail(repoPath, issue);
  }, [expanded, repoPath, fetchDetail]);

  if (!repoPath || !open) return null;

  const applyLabel = () => {
    const name = labelDraft.trim();
    if (name && name !== label) setLabel(name);
  };

  return (
    <div data-issue-section className="wmux-git-issues">
      {!(state.kind === 'gated') && (
        <div className="wmux-git-issue-filter">
          <Select
            value={filterKind}
            onChange={(e) => setFilterKind(e.target.value as FilterKind)}
            aria-label={t('git.issues.filter.label')}
            data-issue-filter
          >
            <option value="all">{t('git.issues.filter.all')}</option>
            <option value="assigned">{t('git.issues.filter.assigned')}</option>
            <option value="created">{t('git.issues.filter.created')}</option>
            <option value="label">{t('git.issues.filter.byLabel')}</option>
          </Select>
          {filterKind === 'label' && (
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

      {retryAt !== null && (
        <div className="wmux-git-note" role="status" data-issue-rate-limited>
          {t('git.issues.rateLimited', { time: clockTime(retryAt) })}
        </div>
      )}

      {state.kind === 'loading' && filter && (
        <div className="wmux-git-note" {...tokenAttrs('textMuted', 'text')}>{t('git.loading')}</div>
      )}

      {state.kind === 'gated' && (
        <GhGateNotice
          gate={state.gate}
          onRecheck={() => void load(true)}
          fallback={state.gate.code === 'unsupported-host'
            ? t('git.issues.githubOnly')
            : state.gate.code === 'no-remote'
              ? t('git.noRemote')
              : state.gate.message || t('git.issues.listFailed')}
        />
      )}

      {state.kind === 'ready' && retryAt === null && state.issues.length === 0 && (
        <div className="wmux-git-note" data-issue-empty>
          {filterKind === 'all' ? t('git.issues.none') : t('git.issues.noneFiltered')}
        </div>
      )}

      {state.kind === 'ready' && state.issues.length > 0 && (
        <ul className="wmux-git-issue-list" aria-label={t('git.issues.listLabel')} data-issue-list>
          {state.issues.map((issue) => {
            const isOpen = expanded === issue.number;
            const repo = issueRepoFromUrl(issue.url) ?? state.repo;
            return (
              <li key={issue.number} className="wmux-git-issue" data-issue-row={issue.number}>
                <button
                  type="button"
                  className={`wmux-git-issue-row ${FOCUS_RING}`}
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? `${detailId}-${issue.number}` : undefined}
                  onClick={() => toggle(issue)}
                  draggable={!!repo}
                  onDragStart={(e) => {
                    if (!repo) return;
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData(ISSUE_DRAG_TYPE, serializeIssueRef({
                      host: repo.host,
                      owner: repo.owner,
                      repo: repo.repo,
                      number: issue.number,
                      title: issue.title,
                      url: issue.url,
                    }));
                  }}
                >
                  <span className="wmux-git-issue-num">#{issue.number}</span>
                  <span className="wmux-git-issue-title" title={issue.title}>{issue.title}</span>
                  {issue.labels.slice(0, ROW_LABELS).map((l) => (
                    <span key={l.name} className="wmux-git-issue-label">{l.name}</span>
                  ))}
                  {issue.labels.length > ROW_LABELS && (
                    <span className="wmux-git-issue-label">+{issue.labels.length - ROW_LABELS}</span>
                  )}
                  <span className="wmux-git-issue-meta" title={issue.updatedAt}>
                    {issue.comments > 0 && (
                      <span className="wmux-git-issue-comments" aria-label={t('git.issues.comments', { count: issue.comments })}>
                        <Icon size={11}><path d="M2.5 3h9v6H6l-2.5 2.5V9h-1z" /></Icon>
                        {issue.comments}
                      </span>
                    )}
                    {relTime(issue.updatedAt, t)}
                  </span>
                </button>
                {isOpen && (
                  <div id={`${detailId}-${issue.number}`} className="wmux-git-issue-detail" data-issue-detail>
                    <IssueDetailView
                      issue={issue}
                      detail={detail}
                      loading={detailLoading}
                      error={detailError}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function IssueDetailView({ issue, detail, loading, error }: {
  issue: IssueSummary;
  detail: IssueDetail | null;
  loading: boolean;
  error: string | null;
}): React.ReactElement {
  const t = useT();
  const openOnGithub = (
    <button
      type="button"
      className={`wmux-git-button ${FOCUS_RING}`}
      onClick={() => window.open(issue.url, '_blank')}
      data-issue-open-github
    >
      {t('git.issues.openOnGithub')}
    </button>
  );
  if (loading) return <><div className="wmux-git-note">{t('git.loading')}</div><div className="wmux-git-issue-actions">{openOnGithub}</div></>;
  if (error || !detail) {
    return (
      <>
        {error && <div className="wmux-git-note break-words" role="status">{t('git.issues.detailFailed')}: {error}</div>}
        <div className="wmux-git-issue-actions">{openOnGithub}</div>
      </>
    );
  }
  return (
    <>
      <div className="wmux-git-issue-byline">
        {t('git.issues.opened', { author: detail.author, age: relTime(detail.createdAt, t) })}
        {detail.assignees.length > 0 && ` · ${t('git.issues.assignees', { names: detail.assignees.map((a) => `@${a}`).join(', ') })}`}
      </div>
      {detail.labels.length > 0 && (
        <div className="wmux-git-issue-labels">
          {detail.labels.map((l) => <span key={l.name} className="wmux-git-issue-label">{l.name}</span>)}
        </div>
      )}
      <div className="wmux-git-issue-body" data-issue-body>
        {detail.body ? renderBrainMarkdown(detail.body) : <span className="text-[var(--text-muted)]">{t('git.issues.noBody')}</span>}
        {detail.bodyTruncated && <div className="wmux-git-note">{t('git.viewFull')}</div>}
      </div>
      {/* Timeline-lite: the comments in order, then the close if there was one. */}
      {detail.comments.length > 0 && (
        <ol className="wmux-git-issue-timeline" aria-label={t('git.issues.comments', { count: detail.comments.length })}>
          {detail.comments.map((c, i) => (
            <li key={i} className="wmux-git-issue-comment">
              <div className="wmux-git-issue-byline">
                <span className="font-medium">@{c.author}</span>
                {c.createdAt && ` · ${relTime(c.createdAt, t)}`}
              </div>
              <div className="wmux-git-issue-body">{renderBrainMarkdown(c.body)}</div>
              {c.truncated && <div className="wmux-git-note">{t('git.viewFull')}</div>}
            </li>
          ))}
        </ol>
      )}
      {detail.state === 'closed' && (
        <div className="wmux-git-issue-byline">{t('git.issues.closedAgo', { age: relTime(detail.closedAt, t) })}</div>
      )}
      <div className="wmux-git-issue-actions">{openOnGithub}</div>
    </>
  );
}
