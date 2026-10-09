// Reviewing and merging a PR from the Git page's detail pane, and its CI: the
// contract between the page and main, and the pure rules both sides share.
//
// Every write is tied to the head commit the person saw (`expectHead`): main
// re-reads the PR's head right before writing and refuses if it moved, and the
// merge also asks GitHub to refuse a different head (--match-head-commit).
// Logs and bodies from GitHub are untrusted text: shown as text, never markup.
import { cleanGhOutput } from './ghDeviceLogin';
import type { DiffFile, DiffHunk } from './diffParse';
import type { WorkLink, WorkLinkReason } from './workLink';

/** A PR's head and mergeability, read fresh with its checks. */
export interface PrReviewHead {
  number: number;
  title: string;
  url: string;
  /** OPEN, CLOSED or MERGED. */
  state: string;
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  /** MERGEABLE, CONFLICTING or UNKNOWN (GitHub is still computing it). */
  mergeable: string;
  /** CLEAN, DIRTY, BLOCKED, BEHIND, UNSTABLE, HAS_HOOKS, DRAFT or UNKNOWN. */
  mergeStateStatus: string;
  /** Label names, when the read asked for them. */
  labels?: string[];
  /** The author's login, when the read asked for it (`author`); null for a
   *  deleted ("ghost") account, as in PrLaneFacts. */
  author?: string | null;
  /** When it was merged (ISO), or null while not merged — when asked for. */
  mergedAt?: string | null;
  /** The commit the merge made (for a squash: the new squash commit, never
   *  the PR's head), or null — when asked for (`mergeCommit`). A merged PR's
   *  head is still `headRefOid`. */
  mergeCommitOid?: string | null;
}

/** gh's own grouping of a check's state. */
export type PrCheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

export interface PrCheck {
  name: string;
  workflow: string;
  bucket: PrCheckBucket;
  /** The check's page; a GitHub Actions job when runId is set. */
  link: string;
  startedAt?: string;
  completedAt?: string;
  /** Set when the link is a GitHub Actions run (its log and rerun work). */
  runId?: string;
  jobId?: string;
  /** Required by the base branch's protection for this PR, when the read
   *  asked (GraphQL `isRequired(pullRequestNumber:)`; gh pr view has no such field). */
  isRequired?: boolean;
}

export interface PrChecksState {
  head: PrReviewHead;
  checks: PrCheck[];
}

/**
 * Everything Moa's merge lane decides on (main/deck/moaMergeLane.ts), from ONE
 * GraphQL read (GhPrReviewService LANE_PR_QUERY), so the head, its checks,
 * labels and files belong to the same moment. Always read fresh, never cached.
 */
export interface PrLaneFacts {
  number: number;
  /** OPEN, CLOSED or MERGED. */
  state: string;
  isDraft: boolean;
  /** The head branch lives in a fork. */
  isCrossRepository: boolean;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  /** Null for a deleted ("ghost") account. */
  author: string | null;
  /** GitHub's mergeStateStatus (CLEAN, BLOCKED, BEHIND, ...), when it was read. */
  mergeStateStatus?: string;
  /** The title and mergeable (MERGEABLE, CONFLICTING, UNKNOWN), when read:
   *  display only (the decision card), no lane predicate reads them. */
  title?: string;
  mergeable?: string;
  mergedAt: string | null;
  mergeCommitOid: string | null;
  labels: string[];
  labelsTruncated: boolean;
  /** Changed paths. `filesTruncated`: more files changed than were read. */
  files: string[];
  filesTruncated: boolean;
  /** The commit the checks were read on (the last commit), or null. */
  checksHeadOid: string | null;
  /** Each check with its `isRequired` set. */
  checks: PrCheck[];
  checksTruncated: boolean;
}

export interface PrReviewComment {
  /** REST id, used to reply. */
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface PrReviewThread {
  id: string;
  path: string;
  /** On a line, or on the file as a whole (then `line` is null). */
  subject: 'line' | 'file';
  /** The line on `side`; null for a file comment, or when GitHub no longer
   *  places it on a line. */
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  isResolved: boolean;
  isOutdated: boolean;
  comments: PrReviewComment[];
}

export interface PrThreadsState {
  /** The head the threads were read for. */
  headRefOid: string;
  threads: PrReviewThread[];
  /** More threads or comments exist than were read. */
  truncated: boolean;
}

export interface PrFilesState {
  /** The head the diff was read at. */
  headRefOid: string;
  files: DiffFile[];
  /** Files left out or cut (the diff was over its size cap). */
  truncated: boolean;
}

export interface PrRunLog {
  runId: string;
  /** The failed jobs' log, ANSI stripped, its last LOG_TAIL_MAX_LINES lines. */
  text: string;
  truncated: boolean;
  /** The log was too large to read here; open it on GitHub. */
  tooLarge?: boolean;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export const REVIEW_EVENTS: readonly ReviewEvent[] = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];

/** Longest comment, review or merge body accepted. */
export const REVIEW_BODY_MAX = 65_536;
/** Longest merge subject accepted. */
export const MERGE_SUBJECT_MAX = 512;

// ── IPC results ───────────────────────────────────────────────────────────────

export type PrReviewRead<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'rate-limited'; message: string; retryAt: number }
  | { ok: false; code: 'error' | 'invalid'; message: string };

export type PrWriteResult =
  | { ok: true; url?: string }
  /** The PR's head is not the one the person saw. */
  | { ok: false; code: 'moved'; message: string; headRefOid?: string }
  /** Merge only: GitHub would not take it now, and why. */
  | { ok: false; code: 'blocked'; reason: MergeBlock; message: string }
  | { ok: false; code: 'rate-limited'; message: string; retryAt: number }
  | { ok: false; code: 'error' | 'invalid'; message: string };

