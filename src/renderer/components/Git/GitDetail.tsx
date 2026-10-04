// The Git page's detail pane: the PR or issue selected in the list beside it.
// A sticky header (title, number, repo, state, actions) over the body, which
// scrolls on its own. Bodies and comments go through the app's text-only
// markdown with real http(s) links (opened by the window's external-link
// handler), read-only task checkboxes and GitHub's HTML reduced to text
// (<details> as a disclosure, comments and scripts dropped); no HTML from
// GitHub reaches the DOM.
//
// Each body is mounted per selected item (keyed by the page), so an answer for
// a previous selection is dropped with its component; within one item, only
// the newest read lands.
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { renderBrainMarkdown } from '../Deck/BrainMarkdown';
import { ListFreshness } from './ListFreshness';
import { DetailError, useDetail } from './useDetail';
import { PrChecks, usePrChecks } from './PrChecks';
import { PrReviewActions } from './PrReviewActions';
import { PrFiles } from './PrFiles';
import { WhoActsNext } from './WhoActsNext';
import { PrStepText, getGithubBridge } from './PrSection';
import { getIssueBridge } from './IssueSection';
import { relTime } from './useGitList';
import type { PrSummary, PrComment } from '../../../shared/prSurface';
import type { IssueDetail, IssueSummary } from '../../../shared/issueSurface';
import { useStore } from '../../stores';
import { parseIssueRef, issueUrlParts, serializeIssueRef } from '../../../shared/issueRef';
import { parsePrDragRef, prUrlParts, serializePrDragRef } from '../../../shared/prDragRef';
import type { HandoffRef } from '../../../shared/gitHandoff';
import type { GitDragOwner } from './gitPageState';

/** The selected item as a hand-off ref (URL-checked), or null when its URL is not GitHub's shape. */
function handoffRefOf(kind: 'pr' | 'issue', item: { number: number; title: string; url: string }): HandoffRef | null {
  if (kind === 'issue') {
    const p = issueUrlParts(item.url);
    const ref = p ? parseIssueRef(serializeIssueRef({ ...p, title: item.title, url: item.url })) : null;
    return ref ? { kind: 'issue', ref } : null;
  }
  const p = prUrlParts(item.url);
  const ref = p ? parsePrDragRef(serializePrDragRef({ ...p, title: item.title, url: item.url })) : null;
  return ref ? { kind: 'pr', ref } : null;
}

const md = (s: string) => renderBrainMarkdown(s, { links: true, githubHtml: true });

/** A review state in words; an unknown one as GitHub spells it, lowercased. */
function reviewWord(state: string, t: (k: string) => string): string {
  const key = `git.pr.review.${state}`;
  const word = t(key);
  return word === key ? state.toLowerCase().replaceAll('_', ' ') : word;
}

