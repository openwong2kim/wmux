// Git tab — Pull Requests section (gh CLI based, sparse pull).
//
// "Realtime" level: 30s poll only while section mounted (=Git tab visible) +
// manual refresh + immediate comment fetch when PR expanded. main cache (GhPrService)
// skips comment re-fetch when updatedAt unchanged within 30s TTL to cap rate limit
// (same sparse-poll choice as useMissionsPolling push-vs-pull rationale).
//
// fail-closed: gh not installed/unauthenticated/non-GitHub remote degraded to notice —
// section never silently empty. All rows·comments offer one-click "open in browser".
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { renderBrainMarkdown } from './BrainMarkdown';
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

// State glyph — monochrome (color only on checks dot, neutral palette).
function stateLabel(pr: PrSummary): string {
  if (pr.state === 'merged') return '⇥';
  if (pr.state === 'closed') return '✕';
  if (pr.state === 'draft') return '◌';
  return '●';
}

function checksClass(checks: PrSummary['checks']): string {
  // Same rule as diff content: status colors use own green/red palette (no theme accent).
  if (checks === 'passing') return 'text-[var(--accent-green,#4ade80)]';
  if (checks === 'failing') return 'text-[var(--accent-red,#f87171)]';
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

export function PrSection({ repoPath }: { repoPath: string | null }): React.ReactElement | null {
  const t = useT();
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [comments, setComments] = useState<PrComment[] | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  // Poll re-entry guard — prevent interval overlap during slow gh response (DeckScheduler convention).
  const inFlight = useRef(false);
  // Mirror current repoPath in ref — stale in-flight response must not overwrite new repo UI (Codex P2).
  const repoRef = useRef(repoPath);
  repoRef.current = repoPath;
  // updatedAt from last detail fetch for expanded PR — re-fetch comments when list poll changes value (Codex P2).
  const expandedUpdatedAt = useRef<string>('');

  const fetchComments = useCallback(async (repo: string, pr: PrSummary) => {
    const bridge = getGithubBridge();
    if (!bridge) return;
    setCommentsLoading(true);
    setCommentsError(null);
    const res = await bridge.prDetail(repo, pr.number, pr.updatedAt);
    // Discard if repo/expanded changed meanwhile (stale response).
    if (repoRef.current !== repo) return;
    setCommentsLoading(false);
    if (res.ok) {
      expandedUpdatedAt.current = pr.updatedAt;
      setComments(res.detail.comments);
    } else {
      // Do not collapse failure into empty comments — distinguish from truly empty thread (Codex P2).
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
      // Do not overwrite new repo UI with stale result if repo changed (Codex P2).
      if (repoRef.current !== repo) return;
      if (res.ok) {
        setState({ kind: 'ready', prs: res.prs });
        // Re-fetch comments when expanded PR updatedAt changed on list poll (Codex P2).
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

  // Immediate on mount/repo change + 30s sparse poll (mount = Git tab visible).
  useEffect(() => {
    setState({ kind: 'loading' });
    setExpanded(null);
    setComments(null);
    setCommentsError(null);
    expandedUpdatedAt.current = '';
    if (!repoPath) return;
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

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
    <div data-pr-section className="shrink-0 max-h-[55%] overflow-y-auto border-b border-[var(--bg-surface)]" style={{ borderColor: 'var(--border-soft)' }}>
      {/* Section header — 36px chrome row. */}
      <div
        className="flex items-center gap-2 h-9 px-3 sticky top-0 bg-[var(--bg-mantle)] border-b border-[var(--bg-surface)]"
        style={{ borderColor: 'var(--border-soft)' }}
        {...tokenAttrs('bgMantle', 'bg')}
      >
        <span className="font-semibold text-[var(--text-main)]" {...tokenAttrs('textMain', 'text')}>
          {t('git.pullRequests') || 'Pull Requests'}
        </span>
        {state.kind === 'ready' && (
          <span className="text-[10.5px] text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            ({state.prs.length >= 100 ? '100+' : state.prs.length})
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void load(true)}
          title={t('git.refresh') || 'Refresh'}
          aria-label={t('git.refresh') || 'Refresh'}
          className={`flex items-center justify-center w-6 h-6 rounded text-[var(--text-muted)] hover:text-[var(--text-sub)] transition-colors ${FOCUS_RING}`}
          {...tokenAttrs('textMuted', 'text')}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M12 7a5 5 0 11-1.5-3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M12 1v2.6H9.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {state.kind === 'loading' && (
        <div className="px-3 py-3 text-[var(--text-muted)] text-[11px]" {...tokenAttrs('textMuted', 'text')}>
          {t('git.loading') || 'Loading…'}
        </div>
      )}

      {state.kind === 'gated' && (
        // CLI not installed/unauthenticated/no remote — fail-closed notice (no silent empty section).
        // cli-missing/unauthenticated wording differs by provider (gh/glab) so
        // prefer handler message (includes host name when self-hosted).
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
              <span className="text-[10.5px] text-[var(--text-muted)] font-mono shrink-0" {...tokenAttrs('textMuted', 'text')}>
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
                {/* Explicit detail failure vs empty state (Codex P2). */}
                {!commentsLoading && commentsError && (
                  <div className="text-[var(--accent-red,#f87171)] break-words">
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
                        {/* Browser deeplink on every comment (including non-truncate, Codex P3). */}
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
    </div>
  );
}

export default PrSection;
