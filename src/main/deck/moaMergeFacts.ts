// ─── Moa's merge facts — the PrMergeFacts a pr.merge decision carries (pure) ─
//
// The same object the phone merge preview answers, minus the confirm grant, so
// one sheet shows both. Built from the lane read the verdict was decided on
// (PrLaneFacts) plus what that read does not hold: the title and mergeable
// (a PR head read), squash permission (a repo read) and the gh login Moa
// merges as. Display only: the executor reads the PR again before any merge,
// and an owner answer on another head is refused as `stale`.

import type { PrMergeChecks, PrMergeFacts } from '../../shared/phoneGitWrite';
import { mergeBlock, squashSubject, type MergeBlock, type PrLaneFacts } from '../../shared/prReview';

/** Blocks a truncated check rollup turns into `checks-pending`. */
const UNSETTLED_OVERRIDES: ReadonlySet<MergeBlock | null> = new Set<MergeBlock | null>([null, 'behind', 'blocked', 'unknown']);

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

/** The squash subject a Moa merge uses, and the one its card shows: GitHub's
 *  default (whitespace collapsed), with a fallback for an empty title. */
export function moaMergeSubject(title: string, number: number): string {
  return squashSubject(title.trim() ? title : `Pull request #${number}`, number);
}

/**
 * Overall state and counts in the phone's check-summary vocabulary. A
 * truncated rollup (the lane's `checks-truncated`) vouches for no count and no
 * required list: overall is `failure` when a visible check failed, else
 * `pending`, and `counts` is empty.
 */
export function laneChecksSummary(lane: PrLaneFacts): PrMergeChecks {
  const failedSeen = lane.checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  if (lane.checksTruncated) return { overall: failedSeen ? 'failure' : 'pending', counts: {} };
  const counts = { total: lane.checks.length, passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const c of lane.checks) {
    if (c.bucket === 'pass') counts.passed += 1;
    else if (c.bucket === 'skipping') counts.skipped += 1;
    else if (c.bucket === 'pending') counts.pending += 1;
    else counts.failed += 1;
  }
  const overall = counts.total === 0 ? 'none' : counts.failed > 0 ? 'failure' : counts.pending > 0 ? 'pending' : 'success';
  const required = lane.checks.filter((c) => c.isRequired === true);
  return {
    overall,
    counts,
    requiredFailing: required.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name),
    requiredPending: required.filter((c) => c.bucket === 'pending').map((c) => c.name),
  };
}

/** A value read at most once per `ttlMs` per key; a null read is not kept. */
export function ttlReader<A, T>(read: (arg: A) => Promise<T | null>, keyOf: (arg: A) => string, ttlMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { value: T; at: number }>();
  return async (arg: A): Promise<T | null> => {
    const key = keyOf(arg);
    const hit = hits.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await read(arg);
    if (value === null) hits.delete(key);
    else hits.set(key, { value, at: now() });
    return value;
  };
}

/** The decision's facts, or null when the extra read is about another head. */
export function buildMergeFacts(lane: PrLaneFacts, extras: MergeFactsExtras): PrMergeFacts | null {
  if (extras.headRefOid !== lane.headRefOid) return null;
  const mergeStateStatus = lane.mergeStateStatus ?? 'UNKNOWN';
  let block = mergeBlock({
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
  // Checks the read could not list may still be running: never call that
  // mergeable. A stronger block stays. The phone preview applies the same rule.
  if (lane.checksTruncated && UNSETTLED_OVERRIDES.has(block)) block = 'checks-pending';
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
    // What the executor merges with (moaMergeSubject) and an empty body.
    subject: moaMergeSubject(extras.title, lane.number),
    body: '',
    identity: { login: extras.login },
  };
}
