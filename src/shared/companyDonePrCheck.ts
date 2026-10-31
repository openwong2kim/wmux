// Company mode: before a company task is marked done, wmux reads every GitHub
// PR the task names and refuses the done until each one is merged, or open and
// ready: the required checks green on its current head, no open review
// threads, no conflicts, not behind its base. Pure, so the rule is tested
// without gh; main (pipe/handlers/a2a.rpc.ts) does the reads through
// GhPrReviewService.donePrFacts.
//
// A required check that never ran on the head leaves no entry in the PR's
// check rollup, so "every check in the rollup passed" can be true while GitHub
// still blocks the merge. The required names come from the base branch's rules
// (branch protection and rulesets) as well as from the rollup's isRequired.
//
// GitLab merge request URLs are not checked yet: only GitHub-shaped pull URLs
// (https://<host>/<owner>/<repo>/pull/<n>) are collected.
import { EVIDENCE_MAX_ITEMS } from './completionEvidence';
import type { PrCheck } from './prReview';
import type { EvidenceItem } from './types';
import { prUrlParts, refKey } from './workLink';

/** The most PRs one done is checked against; a task naming more is refused. */
export const DONE_PR_CHECK_MAX = 10;

/** One PR a task names: the URL as written, and its parts. */
export interface DonePrRef {
  url: string;
  host: string;
  owner: string;
  repo: string;
  number: number;
}

/** What wmux reads of one PR for a done (GhPrReviewService.donePrFacts). */
export interface DonePrFacts {
  /** OPEN, CLOSED or MERGED. */
  state: string;
  isDraft: boolean;
  merged: boolean;
  /** The commit the merge made, or null while not merged. */
  mergeCommitOid: string | null;
  headRefOid: string;
  baseRefName: string;
  /** MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
  /** CLEAN, DIRTY, BLOCKED, BEHIND, UNSTABLE, HAS_HOOKS, DRAFT or UNKNOWN. */
  mergeStateStatus: string;
  /** APPROVED, CHANGES_REQUESTED or REVIEW_REQUIRED; '' when none applies. */
  reviewDecision: string;
  /** The commit the checks were read on (the PR's last commit), or null. */
  checksHeadOid: string | null;
  /** That commit's checks, each with `isRequired`. */
  checks: PrCheck[];
  /** More checks ran on that commit than were read. */
  checksTruncated: boolean;
  /** `total`: null when GitHub gave no count. */
  threads: { total: number | null; read: number; unresolved: number };
  /** Required check names from the base branch's branch protection and rulesets. */
  baseRequired: string[];
  /** The base branch rule sources that could not be read. */
  baseRequiredUnread: string[];
}

export type DonePrVerdict =
  /** `sha`: the head checked, or the merge commit of a merged PR. */
  | { kind: 'pass'; sha: string; summary: string }
  /** Closed without a merge: not part of the done. */
  | { kind: 'skip' }
  | { kind: 'block'; reason: string };

/** One PR's read: the facts, or gh's error. */
export type DonePrOutcome =
  | { pr: DonePrRef; read: 'ok'; facts: DonePrFacts }
  | { pr: DonePrRef; read: 'error'; message: string };

