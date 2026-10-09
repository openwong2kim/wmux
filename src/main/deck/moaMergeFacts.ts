// ─── Moa's merge facts — the PrMergeFacts a pr.merge decision carries (pure) ─
//
// The same object the phone merge preview answers, minus the confirm grant, so
// one sheet shows both. Built from the lane read the verdict was decided on
// (PrLaneFacts) plus what that read does not hold: the title and mergeable
// (a PR head read), squash permission (a repo read) and the gh login Moa
// merges as. Display only: the executor reads the PR again before any merge,
// and an owner answer on another head is refused as `stale`.

import type { PrMergeChecks, PrMergeFacts } from '../../shared/phoneGitWrite';
import { mergeBlock, squashSubject, type PrLaneFacts } from '../../shared/prReview';

/** What the lane read lacks, read beside it. */
export interface MergeFactsExtras {
  /** The head the extra read saw; facts are dropped when it is not the lane's. */
  headRefOid: string;
  title: string;
  mergeable: string;
  squashAllowed: boolean;
  /** The gh login a Moa merge goes out as. */
  login: string;
}

/** Overall state and counts in the phone's check-summary vocabulary. */
export function laneChecksSummary(lane: PrLaneFacts): PrMergeChecks {
  const counts = { total: lane.checks.length, passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const c of lane.checks) {
    if (c.bucket === 'pass') counts.passed += 1;
    else if (c.bucket === 'skipping') counts.skipped += 1;
    else if (c.bucket === 'pending') counts.pending += 1;
    else counts.failed += 1;
  }
  const overall = counts.total === 0 ? 'none' : counts.failed > 0 ? 'failure' : counts.pending > 0 ? 'pending' : 'success';
  // A truncated rollup cannot list every required check: omit both lists.
  if (lane.checksTruncated) return { overall, counts };
  const required = lane.checks.filter((c) => c.isRequired === true);
  return {
    overall,
    counts,
    requiredFailing: required.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name),
    requiredPending: required.filter((c) => c.bucket === 'pending').map((c) => c.name),
  };
}

/** The decision's facts, or null when the extra read is about another head. */
export function buildMergeFacts(lane: PrLaneFacts, extras: MergeFactsExtras): PrMergeFacts | null {
  if (extras.headRefOid !== lane.headRefOid) return null;
  const mergeStateStatus = lane.mergeStateStatus ?? 'UNKNOWN';
  const block = mergeBlock({
    number: lane.number,
    title: extras.title,
    url: '',
    state: lane.state,
    isDraft: lane.isDraft,
    headRefOid: lane.headRefOid,
    headRefName: lane.headRefName,
    baseRefName: lane.baseRefName,
    mergeable: extras.mergeable,
    mergeStateStatus,
  }, lane.checks);
  return {
    number: lane.number,
    title: extras.title,
    state: lane.state,
    isDraft: lane.isDraft,
    headRefOid: lane.headRefOid,
    headRefName: lane.headRefName,
    baseRefName: lane.baseRefName,
    mergeable: extras.mergeable,
    mergeStateStatus,
    block,
    squashAllowed: extras.squashAllowed,
    checks: laneChecksSummary(lane),
    methods: ['squash'],
    // What the executor merges with: GitHub's squash subject and an empty body.
    subject: squashSubject(extras.title, lane.number),
    body: '',
    identity: { login: extras.login },
  };
}
