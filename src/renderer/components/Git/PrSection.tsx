// Sidebar Git section — Pull Requests row (gh CLI 기반, 성긴 pull).
//
// A folded row ("Pull requests · N") under the current-branch card; opening it
// lists the PRs, and each PR expands to its comments. The Git section's header
// refresh reaches it through `refreshKey`.
//
// How live it is: a 30s poll only while the PR row is open and on screen,
// plus the manual refresh, plus an immediate comment fetch when a PR opens.
// main's cache (GhPrService) has a 30s TTL and skips re-fetching comments
// while updatedAt is unchanged, which bounds the rate limit.
//
// fail-closed: gh 미설치/미인증/비GitHub remote는 안내문으로 강등 — 섹션이
// 조용히 비는 일은 없다. 모든 행·코멘트는 "브라우저에서 열기" 1클릭 제공.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { renderBrainMarkdown } from '../Deck/BrainMarkdown';
import { IconChevron } from '../icons';
import type { PrSummary, PrComment } from '../../../shared/prSurface';

const POLL_MS = 30_000;

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; prs: PrSummary[] }
  | { kind: 'gated'; code: string; message: string };

interface GithubBridge {
  prList: (repoPath: string, force?: boolean) => Promise<
    { ok: true; prs: PrSummary[] } | { ok: false; code: string; message: string }
  >;
  prDetail: (repoPath: string, number: number, updatedAt: string) => Promise<
    { ok: true; detail: { number: number; comments: PrComment[] } } | { ok: false; code: string; message: string }
  >;
}

function getGithubBridge(): GithubBridge | null {
  const api = (window as unknown as { electronAPI?: { github?: GithubBridge } }).electronAPI;
  return api?.github ?? null;
}

// 상태 glyph — monochrome(색은 checks dot 하나만, 그것도 중립 팔레트).
function stateLabel(pr: PrSummary): string {
  if (pr.state === 'merged') return '⇥';
  if (pr.state === 'closed') return '✕';
  if (pr.state === 'draft') return '◌';
  return '●';
}

function checksClass(checks: PrSummary['checks']): string {
  // diff 콘텐츠와 동일 규칙: 상태색은 자체 녹/적 팔레트(theme accent 금지).
  if (checks === 'passing') return 'text-[var(--accent-green)]';
  if (checks === 'failing') return 'text-[var(--accent-red)]';
  if (checks === 'pending') return 'text-[var(--text-muted)]';
  return 'text-transparent';
}

