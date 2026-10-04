// A WorkLink ties one piece of delegated work to everything that hangs off
// it: the issue it came from, the A2A task that carries it, the workspace and
// pane doing it, the worktree and branch, the PR, and the human decisions it
// raised. It is the one record both the Git page ("who acts next" on an issue
// or PR) and Moa's task cards read. See docs/work-links.md.
//
// Relations:
//   - one link per A2A task (a2aTaskId is unique across links);
//   - an issue may have many links (1:N), a link has at most one issue;
//   - a link has at most one PR, and several links may point at the same PR;
//   - a decision is attached to the link of the task it is about.
//
// Only main writes links (A2A send paths, fanout, Moa). The renderer reads.
// Everything here is pure so both sides share one parser and one derivation.

import { ISSUE_REF_TITLE_MAX, issueUrlParts, type IssueRef } from './issueRef';
import type { PrSummary } from './prSurface';
import { isTaskState, type TaskState } from './types';

export const WORK_LINK_STATES = [
  'queued',
  'running',
  'needs-you',
  'blocked',
  'review',
  'done',
  'abandoned',
] as const;
export type WorkLinkState = (typeof WORK_LINK_STATES)[number];

/** Where the work started: a Git page issue, a Moa delegation, or a plain send. */
export const WORK_LINK_ORIGINS = ['issue', 'moa', 'manual'] as const;
export type WorkLinkOrigin = (typeof WORK_LINK_ORIGINS)[number];

/** Why a link is `needs-you` (a person must act) or `blocked` (the agent must). */
export const WORK_LINK_REASONS = [
  // needs-you
  'decision',
  'input-required',
  // blocked
  'task-failed',
  'ci-failing',
  'conflict',
  'changes-requested',
  // either, set by an explicit setState
  'other',
] as const;
export type WorkLinkReason = (typeof WORK_LINK_REASONS)[number];

/** A PR or merge request, keyed the same way as an issue (host/owner/repo#n). */
export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
  url?: string;
}

/** The last PR status a reader observed; an input to deriveWorkLinkState. */
export type WorkLinkPrStatus = Pick<PrSummary, 'state' | 'checks' | 'reviewDecision' | 'mergeable'> & {
  observedAt: number;
};

export interface WorkLinkParty {
  workspaceId: string;
  paneId?: string;
}

