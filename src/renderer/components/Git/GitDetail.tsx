// The Git page's detail pane: the PR or issue selected in the list beside it.
// A sticky header (title, number, repo, state, actions) over the body, which
// scrolls on its own. Bodies and comments go through the app's text-only
// markdown with real http(s) links (opened by the window's external-link
// handler) and read-only task checkboxes; no HTML from GitHub reaches the DOM.
//
// Each body is mounted per selected item (keyed by the page), so an answer for
// a previous selection is dropped with its component; within one item, only
// the newest read lands.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { renderBrainMarkdown } from '../Deck/BrainMarkdown';
import { ListFreshness } from './ListFreshness';
import { PrStepText, getGithubBridge } from './PrSection';
import { getIssueBridge } from './IssueSection';
import { relTime } from './useGitList';
import type { PrSummary, PrComment } from '../../../shared/prSurface';
import type { IssueDetail, IssueSummary } from '../../../shared/issueSurface';

const md = (s: string) => renderBrainMarkdown(s, { links: true });

/** A review state in words; an unknown one as GitHub spells it, lowercased. */
function reviewWord(state: string, t: (k: string) => string): string {
  const key = `git.pr.review.${state}`;
  const word = t(key);
  return word === key ? state.toLowerCase().replaceAll('_', ' ') : word;
}

/** Reads `load` once per `dep`, keeping only the newest answer; null while it reads. */
function useDetail<T>(load: () => Promise<{ ok: true; value: T } | { ok: false; message: string }>, dep: string) {
  const [state, setState] = useState<{ value: T | null; error: string | null; loading: boolean }>({ value: null, error: null, loading: true });
  const req = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const mine = ++req.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    void loadRef.current().then((res) => {
      if (mine !== req.current) return;
      setState(res.ok ? { value: res.value, error: null, loading: false } : { value: null, error: res.message, loading: false });
    });
    return () => { req.current++; };
  }, [dep]);
  return state;
}

function DetailHeader({ title, number, repo, url, state, author }: {
  title: string;
  number: number;
  repo: string;
  url: string;
  state: React.ReactNode;
  author: string;
}): React.ReactElement {
  const t = useT();
  return (
    <header className="wmux-git-detail-head" data-git-detail-head>
      <div className="wmux-git-detail-titlerow">
        <h2 className="wmux-git-detail-title">{title}</h2>
        <div className="wmux-git-detail-actions">
          {/* Reserved for "who acts next" (the shared work-link model); empty until then. */}
          <div className="wmux-git-detail-slot" data-git-detail-slot />
          <button
            type="button"
            className={`wmux-git-button ${FOCUS_RING}`}
            onClick={() => window.open(url, '_blank')}
            data-git-open-github
          >
            {t('git.issues.openOnGithub')}
          </button>
        </div>
      </div>
      <div className="wmux-git-detail-meta">
        <span className="wmux-git-item-num">#{number}</span>
        <span>{repo}</span>
        {state}
        {author && <span>@{author}</span>}
      </div>
    </header>
  );
}

