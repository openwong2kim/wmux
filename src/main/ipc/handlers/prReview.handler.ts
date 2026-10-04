// The Git page's PR review and CI IPC (src/main/github/GhPrReviewService.ts):
// every argument from the renderer is validated here, the repo path is
// confined, and the repo's GitHub remote is resolved before gh runs. Each call
// names the PR by its URL, and the URL must be on that same repo: a list read
// through another remote (a fork's upstream, gh's default repo) never gets a
// review or a merge sent to a different PR with the same number.
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { resolveAccessiblePath } from './fs.handler';
import { detectRemote, isGithubHost } from '../../github/PrProvider';
import { prUrlParts } from '../../../shared/prDragRef';
import { ghPrReviewService, type GhPrReviewService } from '../../github/GhPrReviewService';
import {
  MERGE_SUBJECT_MAX,
  REVIEW_BODY_MAX,
  REVIEW_EVENTS,
  isCommitSha,
  type PrCommentRequest,
  type PrMergeRequest,
  type PrReviewRead,
  type PrSubmitReviewRequest,
  type PrWriteResult,
} from '../../../shared/prReview';

const invalid = (message: string) => ({ ok: false as const, code: 'invalid' as const, message });

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 31;
const isRunId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v);
const isBody = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
/** A repo-relative file path from the PR's own diff. */
const isPath = (v: unknown): v is string =>
  // eslint-disable-next-line no-control-regex -- control characters are what is refused
  typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.startsWith('/') && !v.split('/').includes('..') && !/[\u0000-\u001f]/.test(v);

/** The PR's number when its URL is on `key` (host/owner/repo, any case), else null. */
export function prNumberOn(key: string, prUrl: unknown): number | null {
  const parts = typeof prUrl === 'string' ? prUrlParts(prUrl) : null;
  if (!parts) return null;
  return `${parts.host}/${parts.owner}/${parts.repo}`.toLowerCase() === key.toLowerCase() ? parts.number : null;
}

/** The confined repo, its GitHub key and the PR's number, or why not. */
async function githubPr(repoPath: unknown, prUrl: unknown): Promise<{ cwd: string; key: string; number: number } | { error: string }> {
  if (typeof repoPath !== 'string' || !repoPath) return { error: 'repoPath required' };
  const cwd = await resolveAccessiblePath(repoPath);
  if (!cwd) return { error: 'repoPath required' };
  const remote = await detectRemote(cwd);
  if (!remote || !isGithubHost(remote.host) || !remote.key) return { error: 'not a GitHub repository' };
  const number = prNumberOn(remote.key, prUrl);
  if (number === null) return { error: `this pull request is not on ${remote.key}; refusing to act on it from here` };
  return { cwd, key: remote.key, number };
}

export function parseCommentRequest(raw: unknown): PrCommentRequest | null {
  const r = raw as Partial<PrCommentRequest> | null;
  if (!r || !isCommitSha(r.expectHead) || !isPath(r.path) || !isNumber(r.line) || (r.side !== 'LEFT' && r.side !== 'RIGHT')) return null;
  if (!isBody(r.body, REVIEW_BODY_MAX) || !r.body.trim()) return null;
  return { expectHead: r.expectHead, path: r.path, line: r.line, side: r.side, body: r.body };
}

export function parseReviewRequest(raw: unknown): PrSubmitReviewRequest | null {
  const r = raw as Partial<PrSubmitReviewRequest> | null;
  if (!r || !isCommitSha(r.expectHead) || !REVIEW_EVENTS.includes(r.event as never) || !isBody(r.body, REVIEW_BODY_MAX)) return null;
  // Request changes and a plain comment say something; an approval may not.
  if (r.event !== 'APPROVE' && !r.body.trim()) return null;
  return { expectHead: r.expectHead, event: r.event as PrSubmitReviewRequest['event'], body: r.body };
}

export function parseMergeRequest(raw: unknown): PrMergeRequest | null {
  const r = raw as Partial<PrMergeRequest> | null;
  if (!r || !isCommitSha(r.expectHead) || !isBody(r.subject, MERGE_SUBJECT_MAX) || !r.subject.trim() || /[\r\n]/.test(r.subject)) return null;
  if (!isBody(r.body, REVIEW_BODY_MAX)) return null;
  return { expectHead: r.expectHead, subject: r.subject.trim(), body: r.body };
}

export function registerPrReviewHandlers(service: GhPrReviewService = ghPrReviewService): () => void {
  const on = <R>(channel: string, run: (cwd: string, key: string, number: number, ...args: unknown[]) => Promise<R> | R) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, prUrl: unknown, ...args: unknown[]) => {
      const pr = await githubPr(repoPath, prUrl);
      return 'error' in pr ? invalid(pr.error) : run(pr.cwd, pr.key, pr.number, ...args);
    }));
  };

  on<PrReviewRead<unknown>>(IPC.PR_REVIEW_CHECKS, (cwd, key, number, force) => service.checks(cwd, key, number, force === true));
  on<PrReviewRead<unknown>>(IPC.PR_REVIEW_FILES, (cwd, key, number, head) =>
    isCommitSha(head) ? service.files(cwd, key, number, head) : invalid('a head commit is required'));
  on<PrReviewRead<unknown>>(IPC.PR_REVIEW_THREADS, (cwd, key, number, head, force) =>
    isCommitSha(head) ? service.threads(cwd, key, number, head, force === true) : invalid('a head commit is required'));
  on<PrReviewRead<unknown>>(IPC.PR_REVIEW_RUN_LOG, (cwd, key, _number, runId) => (isRunId(runId) ? service.runLog(cwd, key, runId) : invalid('valid run id required')));

  on<PrWriteResult>(IPC.PR_REVIEW_COMMENT, (cwd, key, number, raw) => {
    const req = parseCommentRequest(raw);
    return req ? service.comment(cwd, key, number, req) : invalid('a line, a head and a comment are required');
  });
  on<PrWriteResult>(IPC.PR_REVIEW_REPLY, (cwd, key, number, commentId, body) =>
    typeof commentId === 'number' && Number.isSafeInteger(commentId) && commentId > 0 && isBody(body, REVIEW_BODY_MAX) && body.trim()
      ? service.reply(cwd, key, number, commentId, body)
      : invalid('a comment and a reply are required'));
  on<PrWriteResult>(IPC.PR_REVIEW_SUBMIT, (cwd, key, number, raw) => {
    const req = parseReviewRequest(raw);
    return req ? service.submitReview(cwd, key, number, req) : invalid('a review needs a head, an action and (unless approving) a body');
  });
  on<PrWriteResult>(IPC.PR_REVIEW_MERGE, (cwd, key, number, raw) => {
    const req = parseMergeRequest(raw);
    return req ? service.merge(cwd, key, number, req) : invalid('a merge needs the head and a one-line subject');
  });
  on<PrWriteResult>(IPC.PR_REVIEW_RERUN, (cwd, key, _number, runId) => (isRunId(runId) ? service.rerunFailed(cwd, key, runId) : invalid('valid run id required')));

  const channels = [
    IPC.PR_REVIEW_CHECKS, IPC.PR_REVIEW_FILES, IPC.PR_REVIEW_THREADS, IPC.PR_REVIEW_RUN_LOG,
    IPC.PR_REVIEW_COMMENT, IPC.PR_REVIEW_REPLY, IPC.PR_REVIEW_SUBMIT, IPC.PR_REVIEW_MERGE, IPC.PR_REVIEW_RERUN,
  ];
  return () => { for (const c of channels) ipcMain.removeHandler(c); };
}
