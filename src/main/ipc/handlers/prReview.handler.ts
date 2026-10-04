// The Git page's PR review and CI IPC (src/main/github/GhPrReviewService.ts):
// every argument from the renderer is validated here, the repo path is
// confined, and the repo's GitHub remote is resolved before gh runs.
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { resolveAccessiblePath } from './fs.handler';
import { detectRemote, isGithubHost } from '../../github/PrProvider';
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

/** The confined repo and its GitHub key (host/owner/repo), or why not. */
async function githubRepo(repoPath: unknown): Promise<{ cwd: string; key: string } | { error: string }> {
  if (typeof repoPath !== 'string' || !repoPath) return { error: 'repoPath required' };
  const cwd = await resolveAccessiblePath(repoPath);
  if (!cwd) return { error: 'repoPath required' };
  const remote = await detectRemote(cwd);
  if (!remote || !isGithubHost(remote.host) || !remote.key) return { error: 'not a GitHub repository' };
  return { cwd, key: remote.key };
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
  const read = <T>(channel: string, run: (cwd: string, key: string, ...args: unknown[]) => Promise<PrReviewRead<T>> | PrReviewRead<T>) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, ...args: unknown[]) => {
      const repo = await githubRepo(repoPath);
      return 'error' in repo ? invalid(repo.error) : run(repo.cwd, repo.key, ...args);
    }));
  };
  const write = (channel: string, run: (cwd: string, key: string, ...args: unknown[]) => Promise<PrWriteResult> | PrWriteResult) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, ...args: unknown[]) => {
      const repo = await githubRepo(repoPath);
      return 'error' in repo ? invalid(repo.error) : run(repo.cwd, repo.key, ...args);
    }));
  };

  read(IPC.PR_REVIEW_CHECKS, (cwd, key, number, force) =>
    isNumber(number) ? service.checks(cwd, key, number, force === true) : invalid('valid PR number required'));
  read(IPC.PR_REVIEW_FILES, (cwd, key, number, head) =>
    isNumber(number) && isCommitSha(head) ? service.files(cwd, key, number, head) : invalid('valid PR number and head required'));
  read(IPC.PR_REVIEW_THREADS, (cwd, key, number, force) =>
    isNumber(number) ? service.threads(cwd, key, number, force === true) : invalid('valid PR number required'));
  read(IPC.PR_REVIEW_RUN_LOG, (cwd, key, runId) => (isRunId(runId) ? service.runLog(cwd, key, runId) : invalid('valid run id required')));

  write(IPC.PR_REVIEW_COMMENT, (cwd, key, number, raw) => {
    const req = parseCommentRequest(raw);
    return isNumber(number) && req ? service.comment(cwd, key, number, req) : invalid('a line, a head and a comment are required');
  });
  write(IPC.PR_REVIEW_REPLY, (cwd, key, number, commentId, body) =>
    isNumber(number) && typeof commentId === 'number' && Number.isSafeInteger(commentId) && commentId > 0 && isBody(body, REVIEW_BODY_MAX) && body.trim()
      ? service.reply(cwd, key, number, commentId, body)
      : invalid('a comment and a reply are required'));
  write(IPC.PR_REVIEW_SUBMIT, (cwd, key, number, raw) => {
    const req = parseReviewRequest(raw);
    return isNumber(number) && req ? service.submitReview(cwd, key, number, req) : invalid('a review needs a head, an action and (unless approving) a body');
  });
  write(IPC.PR_REVIEW_MERGE, (cwd, key, number, raw) => {
    const req = parseMergeRequest(raw);
    return isNumber(number) && req ? service.merge(cwd, key, number, req) : invalid('a merge needs the head and a one-line subject');
  });
  write(IPC.PR_REVIEW_RERUN, (cwd, key, runId) => (isRunId(runId) ? service.rerunFailed(cwd, key, runId) : invalid('valid run id required')));

  const channels = [
    IPC.PR_REVIEW_CHECKS, IPC.PR_REVIEW_FILES, IPC.PR_REVIEW_THREADS, IPC.PR_REVIEW_RUN_LOG,
    IPC.PR_REVIEW_COMMENT, IPC.PR_REVIEW_REPLY, IPC.PR_REVIEW_SUBMIT, IPC.PR_REVIEW_MERGE, IPC.PR_REVIEW_RERUN,
  ];
  return () => { for (const c of channels) ipcMain.removeHandler(c); };
}
