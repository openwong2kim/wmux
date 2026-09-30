/**
 * Phone Git v1: read-only projects and branches, worktree creation, CI checks
 * (docs/phone-client-contract.md, "Proposed: contract v-next", item 5).
 * Served: projects, branches and checks (src/daemon/web/phoneGitRead.ts) and
 * worktree creation (src/daemon/web/phoneWorktree.ts).
 *
 * Every request names a session. The daemon derives the repository from that
 * session's trusted `spawnCwd`; the phone never sends a path, a ref or a
 * refspec. Push and PR creation are not in v1.
 */

import { ownLookup, sanitizeDisplayText } from './phoneText';

// ── Projects and branches ─────────────────────────────────────────────────────

export interface PhoneGitProjectSession {
  sessionId: string;
  /** Short branch name, or null when detached/unborn. */
  branch: string | null;
  /** The session runs in a linked worktree, not the main checkout. */
  linkedWorktree: boolean;
}

export interface PhoneGitProject {
  /**
   * sha256(realpath of the main worktree root) hex, first 12 chars: the same
   * value as the desktop task worktrees' `repoHash`. Opaque to the phone.
   */
  projectId: string;
  /** Last path segment of the main worktree. Display only. */
  name: string;
  /** A session to address this project's routes with (most recently active). */
  sessionId: string;
  sessions: PhoneGitProjectSession[];
}

export interface PhoneGitBranch {
  /** Short name under `refs/heads/`. Display and matching only; never sent back. */
  name: string;
  head: string;
  /** Epoch ms of the tip's committer date. */
  committedAt: number;
  upstream?: { name: string; ahead: number; behind: number; gone: boolean };
  /** Present when a worktree has this branch checked out. */
  worktree?: { leaf: string; main: boolean; sessionIds: string[] };
}

export interface PhoneGitBranches {
  projectId: string;
  current: { branch: string | null; head: string | null; detached: boolean };
  branches: PhoneGitBranch[];
  truncated: boolean;
}

export const PHONE_GIT_MAX_PROJECTS = 50;
export const PHONE_GIT_MAX_BRANCHES = 200;

// ── Worktree creation ─────────────────────────────────────────────────────────

/** Lowercase letters, digits and single hyphens; 1–40 chars; no leading/trailing hyphen. */
export const PHONE_WORKTREE_SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;
/** Branch namespace for phone-created worktrees. */
export const PHONE_WORKTREE_BRANCH_PREFIX = 'phone/';
/** Directory prefix inside `${wmuxHome}/worktrees/<projectId>/`; the desktop scan lists these as `phone-worktree`. */
export const PHONE_WORKTREE_DIR_PREFIX = 'phone-';
/** Case-insensitive on input (iOS `UUID().uuidString` is uppercase); the parser lowercases it. */
export const PHONE_WORKTREE_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PhoneWorktreeCreateBody { slug: string; requestId: string }

export function parseWorktreeCreateBody(body: unknown):
  { ok: true; value: PhoneWorktreeCreateBody } | { ok: false; error: 'invalid-slug' | 'invalid-git-request' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid-git-request' };
  const o = body as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'slug' && k !== 'requestId')) return { ok: false, error: 'invalid-git-request' };
  if (typeof o.requestId !== 'string' || !PHONE_WORKTREE_REQUEST_ID.test(o.requestId)) return { ok: false, error: 'invalid-git-request' };
  if (typeof o.slug !== 'string' || !PHONE_WORKTREE_SLUG.test(o.slug)) return { ok: false, error: 'invalid-slug' };
  return { ok: true, value: { slug: o.slug, requestId: o.requestId.toLowerCase() } };
}

/** Server-derived names for a slug. `repoHash` is the project's `projectId`. */
export function phoneWorktreeNames(slug: string, repoHash: string): { branch: string; relativeDir: string } {
  return { branch: `${PHONE_WORKTREE_BRANCH_PREFIX}${slug}`, relativeDir: `worktrees/${repoHash}/${PHONE_WORKTREE_DIR_PREFIX}${slug}` };
}

/** Synchronous POST refusals (the request never reaches the background job). */
export type PhoneWorktreeRequestError =
  | 'invalid-slug' | 'invalid-git-request' | 'request-id-conflict' | 'git-busy' | 'git-receipts-unavailable';

/** Refusals the background job records in the receipt (`state: "refused"`). */
export type PhoneWorktreeRefusal =
  | 'not-a-git-repo' | 'unborn-head' | 'branch-exists' | 'branch-namespace-blocked' | 'worktree-path-exists'
  | 'path-too-long' | 'submodules-unsupported' | 'git-filters-require-desktop' | 'git-operation-in-progress'
  | 'git-operation-failed' | 'worktree-path-unsafe' | 'git-version-unsupported';

/** `GET …/git/worktree/<requestId>`. `none`: no receipt for this caller and id. */
export type PhoneWorktreeReceiptState = 'pending' | 'created' | 'refused' | 'unknown' | 'none';

/**
 * The one receipt shape: the GET answer, and (with `replayed: true`) the
 * answer to a repeated POST. The first POST answers 202
 * `{requestId, replayed:false, state:"pending"}`.
 */
export interface PhoneWorktreeReceipt {
  requestId: string;
  replayed?: boolean;
  state: PhoneWorktreeReceiptState;
  /** `created` only. */
  projectId?: string;
  branch?: string;
  /** The commit the branch starts at: the session's HEAD, resolved once before any write. */
  base?: string;
  /** Absolute directory of the new worktree, server-derived. */
  cwd?: string;
  /** Last path segment, for display. */
  leaf?: string;
  /** `refused`: a PhoneWorktreeRefusal. `unknown`: `git-outcome-unknown`. */
  error?: PhoneWorktreeRefusal | 'git-outcome-unknown';
  /**
   * `unknown` only: the interrupted checkout is still being written (on
   * Windows it can outlive a daemon restart), so nothing was touched. Repeat
   * the same POST after this many milliseconds.
   */
  retryAfterMs?: number;
}

