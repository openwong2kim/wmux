/**
 * Phone Git v1: read-only projects and branches, worktree creation, CI checks
 * (docs/phone-client-contract.md, "Proposed: contract v-next", item 5).
 * CONTRACT ONLY: no route serves these yet.
 *
 * Every request names a session. The daemon derives the repository from that
 * session's trusted `spawnCwd`; the phone never sends a path, a ref or a
 * refspec. Push and PR creation are not in v1.
 */

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
/** Directory prefix inside `${wmuxHome}/worktrees/<repoHash>/`, so the desktop task scanner can tell these apart. */
export const PHONE_WORKTREE_DIR_PREFIX = 'phone-';
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PhoneWorktreeCreateBody { slug: string; requestId: string }

export function parseWorktreeCreateBody(body: unknown):
  { ok: true; value: PhoneWorktreeCreateBody } | { ok: false; error: 'invalid-slug' | 'invalid-git-request' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid-git-request' };
  const o = body as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'slug' && k !== 'requestId')) return { ok: false, error: 'invalid-git-request' };
  if (typeof o.requestId !== 'string' || !REQUEST_ID.test(o.requestId)) return { ok: false, error: 'invalid-git-request' };
  if (typeof o.slug !== 'string' || !PHONE_WORKTREE_SLUG.test(o.slug)) return { ok: false, error: 'invalid-slug' };
  return { ok: true, value: { slug: o.slug, requestId: o.requestId } };
}

/** Server-derived names for a slug. `repoHash` is the project's `projectId`. */
export function phoneWorktreeNames(slug: string, repoHash: string): { branch: string; relativeDir: string } {
  return { branch: `${PHONE_WORKTREE_BRANCH_PREFIX}${slug}`, relativeDir: `worktrees/${repoHash}/${PHONE_WORKTREE_DIR_PREFIX}${slug}` };
}

export type PhoneWorktreeRefusal =
  | 'invalid-slug' | 'invalid-git-request' | 'not-a-git-repo' | 'branch-exists' | 'branch-namespace-blocked'
  | 'worktree-path-exists' | 'path-too-long' | 'git-filters-require-desktop' | 'git-operation-in-progress'
  | 'unborn-head' | 'request-id-conflict' | 'git-outcome-unknown' | 'git-busy' | 'git-operation-failed';

/** `GET …/git/worktree/<requestId>`. `none`: no receipt for this caller and id. */
export type PhoneWorktreeReceiptState = 'pending' | 'created' | 'refused' | 'unknown' | 'none';

export interface PhoneWorktreeCreated {
  requestId: string;
  replayed: boolean;
  projectId: string;
  branch: string;
  /** The commit the branch starts at: the session's HEAD when the request ran. */
  base: string;
  /** Absolute directory of the new worktree, server-derived. */
  cwd: string;
  /** Last path segment, for display. */
  leaf: string;
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
/** `unknown` is not a verdict, so it never counts as failed. */
const PENDING = new Set<PhoneCheckState>(['queued', 'in_progress', 'pending', 'unknown']);
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
const githubUrl = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= 2048 && v.startsWith('https://github.com/') ? v : undefined;
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** One `statusCheckRollup` entry from `gh pr view --json statusCheckRollup` (CheckRun or StatusContext). */
export function projectCheck(row: unknown): PhoneCheck | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (r.__typename === 'CheckRun') {
    const name = text(r.name, 200);
    if (!name) return null;
    const status = typeof r.status === 'string' ? r.status : '';
    const state: PhoneCheckState = status === 'COMPLETED'
      ? CONCLUSIONS[typeof r.conclusion === 'string' ? r.conclusion : ''] ?? 'unknown'
      : status === 'IN_PROGRESS' ? 'in_progress'
        : ['QUEUED', 'WAITING', 'PENDING', 'REQUESTED'].includes(status) ? 'queued' : 'unknown';
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
    return { kind: 'status', name, state: CONTEXT_STATES[typeof r.state === 'string' ? r.state : ''] ?? 'unknown',
      ...(url ? { url } : {}), ...(startedAt ? { startedAt } : {}) };
  }
  return null;
}

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
