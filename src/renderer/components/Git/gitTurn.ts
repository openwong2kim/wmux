// ─── Git page: whose turn is it on each PR and issue ────────────────────────
//
// Puts every Git page item (a pull request or an issue) into exactly one
// "who acts next" section, so the page answers "what needs me" across repos.
// Pure: the caller passes the clock, the work links, a pane status lookup and
// the signed-in gh login; nothing here reads the store or calls gh.
//
// Why not GitHub's own fields: agents open PRs under the OWNER's GitHub
// account, so the author and "review requested" cannot say whose turn it is.
// The signals are the PR's own state (checks, mergeable, review decision,
// draft, merged / closed) and the item's work link to the pane doing it, read
// against that pane's live agent status.
//
// The item's link: the most recently updated link in an active state
// (queued, running, needs-you, blocked, review) whose PR (for a PR) or issue
// (for an issue) is this item — the same pick as the detail header's
// WhoActsNext, so the list and the header agree. "An agent is on it" means
// that link is queued, running or blocked AND its pane reports 'running'. A
// link whose pane is gone (lookup null), idle, finished, erroring or asking
// counts as nobody on it: a stale "running" link must not hide a red PR.
//
// Sections, first match wins:
//   settled            merged or closed. Within SETTLED_WINDOW_MS of `now` it
//                      shows; older returns null (dropped from the list, not
//                      counted). The time is `closedAt` when the caller has it,
//                      else `updatedAt`, which is never earlier than the merge
//                      or close, so "older than 24h" is always right and a
//                      late comment can only keep an item a little longer.
//                      An unreadable time shows rather than hides.
//   needs_you          the owner must act and nobody else is:
//                      - the link is needs-you (a decision or input), or its
//                        pane is awaiting input;
//                      - open PR with failing checks, a conflict or changes
//                        requested, and no agent on it;
//                      - open PR by another author (ghLogin known and not the
//                        author) not approved yet and no agent on it: the
//                        owner reviews it;
//                      - open PR that is otherwise clean but carries a signal
//                        that cannot be read as green: no checks reported
//                        (null), mergeable not reported (''), or review
//                        required on the owner's own PR (requested reviewers
//                        are not fetched, so "someone else will review" cannot
//                        be shown; the owner is the one known reviewer here);
//                      - open issue with no active link, or whose link's agent
//                        stopped, unless it is assigned only to others.
//   ready_to_merge     open (not draft) PR: checks passing, MERGEABLE, review
//                      APPROVED or not required (''). Merging is the owner's
//                      call in this project. This ranks above agents_on_it as
//                      specified, so a green PR with its agent still running
//                      reads as ready.
//   agents_on_it       an agent is on the item's link (see above), whatever
//                      the PR's CI says.
//   waiting_on_others  drafts; checks pending; mergeable UNKNOWN (GitHub is
//                      still computing it); an issue whose link is in review
//                      (its PR row carries the turn) or that is assigned to
//                      others only (the owner not among the assignees).
//
// Drafts: only a needs-you link or an asking pane pulls a draft into
// needs_you, and a working agent into agents_on_it; red CI on a draft waits.

import type { AgentStatus } from '../../../shared/types';
import { issueUrlParts } from '../../../shared/issueRef';
import type { IssueSummary } from '../../../shared/issueSurface';
import type { PrSummary } from '../../../shared/prSurface';
import { prUrlParts, refKey, type WorkLink, type WorkLinkParty, type WorkLinkState } from '../../../shared/workLink';

export type GitTurn = 'needs_you' | 'ready_to_merge' | 'agents_on_it' | 'waiting_on_others' | 'settled';

/** The sections, in the order the page shows them. */
export const GIT_TURN_ORDER: readonly GitTurn[] = ['needs_you', 'ready_to_merge', 'agents_on_it', 'waiting_on_others', 'settled'];

/** How long a merged or closed item stays in Settled. */
export const SETTLED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One Git page row. `closedAt` (ISO) is the merge or close time when the
 *  caller has it; the list summaries carry none today. */
export type GitTurnItem =
  | { kind: 'pr'; pr: PrSummary; closedAt?: string }
  | { kind: 'issue'; issue: IssueSummary; closedAt?: string };

export interface GitTurnContext {
  /** Epoch ms. */
  now: number;
  /** Work links of the shown repos; each item picks its own. */
  links: readonly WorkLink[];
  /** The live agent status of a link's pane (the workspace's when the link
   *  names no pane); null when the pane or workspace is gone. */
  paneStatus: (party: WorkLinkParty) => AgentStatus | null | undefined;
  /** The login gh is signed in as. Unknown (null / absent) treats every
   *  author as the owner. */
  ghLogin?: string | null;
}

const ACTIVE: ReadonlySet<WorkLinkState> = new Set<WorkLinkState>(['queued', 'running', 'needs-you', 'blocked', 'review']);