/** The `retryAfterMs` of an `unknown` receipt whose checkout is still being written. */
export const PHONE_WORKTREE_RETRY_AFTER_MS = 5_000;

/** Receipt lifetime, from creation. */
export const PHONE_WORKTREE_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The fixed argv after the hardened `-c` prefix. The base is an oid resolved
 * once before anything is written, and `--` ends option parsing before the
 * directory.
 */
export function phoneWorktreeAddArgs(branch: string, dir: string, baseOid: string): string[] {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseOid)) throw new Error('base must be a full object id');
  return ['worktree', 'add', '-b', branch, '--', dir, baseOid];
}

// ── CI checks ─────────────────────────────────────────────────────────────────

export type PhoneCheckState =
  | 'queued' | 'in_progress' | 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled'
  | 'timed_out' | 'action_required' | 'stale' | 'error' | 'pending' | 'unknown';

export interface PhoneCheck {
  kind: 'check-run' | 'status';
  name: string;
  state: PhoneCheckState;
  workflow?: string;
  /** Only a https://github.com/ URL; any other host is dropped. */
  url?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface PhoneCheckSummary {
  overall: 'success' | 'failure' | 'pending' | 'none';
  counts: { total: number; passed: number; failed: number; pending: number; skipped: number };
  checks: PhoneCheck[];
  truncated: boolean;
}

export const PHONE_MAX_CHECKS = 100;

const PASSED = new Set<PhoneCheckState>(['success', 'neutral']);
const SKIPPED = new Set<PhoneCheckState>(['skipped']);
/**
 * `unknown` is a finished check (or a status context) whose result this
 * daemon cannot read. It counts as failed, so `overall` is never `success`
 * over a result nobody could read. A check that has not finished is never
 * `unknown`: an unrecognized in-flight status reads `pending`.
 */
const PENDING = new Set<PhoneCheckState>(['queued', 'in_progress', 'pending']);
const CONCLUSIONS: Readonly<Record<string, PhoneCheckState>> = {
  SUCCESS: 'success', FAILURE: 'failure', NEUTRAL: 'neutral', SKIPPED: 'skipped', CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out', ACTION_REQUIRED: 'action_required', STALE: 'stale', STARTUP_FAILURE: 'failure',
};
const CONTEXT_STATES: Readonly<Record<string, PhoneCheckState>> = {
  SUCCESS: 'success', FAILURE: 'failure', ERROR: 'error', PENDING: 'pending', EXPECTED: 'pending',
};

const time = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || !v || v.startsWith('0001-')) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};
/** A link the phone may open: parsed, origin exactly https://github.com, no credentials, no whitespace or controls. */
export function githubUrl(v: unknown): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f\u007f-\u009f]/.test(v)) return undefined;
  let url: URL;
  try { url = new URL(v); } catch { return undefined; }
  if (url.origin !== 'https://github.com' || url.username || url.password) return undefined;
  return url.href;
}
const text = (v: unknown, max: number): string | undefined => sanitizeDisplayText(v, max);

/** One `statusCheckRollup` entry from `gh pr view --json statusCheckRollup` (CheckRun or StatusContext). */
export function projectCheck(row: unknown): PhoneCheck | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (r.__typename === 'CheckRun') {
    const name = text(r.name, 200);
    if (!name) return null;
    const status = typeof r.status === 'string' ? r.status : '';
    const state: PhoneCheckState = status === 'COMPLETED'
      ? (typeof r.conclusion === 'string' && ownLookup(CONCLUSIONS, r.conclusion)) || 'unknown'
      : status === 'IN_PROGRESS' ? 'in_progress'
        : ['QUEUED', 'WAITING', 'PENDING', 'REQUESTED'].includes(status) ? 'queued' : 'pending';
    const workflow = text(r.workflowName, 200);
    const url = githubUrl(r.detailsUrl);
    const startedAt = time(r.startedAt);
    const completedAt = time(r.completedAt);
    return { kind: 'check-run', name, state, ...(workflow ? { workflow } : {}), ...(url ? { url } : {}),
      ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}) };
  }
  if (r.__typename === 'StatusContext') {
    const name = text(r.context, 200);
    if (!name) return null;
    const url = githubUrl(r.targetUrl);
    const startedAt = time(r.startedAt);
    return { kind: 'status', name, state: (typeof r.state === 'string' && ownLookup(CONTEXT_STATES, r.state)) || 'unknown',
      ...(url ? { url } : {}), ...(startedAt ? { startedAt } : {}) };
  }
  return null;
}

/** `counts` and `overall` cover the whole rollup; only `checks` is cut to PHONE_MAX_CHECKS. */
export function summarizeChecks(rollup: unknown): PhoneCheckSummary {
  const rows = Array.isArray(rollup) ? rollup : [];
  const all = rows.map(projectCheck).filter((c): c is PhoneCheck => c !== null);
  const counts = { total: all.length, passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const c of all) {
    if (PASSED.has(c.state)) counts.passed += 1;
    else if (SKIPPED.has(c.state)) counts.skipped += 1;
    else if (PENDING.has(c.state)) counts.pending += 1;
    else counts.failed += 1;
  }
  const overall = counts.total === 0 ? 'none' : counts.failed > 0 ? 'failure' : counts.pending > 0 ? 'pending' : 'success';
  return { overall, counts, checks: all.slice(0, PHONE_MAX_CHECKS), truncated: all.length > PHONE_MAX_CHECKS };
}
