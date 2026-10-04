// What a pull request needs next, in words, from its list summary. The most
// blocking condition wins: a failing check or a conflict before a review, a
// review before "approved".

import type { PrSummary } from './prSurface';

export type PrNextStep =
  | 'merged'
  | 'closed'
  | 'draft'
  | 'ci-failing'
  | 'conflicts'
  | 'changes-requested'
  | 'ci-running'
  | 'review-requested'
  | 'approved-mergeable'
  | 'approved'
  | 'open';

/** Steps that are something broken (the UI may draw them as an error). */
export const PR_STEP_IS_PROBLEM: ReadonlySet<PrNextStep> = new Set(['ci-failing', 'conflicts']);

export function prNextStep(pr: Pick<PrSummary, 'state' | 'checks' | 'mergeable' | 'reviewDecision'>): PrNextStep {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.state === 'draft') return 'draft';
  if (pr.checks === 'failing') return 'ci-failing';
  if (pr.mergeable === 'CONFLICTING') return 'conflicts';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  if (pr.checks === 'pending') return 'ci-running';
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'review-requested';
  if (pr.reviewDecision === 'APPROVED') return pr.mergeable === 'MERGEABLE' ? 'approved-mergeable' : 'approved';
  return 'open';
}