/** The item's host/owner/repo#n key, or null when its URL is not one. */
export function gitTurnItemKey(item: GitTurnItem): string | null {
  const parts = item.kind === 'pr' ? prUrlParts(item.pr.url) : issueUrlParts(item.issue.url);
  return parts ? refKey(parts) : null;
}

/** The item's link: the most recently updated active link about it. */
export function pickItemLink(item: GitTurnItem, links: readonly WorkLink[]): WorkLink | null {
  const key = gitTurnItemKey(item);
  if (!key) return null;
  let best: WorkLink | null = null;
  for (const l of links) {
    if (!ACTIVE.has(l.state)) continue;
    const ref = item.kind === 'pr' ? l.pr : l.issue;
    if (!ref || refKey(ref) !== key) continue;
    if (!best || l.updatedAt > best.updatedAt) best = l;
  }
  return best;
}

/** What the link's agent is doing: working on it, asking the owner, or nothing. */
export function linkAgent(link: WorkLink | null, ctx: Pick<GitTurnContext, 'paneStatus'>): 'working' | 'asking' | 'none' {
  if (!link) return 'none';
  if (link.state === 'needs-you') return 'asking';
  const status = ctx.paneStatus(link.owner);
  if (status === 'awaiting_input') return 'asking';
  const engaged = link.state === 'queued' || link.state === 'running' || link.state === 'blocked';
  return engaged && status === 'running' ? 'working' : 'none';
}

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Another author's PR: only when the gh login is known and the author is read. */
export function isExternalAuthor(author: string, ghLogin: string | null | undefined): boolean {
  return !!ghLogin && !!author && !sameLogin(author, ghLogin);
}

function settledOrDropped(at: string, now: number): GitTurn | null {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return 'settled';
  return now - ms <= SETTLED_WINDOW_MS ? 'settled' : null;
}

function classifyPr(pr: PrSummary, agent: 'working' | 'asking' | 'none', ctx: GitTurnContext): GitTurn {
  if (agent === 'asking') return 'needs_you';
  if (pr.state === 'draft') return agent === 'working' ? 'agents_on_it' : 'waiting_on_others';
  const broken = pr.checks === 'failing' || pr.mergeable === 'CONFLICTING' || pr.reviewDecision === 'CHANGES_REQUESTED';
  if (broken) return agent === 'working' ? 'agents_on_it' : 'needs_you';
  if (isExternalAuthor(pr.author, ctx.ghLogin) && pr.reviewDecision !== 'APPROVED') return agent === 'working' ? 'agents_on_it' : 'needs_you';
  const reviewOk = pr.reviewDecision === 'APPROVED' || pr.reviewDecision === '';
  if (pr.checks === 'passing' && pr.mergeable === 'MERGEABLE' && reviewOk) return 'ready_to_merge';
  if (agent === 'working') return 'agents_on_it';
  if (pr.checks === 'pending' || pr.mergeable === 'UNKNOWN') return 'waiting_on_others';
  // Clean but not provably green: no checks, mergeable not reported, or a
  // review nobody visible will give. The owner looks.
  return 'needs_you';
}

function classifyIssue(issue: IssueSummary, link: WorkLink | null, agent: 'working' | 'asking' | 'none', ctx: GitTurnContext): GitTurn {
  if (agent === 'asking') return 'needs_you';
  if (agent === 'working') return 'agents_on_it';
  if (link?.state === 'review') return 'waiting_on_others';
  const login = ctx.ghLogin;
  if (login && issue.assignees.length > 0 && !issue.assignees.some((a) => sameLogin(a, login))) return 'waiting_on_others';
  return 'needs_you';
}

/** The section an item belongs in, or null when it is merged or closed longer
 *  ago than SETTLED_WINDOW_MS (dropped from the list). */
export function classifyGitTurn(item: GitTurnItem, ctx: GitTurnContext): GitTurn | null {
  const state = item.kind === 'pr' ? item.pr.state : item.issue.state;
  if (state === 'merged' || state === 'closed') {
    const updatedAt = item.kind === 'pr' ? item.pr.updatedAt : item.issue.updatedAt;
    return settledOrDropped(item.closedAt ?? updatedAt, ctx.now);
  }
  const link = pickItemLink(item, ctx.links);
  const agent = linkAgent(link, ctx);
  return item.kind === 'pr' ? classifyPr(item.pr, agent, ctx) : classifyIssue(item.issue, link, agent, ctx);
}

/** Items per section for the header summary; dropped items are not counted. */
export function countByTurn(items: readonly GitTurnItem[], ctx: GitTurnContext): Record<GitTurn, number> {
  const out = Object.fromEntries(GIT_TURN_ORDER.map((t) => [t, 0])) as Record<GitTurn, number>;
  for (const item of items) {
    const turn = classifyGitTurn(item, ctx);
    if (turn) out[turn]++;
  }
  return out;
}