export type CompanyDonePrDecision =
  | { kind: 'pass'; items: EvidenceItem[] }
  | { kind: 'refuse'; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// A URL runs to whitespace or a character that cannot be part of one here:
// markdown and quoting brackets, quotes, backticks, and a JSON escape.
const URL_TOKEN = /https:\/\/[^\s<>()[\]{}"'`\\]+/gi;
// Sentence punctuation and markdown emphasis after the URL.
const TRAILING = /[.,;:!?*_~]+$/;
// A link into a PR (its files tab, a comment, a query) names that PR.
const PR_BASE = /^(https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+)(?:[/?#].*)?$/i;

function prRefsInText(text: string): DonePrRef[] {
  return [...text.matchAll(URL_TOKEN)].flatMap((m): DonePrRef[] => {
    const token = m[0].replace(TRAILING, '');
    const url = PR_BASE.exec(token)?.[1] ?? token;
    const parts = prUrlParts(url);
    return parts ? [{ url, ...parts }] : [];
  });
}

/** The text a message carries: its text parts and its data parts as JSON. */
function messageTexts(m: unknown): string[] {
  if (!isRecord(m) || !Array.isArray(m.parts)) return [];
  return m.parts.flatMap((p): string[] => {
    if (!isRecord(p)) return [];
    if (p.kind === 'text' && typeof p.text === 'string') return [p.text];
    if (p.kind === 'data' && p.data !== undefined) {
      try {
        return [JSON.stringify(p.data)];
      } catch {
        return [];
      }
    }
    return [];
  });
}

/** The text of the done call's evidence: its summary, and each item's summary, location and output. */
function evidenceTexts(ev: unknown): string[] {
  if (!isRecord(ev)) return [];
  const out = typeof ev.summary === 'string' ? [ev.summary] : [];
  for (const it of Array.isArray(ev.items) ? ev.items : []) {
    if (!isRecord(it)) continue;
    for (const k of ['summary', 'location', 'output']) if (typeof it[k] === 'string') out.push(it[k] as string);
  }
  return out;
}

/**
 * Every GitHub PR a company task names, once each (by refKey), in the order
 * first named: in its messages after the first (the brief, which may cite
 * unrelated PRs), its current status message, and the done call's own message
 * and evidence.
 */
export function donePrRefs(input: {
  history: readonly unknown[];
  statusMessage?: unknown;
  message?: unknown;
  evidence?: unknown;
}): DonePrRef[] {
  const texts = [
    ...input.history.slice(1).flatMap(messageTexts),
    ...messageTexts(input.statusMessage),
    ...(typeof input.message === 'string' ? [input.message] : []),
    ...evidenceTexts(input.evidence),
  ];
  const seen = new Set<string>();
  const out: DonePrRef[] = [];
  for (const ref of texts.flatMap(prRefsInText)) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

const short = (sha: string): string => sha.slice(0, 7);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** When a check started; one not started yet is the newest. */
function startedMs(c: PrCheck): number {
  const t = c.startedAt ? Date.parse(c.startedAt) : NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** The newest check of each name: reruns leave the older runs in the rollup. */
function newestByName(checks: readonly PrCheck[]): Map<string, PrCheck> {
  const out = new Map<string, PrCheck>();
  for (const c of checks) {
    const prev = out.get(c.name);
    // A tie goes to the later entry.
    if (!prev || startedMs(c) >= startedMs(prev)) out.set(c.name, c);
  }
  return out;
}

/** Passed: a check run that completed with success, neutral or skipped, or a
 *  status that is success. Cancelled counts as failed. */
function checkOutcome(c: PrCheck): 'pass' | 'pending' | 'fail' {
  if (c.bucket === 'pass' || c.bucket === 'skipping') return 'pass';
  return c.bucket === 'pending' ? 'pending' : 'fail';
}

/**
 * One PR against a done: pass (merged, or open and ready), skip (closed
 * without a merge), or block with the first reason. A merge state GitHub has
 * not worked out yet (UNKNOWN) never blocks on its own: the required checks
 * are checked directly.
 */
export function donePrVerdict(pr: DonePrRef, f: DonePrFacts): DonePrVerdict {
  const name = `${pr.owner}/${pr.repo}#${pr.number}`;
  if (f.merged || f.state === 'MERGED') {
    const sha = f.mergeCommitOid || f.headRefOid;
    return { kind: 'pass', sha, summary: `wmux checked ${name}: merged as ${short(sha)}` };
  }
  if (f.state === 'CLOSED') return { kind: 'skip' };
  const block = (reason: string): DonePrVerdict => ({ kind: 'block', reason });
  if (f.state !== 'OPEN') return block(`GitHub reports it as ${f.state || 'unreadable'}`);
  const base = f.baseRefName || 'its base';
  const head = short(f.headRefOid);
  if (f.isDraft) return block('it is a draft');
  if (f.mergeable === 'CONFLICTING' || f.mergeStateStatus === 'DIRTY') return block(`it has conflicts with ${base}`);
  if (f.mergeStateStatus === 'BEHIND') return block(`it is behind ${base}; update the branch`);
  if (f.checksHeadOid !== f.headRefOid) return block(`its checks are for an older commit than the head ${head}`);
  const required = [...new Set([...f.baseRequired, ...f.checks.filter((c) => c.isRequired).map((c) => c.name)])]
    .filter(Boolean);
  const newest = newestByName(f.checks);
  for (const check of required) {
    const c = newest.get(check);
    if (!c) {
      return block(f.checksTruncated
        ? `wmux read only part of the checks on ${head} and required check '${check}' is not among them`
        : `required check '${check}' has not run on ${head}`);
    }
    const outcome = checkOutcome(c);
    if (outcome === 'pending') return block(`'${check}' is still running`);
    if (outcome === 'fail') return block(`'${check}' failed`);
  }
  if (f.threads.unresolved > 0) return block(`${plural(f.threads.unresolved, 'review thread', 'review threads')} still open`);
  if (f.threads.total === null) return block('wmux could not count its review threads');
  if (f.threads.total > f.threads.read) {
    return block(`it has ${f.threads.total} review threads and wmux read only ${f.threads.read}`);
  }
  let notes = '';
  if (f.mergeStateStatus === 'BLOCKED') {
    if (f.reviewDecision === 'CHANGES_REQUESTED') return block('a reviewer requested changes');
    if (f.reviewDecision !== 'REVIEW_REQUIRED') {
      return block('GitHub blocks the merge for a reason wmux cannot see; check the branch rules');
    }
    // A required check that never ran shows nowhere but the base branch's
    // list, so without that list the review cannot be the only reason.
    if (f.baseRequiredUnread.length > 0) {
      return block(`GitHub blocks the merge and wmux could not read the base branch's ${f.baseRequiredUnread.join(' or ')} to rule out a required check that never ran`);
    }
    notes += '; waits on an approving review';
  }
  if (f.baseRequiredUnread.length > 0) notes += `; could not read the base branch's ${f.baseRequiredUnread.join(' or ')}`;
  return {
    kind: 'pass',
    sha: f.headRefOid,
    summary: `wmux checked ${name} at ${head}: ${plural(required.length, 'required check', 'required checks')} passed, `
      + `0 open review threads, GitHub ${f.mergeStateStatus || 'UNKNOWN'}${notes}`,
  };
}

const TAIL = 'the owner can mark the task done from their own lane.';

/** gh's error, on one line and short. */
function shortError(message: string): string {
  const one = message.replace(/\s+/g, ' ').trim();
  return (one.length > 200 ? `${one.slice(0, 199)}…` : one) || 'no answer';
}

/**
 * The done against every PR the task names: pass with one verified
 * inspection item per passing PR, or a refusal that names the first PR that
 * blocks (or could not be read) and how many more did not pass. A PR closed
 * without a merge is left out, unless every PR is.
 */
export function companyDonePrDecision(outcomes: readonly DonePrOutcome[]): CompanyDonePrDecision {
  const failures: string[] = [];
  const items: EvidenceItem[] = [];
  let closed = 0;
  for (const o of outcomes) {
    if (o.read === 'error') {
      failures.push(`wmux could not check ${o.pr.url} through gh: ${shortError(o.message)}. Retry, or ${TAIL}`);
      continue;
    }
    const v = donePrVerdict(o.pr, o.facts);
    if (v.kind === 'block') failures.push(`wmux checked ${o.pr.url} and it is not done yet: ${v.reason}. Fix it, or ${TAIL}`);
    else if (v.kind === 'skip') closed += 1;
    else items.push({ kind: 'inspection', status: 'verified', summary: v.summary, location: o.pr.url });
  }
  if (failures.length > 0) {
    const more = failures.length - 1;
    const others = more > 0 ? ` ${plural(more, 'more PR', 'more PRs')} the task names did not pass either.` : '';
    return { kind: 'refuse', error: `a2a.task.update: ${failures[0]}${others}` };
  }
  if (items.length === 0 && closed > 0) {
    return {
      kind: 'refuse',
      error: `a2a.task.update: wmux checked the PRs this task names and it is not done yet: every PR it names was closed without a merge. Fix it, or ${TAIL}`,
    };
  }
  return { kind: 'pass', items };
}

/** The refusal for a task that names more PRs than one done is checked against. */
export function tooManyDonePrs(count: number): string {
  return `a2a.task.update: this task names ${count} PRs and wmux checks at most ${DONE_PR_CHECK_MAX} before it is marked done; ${TAIL}`;
}

/**
 * The done call's evidence with wmux's items after the caller's, or a refusal
 * when together they would pass the evidence item limit.
 */
export function withDonePrEvidence<T extends { items: unknown[] }>(
  evidence: T,
  items: readonly EvidenceItem[],
): { ok: true; evidence: T } | { ok: false; error: string } {
  if (evidence.items.length + items.length > EVIDENCE_MAX_ITEMS) {
    return {
      ok: false,
      error: `a2a.task.update: wmux adds ${plural(items.length, 'evidence item', 'evidence items')} for the PRs it checked, `
        + `and with the ${evidence.items.length} sent that passes the limit of ${EVIDENCE_MAX_ITEMS}; send fewer items`,
    };
  }
  return { ok: true, evidence: { ...evidence, items: [...evidence.items, ...items] } };
}
