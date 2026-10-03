// ─── The PR owner nudge: kinds and the one-line template ─────────────────────
//
// A pane whose checkout is a PR's head branch is told, in one fixed line, that
// something happened on that PR (CI failed, a merge conflict, a review comment
// from someone else, checks passed). Same shape and the same two checks as the
// fan-out caller nudge (shared/fanoutCallerNudge): the line is fixed text plus
// a PR number, never a log line or a comment body, and anything that does not
// match the template is refused in main and again in the daemon.
//
// One line per pane: when the same pane also has fan-out pointers queued, the
// PR clauses come first and the fan-out body follows after `; `.

import { buildFanoutCallerNudge, FANOUT_CALLER_BODY_SOURCE } from './fanoutCallerNudge';

export type PrOwnerKind = 'pr.ci_failed' | 'pr.merge_conflict' | 'pr.review_comment' | 'pr.checks_passed';

/** Most severe first; checks passed is the low-priority pointer. */
export const PR_OWNER_KINDS: readonly PrOwnerKind[] = [
  'pr.ci_failed',
  'pr.merge_conflict',
  'pr.review_comment',
  'pr.checks_passed',
];

export function isPrOwnerKind(v: unknown): v is PrOwnerKind {
  return typeof v === 'string' && (PR_OWNER_KINDS as readonly string[]).includes(v);
}

/**
 * Which pending slot a kind fills for one PR. CI failed and checks passed are
 * two answers to the same question, so the newer replaces the older.
 */
export function prOwnerSlot(kind: PrOwnerKind): 'ci' | 'conflict' | 'review' {
  return kind === 'pr.ci_failed' || kind === 'pr.checks_passed' ? 'ci' : kind === 'pr.merge_conflict' ? 'conflict' : 'review';
}

const PHRASE: Record<PrOwnerKind, string> = {
  'pr.ci_failed': 'CI failed',
  'pr.merge_conflict': 'merge conflict',
  'pr.review_comment': 'new review comment',
  'pr.checks_passed': 'checks passed, ready for review',
};

const COMMAND: Record<PrOwnerKind, (n: number) => string> = {
  'pr.ci_failed': (n) => `gh pr checks ${n}`,
  'pr.merge_conflict': (n) => `gh pr view ${n}`,
  'pr.review_comment': (n) => `gh pr view ${n} --comments`,
  'pr.checks_passed': (n) => `gh pr view ${n}`,
};

const LISTED_CLAUSES = 4;
const PREFIX = '[wmux] ';

export function isPrNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 10_000_000;
}

function prBody(items: readonly { prNumber: number; kind: PrOwnerKind }[]): string {
  const sorted = items
    .filter((i) => isPrNumber(i.prNumber) && isPrOwnerKind(i.kind))
    .sort((a, b) => PR_OWNER_KINDS.indexOf(a.kind) - PR_OWNER_KINDS.indexOf(b.kind) || a.prNumber - b.prNumber);
  const clauses = sorted
    .slice(0, LISTED_CLAUSES)
    .map((i) => `PR #${i.prNumber}: ${PHRASE[i.kind]} — ${COMMAND[i.kind](i.prNumber)}`);
  if (sorted.length > LISTED_CLAUSES) clauses.push(`+${sorted.length - LISTED_CLAUSES} more PR events`);
  return clauses.join('; ');
}

/**
 * One line for everything queued for one pane. Examples:
 *   [wmux] PR #123: CI failed — gh pr checks 123
 *   [wmux] PR #123: CI failed — gh pr checks 123; fan-out task 6k7g7szw updated — channel_mission_list
 */
export function buildCallerNudge(
  fanout: readonly Parameters<typeof buildFanoutCallerNudge>[0][number][],
  pr: readonly { prNumber: number; kind: PrOwnerKind }[],
): string {
  const body = pr.length > 0 ? prBody(pr) : '';
  if (!body) return buildFanoutCallerNudge(fanout);
  if (fanout.length === 0) return `${PREFIX}${body}`;
  return `${PREFIX}${body}; ${buildFanoutCallerNudge(fanout).slice(PREFIX.length)}`;
}

const N = '[1-9]\\d{0,6}';
const PR_CLAUSE = `(?:${PR_OWNER_KINDS.map((k) => `PR #${N}: ${PHRASE[k]} — ${COMMAND[k](0).replace(' 0', ` ${N}`)}`).join('|')})`;
const PR_BODY = `${PR_CLAUSE}(?:; ${PR_CLAUSE}){0,${LISTED_CLAUSES - 1}}(?:; \\+\\d{1,4} more PR events)?`;
const LINE = new RegExp(`^\\[wmux\\] (?:${PR_BODY}(?:; ${FANOUT_CALLER_BODY_SOURCE})?|${FANOUT_CALLER_BODY_SOURCE})$`);

/** True only for a line `buildCallerNudge` can produce (PR, fan-out or both). */
export function isCallerNudge(text: unknown): text is string {
  return typeof text === 'string' && text.length <= 900 && LINE.test(text);
}

/** The PR numbers a valid line names, so main can check each against the pane. */
export function prNumbersInNudge(text: string): number[] {
  if (!isCallerNudge(text)) return [];
  const out: number[] = [];
  for (const m of text.matchAll(/PR #(\d+): /g)) out.push(Number(m[1]));
  return out;
}