function DetailHeader({ title, number, repo, url, state, author, handoff, repoContext, next }: {
  title: string;
  number: number;
  repo: string;
  url: string;
  state: React.ReactNode;
  author: string;
  /** The item to hand to an agent (the keyboard / a11y twin of dragging it). */
  handoff: HandoffRef | null;
  repoContext?: GitDragOwner;
  /** Who acts next on the item (its work link), drawn in the reserved slot. */
  next?: React.ReactNode;
}): React.ReactElement {
  const t = useT();
  const open = () => {
    if (handoff) useStore.getState().setGitHandoff({ item: handoff, ...(repoContext ? { repo: repoContext } : {}) });
  };
  return (
    <header className="wmux-git-detail-head" data-git-detail-head>
      <div className="wmux-git-detail-titlerow">
        <h2 className="wmux-git-detail-title">{title}</h2>
        <div className="wmux-git-detail-actions">
          {/* Who acts next (the shared work-link model); empty when no work is linked. */}
          <div className="wmux-git-detail-slot" data-git-detail-slot>{next}</div>
          {handoff && (
            <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={open} data-git-send-agent>
              {t('git.detail.sendToAgent')}
            </button>
          )}
          {handoff?.kind === 'issue' && repoContext?.workspaceId && (
            <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={open} data-git-start-worktree>
              {t('git.detail.startWorktree')}
            </button>
          )}
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

function PrBody({ repoPath, pr, refreshKey }: { repoPath: string; pr: PrSummary; refreshKey: number }): React.ReactElement {
  const t = useT();
  const detail = useDetail<PrComment[]>(async () => {
    const bridge = getGithubBridge();
    if (!bridge) return { ok: false, message: t('git.bridgeUnavailable') };
    const res = await bridge.prDetail(repoPath, pr.number, pr.updatedAt);
    return res.ok ? { ok: true, value: res.detail.comments } : { ok: false, message: res.message };
  }, `${pr.updatedAt}\0${refreshKey}`);
  const checks = usePrChecks(repoPath, pr, refreshKey);
  return (
    <div className="wmux-git-detail-body" data-pr-detail>
      <div className="wmux-git-detail-facts">
        {pr.headRefName && <span className="wmux-git-branch-chip" title={pr.headRefName}>{pr.headRefName}</span>}
        {pr.reviewDecision && <span>{reviewWord(pr.reviewDecision, t)}</span>}
        {pr.checks && <span>{t(`workspace.prChecks.${pr.checks}`)}</span>}
      </div>
      <PrChecks repoPath={repoPath} read={checks} />
      {checks.data && (
        <>
          <PrReviewActions repoPath={repoPath} number={pr.number} head={checks.data.head} checks={checks.data.checks} onMoved={() => checks.reload(true)} />
          <PrFiles repoPath={repoPath} number={pr.number} head={checks.data.head.headRefOid} refreshKey={refreshKey} onMoved={() => checks.reload(true)} />
        </>
      )}
      {detail.loading && <div className="wmux-git-note">{t('git.loading')}</div>}
      {!detail.loading && detail.error && <DetailError label={t('git.commentsFailed')} error={detail.error} retry={detail.retry} />}
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

function IssueBody({ repoPath, issue, refreshKey }: { repoPath: string; issue: IssueSummary; refreshKey: number }): React.ReactElement {
  const t = useT();
  const detail = useDetail<IssueDetail>(async () => {
    const bridge = getIssueBridge();
    if (!bridge) return { ok: false, message: t('git.bridgeUnavailable') };
    const res = await bridge.issueDetail(repoPath, issue.number, issue.updatedAt);
    if (res.ok) return { ok: true, value: res.detail };
    return { ok: false, message: res.message, ...(res.code === 'rate-limited' ? { retryAt: res.retryAt } : {}) };
  }, `${issue.updatedAt}\0${refreshKey}`);
  const retryAt = detail.retryAt;
  // Never draw another issue's detail under this one.
  const d = detail.value && detail.value.number === issue.number ? detail.value : null;
  return (
    <div className="wmux-git-detail-body" data-issue-detail>
      {detail.loading && <div className="wmux-git-note">{t('git.loading')}</div>}
      {!detail.loading && retryAt !== null && (
        <ListFreshness fetchedAt={null} error={null} retryAt={retryAt} onRetry={() => undefined} />
      )}
      {!detail.loading && retryAt === null && detail.error && (
        <DetailError label={t('git.issues.detailFailed')} error={detail.error} retry={detail.retry} />
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

export function GitDetail({ kind, repoPath, repoLabel, pr, issue, refreshKey = 0, repo }: {
  kind: 'pr' | 'issue';
  /** The page's refresh: the detail reads again too. */
  refreshKey?: number;
  /** The repo and workspace the item belongs to (for "Start in a new worktree"). */
  repo?: GitDragOwner;
  repoPath: string;
  repoLabel: string;
  pr?: PrSummary | null;
  issue?: IssueSummary | null;
}): React.ReactElement {
  const t = useT();
  if (kind === 'pr' && pr) {
    return (
      <article className="wmux-git-detail" aria-label={pr.title} data-git-detail="pr">
        <DetailHeader
          title={pr.title}
          number={pr.number}
          repo={repoLabel}
          url={pr.url}
          author={pr.author}
          state={<PrStepText pr={pr} />}
          handoff={handoffRefOf('pr', pr)}
          repoContext={repo}
          next={<WhoActsNext url={pr.url} />}
        />
        <PrBody key={`${repoPath}\0${pr.number}`} repoPath={repoPath} pr={pr} refreshKey={refreshKey} />
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
          handoff={handoffRefOf('issue', issue)}
          repoContext={repo}
        />
        <IssueBody key={`${repoPath}\0${issue.number}`} repoPath={repoPath} issue={issue} refreshKey={refreshKey} />
      </article>
    );
  }
  return <div className="wmux-git-detail-empty" data-git-detail-empty>{t('git.detail.empty')}</div>;
}