export interface WorkLink {
  id: string;
  origin: WorkLinkOrigin;
  /** Present whenever the work is about an issue; required when origin is 'issue'. */
  issue?: IssueRef;
  /** Untrusted free text (task or issue title), capped. Show as text only. */
  title?: string;
  /** The A2A task carrying the work. Unique across links. */
  a2aTaskId?: string;
  /** Last A2A state observed for that task; an input to deriveWorkLinkState. */
  a2aState?: TaskState;
  /** The workspace (and pane) doing the work: the task's receiver. */
  owner: WorkLinkParty;
  /** The workspace (and pane) that handed the work out: the task's sender. */
  requester?: WorkLinkParty;
  /** Agent slug of the worker, e.g. 'claude' or 'codex'. */
  agent?: string;
  worktree?: { path: string; branch?: string };
  pr?: PrRef;
  prStatus?: WorkLinkPrStatus;
  state: WorkLinkState;
  /** Only on needs-you and blocked. */
  reason?: WorkLinkReason;
  /** Decisions raised about this work, oldest first, at most WORK_LINK_LIMITS.MAX_DECISIONS. */
  decisionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export const WORK_LINK_LIMITS = {
  MAX_DECISIONS: 32,
  MAX_TITLE: ISSUE_REF_TITLE_MAX,
  MAX_PATH: 1024,
  MAX_BRANCH: 255,
} as const;

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const NAME_RE = /^[\w.-]{1,100}$/;
// A git ref name: no whitespace, control characters or the characters git refuses.
// eslint-disable-next-line no-control-regex
const BRANCH_RE = /^[^\s\x00-\x1f\x7f~^:?*[\\]+$/;
const REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', '']);
const PR_STATES = new Set<WorkLinkPrStatus['state']>(['open', 'draft', 'merged', 'closed']);
const PR_CHECKS = new Set<WorkLinkPrStatus['checks']>(['passing', 'pending', 'failing', null]);

const includes = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

export const isWorkLinkState = (v: unknown): v is WorkLinkState => includes(WORK_LINK_STATES, v);
export const isWorkLinkOrigin = (v: unknown): v is WorkLinkOrigin => includes(WORK_LINK_ORIGINS, v);
export const isWorkLinkReason = (v: unknown): v is WorkLinkReason => includes(WORK_LINK_REASONS, v);
export const isWorkLinkId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
export const isWorkspaceId = (v: unknown): v is string => typeof v === 'string' && WORKSPACE_ID_RE.test(v);

/** Only needs-you and blocked carry a reason. */
export const stateTakesReason = (s: WorkLinkState): boolean => s === 'needs-you' || s === 'blocked';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isRepoNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e10;

/** An IssueRef whose host/owner/repo/number agree with its URL, title capped; else null. */
export function parseIssueRefObject(v: unknown): IssueRef | null {
  if (!isRecord(v) || typeof v.url !== 'string' || typeof v.title !== 'string') return null;
  const p = issueUrlParts(v.url);
  if (!p || v.host !== p.host || v.owner !== p.owner || v.repo !== p.repo || v.number !== p.number) return null;
  return { ...p, title: v.title.slice(0, ISSUE_REF_TITLE_MAX), url: v.url };
}

/** A PR ref with a sane host/owner/repo/number; a url, when given, must be https on that host. */
export function parsePrRef(v: unknown): PrRef | null {
  if (!isRecord(v)) return null;
  const { host, owner, repo, number, url } = v;
  if (typeof host !== 'string' || !NAME_RE.test(host)) return null;
  if (typeof owner !== 'string' || !NAME_RE.test(owner)) return null;
  if (typeof repo !== 'string' || !NAME_RE.test(repo)) return null;
  if (!isRepoNumber(number)) return null;
  if (url !== undefined) {
    if (typeof url !== 'string' || url.length > 2048) return null;
    if (!url.toLowerCase().startsWith(`https://${host.toLowerCase()}/`)) return null;
  }
  return { host, owner, repo, number, ...(url !== undefined ? { url } : {}) };
}

/** host/owner/repo/number from a GitHub pull request URL (https://host/owner/repo/pull/N), whole URL only. */
export function prUrlParts(url: string): Omit<PrRef, 'url'> | null {
  const m = url.match(/^https:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d{0,9})$/i);
  return m ? { host: m[1], owner: m[2], repo: m[3], number: Number(m[4]) } : null;
}

type RepoKeyed = { host: string; owner: string; repo: string };
type NumberKeyed = RepoKeyed & { number: number };

/** host/owner/repo, lowercased: GitHub names are case-insensitive. */
export const repoKey = (r: RepoKeyed): string => `${r.host}/${r.owner}/${r.repo}`.toLowerCase();
/** host/owner/repo#n — one spelling for an issue and a PR. */
export const refKey = (r: NumberKeyed): string => `${repoKey(r)}#${r.number}`;

function parseParty(v: unknown): WorkLinkParty | null {
  if (!isRecord(v) || !isWorkspaceId(v.workspaceId)) return null;
  if (v.paneId !== undefined && !isWorkLinkId(v.paneId)) return null;
  return { workspaceId: v.workspaceId, ...(v.paneId !== undefined ? { paneId: v.paneId as string } : {}) };
}

function parseWorktree(v: unknown): WorkLink['worktree'] | null {
  if (!isRecord(v)) return null;
  const { path, branch } = v;
  if (typeof path !== 'string' || !path || path.length > WORK_LINK_LIMITS.MAX_PATH || path.includes('\0')) return null;
  if (branch !== undefined && (typeof branch !== 'string' || branch.length > WORK_LINK_LIMITS.MAX_BRANCH || !BRANCH_RE.test(branch))) {
    return null;
  }
  return { path, ...(branch !== undefined ? { branch: branch as string } : {}) };
}

function parsePrStatus(v: unknown): WorkLinkPrStatus | null {
  if (!isRecord(v)) return null;
  const { state, checks, reviewDecision, mergeable, observedAt } = v;
  if (!PR_STATES.has(state as WorkLinkPrStatus['state'])) return null;
  if (!PR_CHECKS.has(checks as WorkLinkPrStatus['checks'])) return null;
  if (typeof reviewDecision !== 'string' || !REVIEW_DECISIONS.has(reviewDecision)) return null;
  if (typeof mergeable !== 'string' || mergeable.length > 40) return null;
  if (!isTime(observedAt)) return null;
  return {
    state: state as WorkLinkPrStatus['state'],
    checks: checks as WorkLinkPrStatus['checks'],
    reviewDecision,
    mergeable,
    observedAt,
  };
}

/**
 * A WorkLink from untrusted input (a file on disk, an IPC payload), or null.
 * Required fields must be valid; an invalid optional field rejects the whole
 * record rather than being dropped, so a half-understood link never surfaces.
 * Returns a clean copy: unknown keys gone, title capped, decisionIds deduped.
 */
export function parseWorkLink(v: unknown): WorkLink | null {
  if (!isRecord(v)) return null;
  if (!isWorkLinkId(v.id) || !isWorkLinkOrigin(v.origin) || !isWorkLinkState(v.state)) return null;
  if (!isTime(v.createdAt) || !isTime(v.updatedAt)) return null;
  const owner = parseParty(v.owner);
  if (!owner) return null;

  const out: WorkLink = {
    id: v.id,
    origin: v.origin,
    owner,
    state: v.state,
    decisionIds: [],
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
  if (v.issue !== undefined) {
    const issue = parseIssueRefObject(v.issue);
    if (!issue) return null;
    out.issue = issue;
  }
  if (out.origin === 'issue' && !out.issue) return null;
  if (v.title !== undefined) {
    if (typeof v.title !== 'string') return null;
    out.title = v.title.slice(0, WORK_LINK_LIMITS.MAX_TITLE);
  }
  if (v.a2aTaskId !== undefined) {
    if (!isWorkLinkId(v.a2aTaskId)) return null;
    out.a2aTaskId = v.a2aTaskId;
  }
  if (v.a2aState !== undefined) {
    if (!isTaskState(v.a2aState)) return null;
    out.a2aState = v.a2aState;
  }
  if (v.requester !== undefined) {
    const requester = parseParty(v.requester);
    if (!requester) return null;
    out.requester = requester;
  }
  if (v.agent !== undefined) {
    if (typeof v.agent !== 'string' || !AGENT_RE.test(v.agent)) return null;
    out.agent = v.agent;
  }
  if (v.worktree !== undefined) {
    const worktree = parseWorktree(v.worktree);
    if (!worktree) return null;
    out.worktree = worktree;
  }
  if (v.pr !== undefined) {
    const pr = parsePrRef(v.pr);
    if (!pr) return null;
    out.pr = pr;
  }
  if (v.prStatus !== undefined) {
    const prStatus = parsePrStatus(v.prStatus);
    if (!prStatus) return null;
    out.prStatus = prStatus;
  }
  if (v.reason !== undefined) {
    // A reason on a state that takes none is incoherent: reject, don't guess.
    if (!isWorkLinkReason(v.reason) || !stateTakesReason(out.state)) return null;
    out.reason = v.reason;
  }
  if (v.decisionIds !== undefined) {
    if (!Array.isArray(v.decisionIds) || !v.decisionIds.every(isWorkLinkId)) return null;
    out.decisionIds = [...new Set(v.decisionIds as string[])].slice(-WORK_LINK_LIMITS.MAX_DECISIONS);
  }
  return out;
}

export const isWorkLink = (v: unknown): v is WorkLink => parseWorkLink(v) !== null;

// ─── Filter ────────────────────────────────────────────────────────────────

export interface WorkLinkFilter {
  /** Links whose issue or PR is in this repo. */
  repo?: RepoKeyed;
  /** Links whose issue is this one. */
  issue?: NumberKeyed;
  /** Links whose PR is this one. */
  pr?: NumberKeyed;
  /** Links this workspace owns or requested. */
  workspaceId?: string;
  a2aTaskId?: string;
  states?: WorkLinkState[];
}

/** A filter from an untrusted payload; unknown or malformed keys are dropped. */
export function parseWorkLinkFilter(v: unknown): WorkLinkFilter {
  if (!isRecord(v)) return {};
  const out: WorkLinkFilter = {};
  const repoOf = (r: unknown): RepoKeyed | null =>
    isRecord(r) && typeof r.host === 'string' && typeof r.owner === 'string' && typeof r.repo === 'string'
      && NAME_RE.test(r.host) && NAME_RE.test(r.owner) && NAME_RE.test(r.repo)
      ? { host: r.host, owner: r.owner, repo: r.repo }
      : null;
  const numberedOf = (r: unknown): NumberKeyed | null => {
    const repo = repoOf(r);
    return repo && isRecord(r) && isRepoNumber(r.number) ? { ...repo, number: r.number } : null;
  };
  const repo = repoOf(v.repo);
  if (repo) out.repo = repo;
  const issue = numberedOf(v.issue);
  if (issue) out.issue = issue;
  const pr = numberedOf(v.pr);
  if (pr) out.pr = pr;
  if (isWorkspaceId(v.workspaceId)) out.workspaceId = v.workspaceId;
  if (isWorkLinkId(v.a2aTaskId)) out.a2aTaskId = v.a2aTaskId;
  if (Array.isArray(v.states)) out.states = v.states.filter(isWorkLinkState);
  return out;
}

export function matchesWorkLinkFilter(link: WorkLink, f: WorkLinkFilter): boolean {
  if (f.repo) {
    const key = repoKey(f.repo);
    if (!(link.issue && repoKey(link.issue) === key) && !(link.pr && repoKey(link.pr) === key)) return false;
  }
  if (f.issue && !(link.issue && refKey(link.issue) === refKey(f.issue))) return false;
  if (f.pr && !(link.pr && refKey(link.pr) === refKey(f.pr))) return false;
  if (f.workspaceId && link.owner.workspaceId !== f.workspaceId && link.requester?.workspaceId !== f.workspaceId) {
    return false;
  }
  if (f.a2aTaskId && link.a2aTaskId !== f.a2aTaskId) return false;
  if (f.states && !f.states.includes(link.state)) return false;
  return true;
}

// ─── State derivation ──────────────────────────────────────────────────────

export interface WorkLinkDeriveInput {
  state: WorkLinkState;
  reason?: WorkLinkReason;
  a2aState?: TaskState;
  /** The link points at a PR (its status may still be unknown). */
  hasPr: boolean;
  prStatus?: WorkLinkPrStatus;
  /** One of the link's decisions is still pending. */
  pendingDecision: boolean;
}

export interface DerivedWorkLinkState {
  state: WorkLinkState;
  reason?: WorkLinkReason;
}

/** The PR's phase once the agent's part is over. */
function prPhase(hasPr: boolean, pr: WorkLinkPrStatus | undefined): DerivedWorkLinkState {
  if (!hasPr) return { state: 'done' };
  // A PR nobody has read yet is waiting on review, not done.
  if (!pr) return { state: 'review' };
  if (pr.state === 'merged') return { state: 'done' };
  if (pr.state === 'closed') return { state: 'abandoned' };
  if (pr.checks === 'failing') return { state: 'blocked', reason: 'ci-failing' };
  if (pr.mergeable === 'CONFLICTING') return { state: 'blocked', reason: 'conflict' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { state: 'blocked', reason: 'changes-requested' };
  return { state: 'review' };
}

/**
 * A link's state from what is known about it. Total and pure; first match wins:
 *   1. a merged PR                      → done
 *   2. abandoned stays abandoned (only a merge revives it)
 *   3. a canceled task                  → abandoned
 *   4. a pending decision               → needs-you (decision)
 *   5. the task's state: input-required → needs-you, submitted → queued,
 *      working → running, failed → blocked (task-failed),
 *      completed → the PR's phase (no PR → done; PR not read yet → review;
 *      failing checks / conflict / changes requested → blocked; closed → abandoned)
 *   6. no task: a PR → its phase; otherwise the current state, except a
 *      needs-you whose decision is no longer pending, which falls back to queued.
 */
export function deriveWorkLinkState(input: WorkLinkDeriveInput): DerivedWorkLinkState {
  const { a2aState, hasPr, prStatus, pendingDecision } = input;
  if (prStatus?.state === 'merged') return { state: 'done' };
  if (input.state === 'abandoned') return { state: 'abandoned' };
  if (a2aState === 'canceled') return { state: 'abandoned' };
  if (pendingDecision) return { state: 'needs-you', reason: 'decision' };
  switch (a2aState) {
    case 'input-required':
      return { state: 'needs-you', reason: 'input-required' };
    case 'submitted':
      return { state: 'queued' };
    case 'working':
      return { state: 'running' };
    case 'failed':
      return { state: 'blocked', reason: 'task-failed' };
    case 'completed':
      return prPhase(hasPr, prStatus);
    default:
      break;
  }
  if (hasPr) return prPhase(true, prStatus);
  if (input.state === 'needs-you' && input.reason === 'decision') return { state: 'queued' };
  return stateTakesReason(input.state) && input.reason
    ? { state: input.state, reason: input.reason }
    : { state: input.state };
}

/** deriveWorkLinkState over a stored link. */
export function deriveLinkState(link: WorkLink, pendingDecision: boolean): DerivedWorkLinkState {
  return deriveWorkLinkState({
    state: link.state,
    reason: link.reason,
    a2aState: link.a2aState,
    hasPr: !!link.pr,
    prStatus: link.prStatus,
    pendingDecision,
  });
}