function relTime(iso: string, t: (k: string) => string): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t('git.justNow') || 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function PrSection({ repoPath, refreshKey = 0 }: { repoPath: string | null; refreshKey?: number }): React.ReactElement | null {
  const t = useT();
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  // Folded by default: the count is the glance, the list is one click away.
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [comments, setComments] = useState<PrComment[] | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  // 폴 재진입 가드 — 느린 gh 응답 중 인터벌 중첩 방지(DeckScheduler 관례).
  const inFlight = useRef(false);
  // 현재 repoPath를 ref로 미러 — in-flight 응답이 늦게 와도 repo가 바뀌었으면
  // 옛 repo의 결과로 새 repo 화면을 덮지 않는다(Codex P2).
  const repoRef = useRef(repoPath);
  repoRef.current = repoPath;
  // 펼친 PR의 마지막 상세 fetch에 쓴 updatedAt — 목록 폴에서 값이 바뀌면
  // 코멘트를 재조회한다(Codex P2).
  const expandedUpdatedAt = useRef<string>('');

  const fetchComments = useCallback(async (repo: string, pr: PrSummary) => {
    const bridge = getGithubBridge();
    if (!bridge) return;
    setCommentsLoading(true);
    setCommentsError(null);
    const res = await bridge.prDetail(repo, pr.number, pr.updatedAt);
    // repo/expanded가 그새 바뀌었으면 폐기(stale 응답).
    if (repoRef.current !== repo) return;
    setCommentsLoading(false);
    if (res.ok) {
      expandedUpdatedAt.current = pr.updatedAt;
      setComments(res.detail.comments);
    } else {
      // 실패를 빈 코멘트로 뭉개지 않는다 — 진짜 빈 토론과 구분(Codex P2).
      setComments(null);
      setCommentsError(res.message || 'failed to load comments');
    }
  }, []);

  const load = useCallback(async (force = false) => {
    const repo = repoPath;
    if (!repo || inFlight.current) return;
    const bridge = getGithubBridge();
    if (!bridge) return;
    inFlight.current = true;
    try {
      const res = await bridge.prList(repo, force);
      // repo가 그새 바뀌었으면 옛 결과로 새 화면을 덮지 않는다(Codex P2).
      if (repoRef.current !== repo) return;
      if (res.ok) {
        setState({ kind: 'ready', prs: res.prs });
        // 펼친 PR의 updatedAt이 바뀌었으면 그 코멘트를 재조회(Codex P2).
        if (expanded !== null) {
          const cur = res.prs.find((p) => p.number === expanded);
          if (cur && cur.updatedAt !== expandedUpdatedAt.current) void fetchComments(repo, cur);
        }
      } else {
        setState({ kind: 'gated', code: res.code, message: res.message });
      }
    } finally {
      inFlight.current = false;
    }
  }, [repoPath, expanded, fetchComments]);

  // One read on mount / repo change, for the count on the folded row.
  useEffect(() => {
    setState({ kind: 'loading' });
    setExpanded(null);
    setComments(null);
    setCommentsError(null);
    expandedUpdatedAt.current = '';
    if (!repoPath) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  // The 30s poll runs only while someone can see the list: the row is open,
  // the Workspaces page is the one shown (not inert behind Fleet or another
  // page), and the window is not hidden. Otherwise the mount read and the
  // header's refresh are all there is.
  const onWorkspaces = useStore((s) => s.appRoute === 'workspaces');
  const [windowShown, setWindowShown] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setWindowShown(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  const loadRef = useRef(load);
  loadRef.current = load;
  const polling = !!repoPath && open && onWorkspaces && windowShown;
  useEffect(() => {
    if (!polling) return;
    void loadRef.current();
    const id = window.setInterval(() => void loadRef.current(), POLL_MS);
    return () => window.clearInterval(id);
  }, [polling]);

  // The section header's refresh — a forced re-read past the main-side cache.
  // Skips the first render: mounting already loaded.
  const seenRefresh = useRef(refreshKey);
  useEffect(() => {
    if (seenRefresh.current === refreshKey) return;
    seenRefresh.current = refreshKey;
    void load(true);
  }, [refreshKey, load]);

  const toggleExpand = useCallback(
    async (pr: PrSummary) => {
      if (expanded === pr.number) {
        setExpanded(null);
        setComments(null);
        setCommentsError(null);
        return;
      }
      setExpanded(pr.number);
      setComments(null);
      setCommentsError(null);
      if (!repoPath) return;
      await fetchComments(repoPath, pr);
    },
    [expanded, repoPath, fetchComments],
  );

  if (!repoPath) return null;

  return (
    <div data-pr-section className="wmux-git-prs" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className={`wmux-git-subhead wmux-git-disclosure ${FOCUS_RING}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-pr-toggle
      >
        <span className="wmux-git-chevron" aria-hidden="true"><IconChevron size={12} /></span>
        <span>{t('git.pullRequests') || 'Pull Requests'}</span>
        {state.kind === 'ready' && (
          <span className="wmux-git-count">· {state.prs.length >= 100 ? '100+' : state.prs.length}</span>
        )}
      </button>

      {open && <>
      {state.kind === 'loading' && (
        <div className="px-3 py-3 text-[var(--text-muted)] text-[11px]" {...tokenAttrs('textMuted', 'text')}>
          {t('git.loading') || 'Loading…'}
        </div>
      )}

      {state.kind === 'gated' && (
        // CLI 미설치/미인증/무remote — fail-closed 안내(조용한 빈 섹션 금지).
        // cli-missing/unauthenticated 문구는 provider(gh/glab)별로 다르므로
        // 핸들러가 내려준 message를 우선한다(self-hosted면 호스트명 포함).
        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)] break-words" {...tokenAttrs('textMuted', 'text')}>
          {state.code === 'no-remote'
            ? t('git.noRemote') || 'This repository has no origin remote.'
            : state.message ||
              (state.code === 'cli-missing'
                ? t('git.ghMissing') || 'CLI is not installed.'
                : t('git.ghUnauth') || 'CLI is not authenticated.')}
        </div>
      )}

      {state.kind === 'ready' && state.prs.length === 0 && (
        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
          {t('git.noPrs') || 'No open pull requests.'}
        </div>
      )}

      {state.kind === 'ready' &&
        state.prs.map((pr) => (
          <div key={pr.number} data-pr-row className="border-b border-[var(--bg-surface)]" style={{ borderColor: 'var(--border-soft)' }}>
            <button
              type="button"
              onClick={() => void toggleExpand(pr)}
              className={`group w-full flex items-center gap-2 px-3 h-9 text-left hover:bg-[rgba(var(--bg-surface-rgb),0.5)] ${FOCUS_RING}`}
              aria-expanded={expanded === pr.number}
            >
              <span className={`text-[10px] shrink-0 ${checksClass(pr.checks)}`} title={pr.checks ?? ''} aria-hidden="true">
                ●
              </span>
              <span className="text-[11px] text-[var(--text-muted)] font-mono shrink-0" {...tokenAttrs('textMuted', 'text')}>
                #{pr.number}
              </span>
              <span className="flex-1 min-w-0 truncate text-[var(--text-main)]" title={pr.title} {...tokenAttrs('textMain', 'text')}>
                {pr.title}
              </span>
              <span className="text-[10px] text-[var(--text-muted)] shrink-0" title={pr.state} {...tokenAttrs('textMuted', 'text')}>
                {stateLabel(pr)} {relTime(pr.updatedAt, t)}
              </span>
              <span
                role="link"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(pr.url, '_blank');
                }}
                className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                title={t('git.openInBrowser') || 'Open in browser'}
              >
                ↗
              </span>
            </button>
            {expanded === pr.number && (
              <div data-pr-comments className="px-3 pb-2 text-[11px]">
                <div className="text-[10px] text-[var(--text-muted)] pb-1" {...tokenAttrs('textMuted', 'text')}>
                  {pr.author && `@${pr.author}`} {pr.headRefName && `· ${pr.headRefName}`}{' '}
                  {pr.reviewDecision && `· ${pr.reviewDecision.toLowerCase().replaceAll('_', ' ')}`}
                </div>
                {commentsLoading && (
                  <div className="text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                    {t('git.loading') || 'Loading…'}
                  </div>
                )}
                {/* 상세 실패는 빈 상태와 구분해 명시(Codex P2). */}
                {!commentsLoading && commentsError && (
                  <div className="text-[var(--accent-red)] break-words">
                    {t('git.commentsFailed') || 'Could not load comments'}: {commentsError}
                  </div>
                )}
                {!commentsLoading && !commentsError && comments && comments.length === 0 && (
                  <div className="text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                    {t('git.noComments') || 'No comments.'}
                  </div>
                )}
                {!commentsLoading && !commentsError &&
                  comments?.map((c, i) => (
                    <div key={i} className="group/comment py-1 border-t border-[var(--bg-surface)]" style={{ borderColor: 'var(--border-soft)' }}>
                      <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                        <span className="font-semibold">@{c.author}</span>
                        {c.kind === 'review' && c.reviewState && ` · ${c.reviewState.toLowerCase().replaceAll('_', ' ')}`}
                        {c.createdAt && ` · ${relTime(c.createdAt, t)}`}
                        <div className="flex-1" />
                        {/* 모든 코멘트에 브라우저 딥링크(비-truncate 포함, Codex P3). */}
                        <button
                          type="button"
                          onClick={() => window.open(c.url, '_blank')}
                          title={t('git.openInBrowser') || 'Open in browser'}
                          className="opacity-0 group-hover/comment:opacity-100 transition-opacity hover:text-[var(--text-main)]"
                        >
                          ↗
                        </button>
                      </div>
                      {c.body && (
                        <div className="text-[var(--text-sub)] break-words" {...tokenAttrs('textSub', 'text')}>
                          {renderBrainMarkdown(c.body)}
                        </div>
                      )}
                      {c.truncated && (
                        <button
                          type="button"
                          onClick={() => window.open(c.url, '_blank')}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] underline"
                        >
                          {t('git.viewFull') || 'View full comment in browser'}
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        ))}
      </>}
    </div>
  );
}

export default PrSection;