export interface PrCommentRequest {
  expectHead: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

export interface PrSubmitReviewRequest {
  expectHead: string;
  event: ReviewEvent;
  body: string;
}

export interface PrMergeRequest {
  expectHead: string;
  subject: string;
  body: string;
}

// ── Pure rules ────────────────────────────────────────────────────────────────

/** Why a squash merge cannot run now, or null. */
export type MergeBlock = 'not-open' | 'draft' | 'conflicts' | 'checks-failing' | 'checks-pending' | 'blocked' | 'behind' | 'unknown';

export function mergeBlock(head: PrReviewHead, checks: readonly PrCheck[]): MergeBlock | null {
  if (head.state !== 'OPEN') return 'not-open';
  if (head.isDraft || head.mergeStateStatus === 'DRAFT') return 'draft';
  if (head.mergeable === 'CONFLICTING' || head.mergeStateStatus === 'DIRTY') return 'conflicts';
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'checks-failing';
  // UNSTABLE without a failure in sight: a check still running (or one this
  // list does not show), not a failure.
  if (checks.some((c) => c.bucket === 'pending') || head.mergeStateStatus === 'UNSTABLE') return 'checks-pending';
  if (head.mergeStateStatus === 'BEHIND') return 'behind';
  if (head.mergeStateStatus === 'BLOCKED') return 'blocked';
  if (head.mergeable === 'UNKNOWN' || head.mergeStateStatus === 'UNKNOWN') return 'unknown';
  return null;
}

/** The squash commit's default subject. */
export function squashSubject(title: string, number: number): string {
  return `${title.replace(/\s+/g, ' ').trim()} (#${number})`;
}

/** A full commit SHA. */
export function isCommitSha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v);
}

/** The run (and job) of a GitHub Actions check link, or null for any other check. */
export function parseRunLink(url: string): { runId: string; jobId?: string } | null {
  const m = /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/actions\/runs\/(\d{1,20})(?:\/job\/(\d{1,20}))?(?:[/?#].*)?$/.exec(url);
  if (!m) return null;
  return m[2] ? { runId: m[1], jobId: m[2] } : { runId: m[1] };
}

export const LOG_TAIL_MAX_LINES = 200;
export const LOG_TAIL_MAX_BYTES = 32 * 1024;

/** A log as plain text: ANSI and other control characters removed (tabs and
 *  line breaks kept), then its last lines within the caps; the byte cap is
 *  UTF-8 bytes, cut on a character and then a line boundary. Pure. */
export function cleanLogTail(raw: string): { text: string; truncated: boolean } {
  // eslint-disable-next-line no-control-regex -- control characters are what is removed
  const plain = cleanGhOutput(raw).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  const lines = plain.replace(/\n+$/, '').split('\n');
  let truncated = lines.length > LOG_TAIL_MAX_LINES;
  let tail = lines.slice(-LOG_TAIL_MAX_LINES).join('\n');
  const bytes = new TextEncoder().encode(tail);
  if (bytes.length > LOG_TAIL_MAX_BYTES) {
    let start = bytes.length - LOG_TAIL_MAX_BYTES;
    // Never start inside a character: skip UTF-8 continuation bytes.
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    tail = new TextDecoder().decode(bytes.subarray(start));
    const nl = tail.indexOf('\n');
    if (nl >= 0) tail = tail.slice(nl + 1);
    truncated = true;
  }
  return { text: tail, truncated };
}

/** One line of a hunk with its line numbers, for a gutter and line comments. */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** A hunk's lines numbered from its header. Pure. */
export function numberHunkLines(hunk: Pick<DiffHunk, 'oldStart' | 'newStart' | 'bodyLines'>): DiffLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.bodyLines.map((raw): DiffLine => {
    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === '+') return { kind: 'add', text, newLine: newLine++ };
    if (mark === '-') return { kind: 'del', text, oldLine: oldLine++ };
    if (mark === ' ') return { kind: 'ctx', text, oldLine: oldLine++, newLine: newLine++ };
    return { kind: 'meta', text: raw };
  });
}

/** Where a comment on this line goes: the new file's line for an added or
 *  unchanged line, the old file's for a removed one. Null for a meta line. */
export function commentAnchor(line: DiffLine): { line: number; side: 'LEFT' | 'RIGHT' } | null {
  if (line.kind === 'del' && line.oldLine !== undefined) return { line: line.oldLine, side: 'LEFT' };
  if ((line.kind === 'add' || line.kind === 'ctx') && line.newLine !== undefined) return { line: line.newLine, side: 'RIGHT' };
  return null;
}

/** Who acts next on work linked to a PR: you, the agent doing it (the link's
 *  owner), or nobody (finished). */
export type NextActor =
  | { actor: 'you'; reason: WorkLinkReason | 'review' }
  | { actor: 'owner'; reason?: WorkLinkReason; working: boolean }
  | null;

export function whoActsNext(link: Pick<WorkLink, 'state' | 'reason'>): NextActor {
  switch (link.state) {
    case 'needs-you':
      return { actor: 'you', reason: link.reason ?? 'other' };
    case 'review':
      return { actor: 'you', reason: 'review' };
    case 'blocked':
      return { actor: 'owner', ...(link.reason ? { reason: link.reason } : {}), working: false };
    case 'queued':
    case 'running':
      return { actor: 'owner', working: true };
    default:
      return null;
  }
}