function PrBody({ repoPath, pr }: { repoPath: string; pr: PrSummary }): React.ReactElement {
  const t = useT();
  const detail = useDetail<PrComment[]>(async () => {
    const bridge = getGithubBridge();
    if (!bridge) return { ok: false, message: t('git.bridgeUnavailable') };
    const res = await bridge.prDetail(repoPath, pr.number, pr.updatedAt);
    return res.ok ? { ok: true, value: res.detail.comments } : { ok: false, message: res.message };
  }, pr.updatedAt);
  return (
    <div className="wmux-git-detail-body" data-pr-detail>
      <div className="wmux-git-detail-facts">
        {pr.headRefName && <span className="wmux-git-branch-chip" title={pr.headRefName}>{pr.headRefName}</span>}
        {pr.reviewDecision && <span>{reviewWord(pr.reviewDecision, t)}</span>}
        {pr.checks && <span>{t(`workspace.prChecks.${pr.checks}`)}</span>}
      </div>
      {detail.loading && <div className="wmux-git-note">{t('git.loading')}</div>}
      {!detail.loading && detail.error && <div className="wmux-git-note break-words" role="status">{t('git.commentsFailed')}: {detail.error}</div>}
      {!detail.loading && detail.value?.length === 0 && <div className="wmux-git-note">{t('git.noComments')}</div>}
      {detail.value && detail.value.length > 0 && (
        <ol className="wmux-git-issue-timeline" aria-label={t('git.issues.comments', { count: detail.value.length })}>
          {detail.value.map((c, i) => (
            <li key={i} className="wmux-git-issue-comment">
              <div className="wmux-git-issue-byline">
                <span className="font-medium">@{c.author}</span>
                {c.kind === 'review' && c.reviewState && ` · ${reviewWord(c.reviewState, t)}`}
                {c.createdAt && ` · ${relTime(c.createdAt, t)}`}
              </div>
              {c.body && <div className="wmux-git-issue-body">{md(c.body)}</div>}
              {c.truncated && (
                <button type="button" className={`wmux-git-link-btn ${FOCUS_RING}`} onClick={() => window.open(c.url, '_blank')}>
                  {t('git.viewFull')}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function IssueBody({ repoPath, issue }: { repoPath: string; issue: IssueSummary }): React.ReactElement {
  const t = useT();
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const detail = useDetail<IssueDetail>(async () => {
    const bridge = getIssueBridge();
    if (!bridge) return { ok: false, message: t('git.bridgeUnavailable') };
    const res = await bridge.issueDetail(repoPath, issue.number, issue.updatedAt);
    setRetryAt(!res.ok && res.code === 'rate-limited' ? res.retryAt : null);
    return res.ok ? { ok: true, value: res.detail } : { ok: false, message: res.message };
  }, issue.updatedAt);
  // Never draw another issue's detail under this one.
  const d = detail.value && detail.value.number === issue.number ? detail.value : null;
  return (
    <div className="wmux-git-detail-body" data-issue-detail>
      {detail.loading && <div className="wmux-git-note">{t('git.loading')}</div>}
      {!detail.loading && retryAt !== null && (
        <ListFreshness fetchedAt={null} error={null} retryAt={retryAt} onRetry={() => undefined} />
      )}
      {!detail.loading && retryAt === null && detail.error && (
        <div className="wmux-git-note break-words" role="status">{t('git.issues.detailFailed')}: {detail.error}</div>
      )}
      {d && (
        <>
          {(d.assignees.length > 0 || d.labels.length > 0) && (
            <div className="wmux-git-detail-facts">
              {d.labels.map((l) => <span key={l.name} className="wmux-git-issue-label">{l.name}</span>)}
              {d.assignees.length > 0 && <span>{t('git.issues.assignees', { names: d.assignees.map((a) => `@${a}`).join(', ') })}</span>}
            </div>
          )}
          <div className="wmux-git-issue-byline">{t('git.issues.opened', { author: d.author, age: relTime(d.createdAt, t) })}</div>
          <div className="wmux-git-issue-body" data-issue-body>
            {d.body ? md(d.body) : <span className="text-[var(--text-muted)]">{t('git.issues.noBody')}</span>}
            {d.bodyTruncated && (
              <button type="button" className={`wmux-git-link-btn ${FOCUS_RING}`} onClick={() => window.open(d.url, '_blank')}>
                {t('git.viewFull')}
              </button>
            )}
          </div>
          {/* Timeline-lite: the comments in order, then the close if there was one. */}
          {d.comments.length > 0 && (
            <ol className="wmux-git-issue-timeline" aria-label={t('git.issues.comments', { count: d.comments.length })}>
              {d.comments.map((c, i) => (
                <li key={i} className="wmux-git-issue-comment">
                  <div className="wmux-git-issue-byline">
                    <span className="font-medium">@{c.author}</span>
                    {c.createdAt && ` · ${relTime(c.createdAt, t)}`}
                  </div>
                  <div className="wmux-git-issue-body">{md(c.body)}</div>
                  {c.truncated && <div className="wmux-git-note">{t('git.viewFull')}</div>}
                </li>
              ))}
            </ol>
          )}
          {d.state === 'closed' && <div className="wmux-git-issue-byline">{t('git.issues.closedAgo', { age: relTime(d.closedAt, t) })}</div>}
        </>
      )}
    </div>
  );
}

export function GitDetail({ kind, repoPath, repoLabel, pr, issue }: {
  kind: 'pr' | 'issue';
  repoPath: string;
  repoLabel: string;
  pr?: PrSummary | null;
  issue?: IssueSummary | null;
}): React.ReactElement {
  const t = useT();
  if (kind === 'pr' && pr) {
    return (
      <article className="wmux-git-detail" aria-label={pr.title} data-git-detail="pr">
        <DetailHeader title={pr.title} number={pr.number} repo={repoLabel} url={pr.url} author={pr.author} state={<PrStepText pr={pr} />} />
        <PrBody key={`${repoPath}\0${pr.number}`} repoPath={repoPath} pr={pr} />
      </article>
    );
  }
  if (kind === 'issue' && issue) {
    return (
      <article className="wmux-git-detail" aria-label={issue.title} data-git-detail="issue">
        <DetailHeader
          title={issue.title}
          number={issue.number}
          repo={repoLabel}
          url={issue.url}
          author={issue.author}
          state={<span className="wmux-git-step">{t(`git.issues.state.${issue.state}`)}</span>}
        />
        <IssueBody key={`${repoPath}\0${issue.number}`} repoPath={repoPath} issue={issue} />
      </article>
    );
  }
  return <div className="wmux-git-detail-empty" data-git-detail-empty>{t('git.detail.empty')}</div>;
}
