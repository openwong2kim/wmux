import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '../../../../shared/types';
import type { IssueSummary, RepoPermission } from '../../../../shared/issueSurface';
import type { PrSummary } from '../../../../shared/prSurface';
import type { WorkLink } from '../../../../shared/workLink';
import { classifyGitTurn, countByTurn, GIT_TURN_ORDER, pickItemLink, type GitTurnContext, type GitTurnItem } from '../gitTurn';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const pr = (over: Partial<PrSummary> = {}): GitTurnItem => ({
  kind: 'pr',
  pr: {
    number: 7, title: 'Fix', state: 'open', author: 'owner', headRefName: 'feat/x',
    updatedAt: iso(NOW - HOUR), url: 'https://github.com/o/r/pull/7',
    reviewDecision: '', checks: 'passing', mergeable: 'MERGEABLE', ...over,
  },
});

const issue = (over: Partial<IssueSummary> = {}): GitTurnItem => ({
  kind: 'issue',
  issue: {
    number: 3, title: 'Bug', state: 'open', author: 'someone', labels: [], assignees: [],
    updatedAt: iso(NOW - HOUR), url: 'https://github.com/o/r/issues/3', comments: 0, ...over,
  },
});

const link = (over: Partial<WorkLink> = {}): WorkLink => ({
  id: 'l1', origin: 'pr', owner: { workspaceId: 'ws1', paneId: 'p1' }, state: 'running',
  pr: { host: 'github.com', owner: 'o', repo: 'r', number: 7 },
  decisionIds: [], createdAt: 1, updatedAt: 2, ...over,
});

const issueLink = (over: Partial<WorkLink> = {}): WorkLink => link({
  origin: 'issue', pr: undefined,
  issue: { host: 'github.com', owner: 'o', repo: 'r', number: 3, title: 'Bug', url: 'https://github.com/o/r/issues/3' },
  ...over,
});

const ctx = (
  links: WorkLink[] = [],
  status: AgentStatus | null = 'running',
  ghLogin: string | null = 'owner',
  permission: RepoPermission | null = 'WRITE',
): GitTurnContext => ({
  now: NOW, links, paneStatus: () => status, ghLogin, repoPermission: (key) => (key === 'github.com/o/r' ? permission : null),
});

describe('classifyGitTurn: PRs', () => {
  it('CI red with an agent working is agents_on_it', () => {
    expect(classifyGitTurn(pr({ checks: 'failing' }), ctx([link()], 'running'))).toBe('agents_on_it');
  });

  it('CI red with the pane gone, idle or unlinked is needs_you', () => {
    expect(classifyGitTurn(pr({ checks: 'failing' }), ctx([link()], null))).toBe('needs_you');
    expect(classifyGitTurn(pr({ checks: 'failing' }), ctx([link()], 'idle'))).toBe('needs_you');
    expect(classifyGitTurn(pr({ checks: 'failing' }), ctx([]))).toBe('needs_you');
  });

  it('a conflict or changes requested with no agent is needs_you', () => {
    expect(classifyGitTurn(pr({ mergeable: 'CONFLICTING' }), ctx([]))).toBe('needs_you');
    expect(classifyGitTurn(pr({ reviewDecision: 'CHANGES_REQUESTED' }), ctx([link({ state: 'blocked' })], 'complete'))).toBe('needs_you');
  });

  it('a needs-you link or an asking pane is needs_you even while green', () => {
    expect(classifyGitTurn(pr(), ctx([link({ state: 'needs-you', reason: 'decision' })]))).toBe('needs_you');
    expect(classifyGitTurn(pr(), ctx([link()], 'awaiting_input'))).toBe('needs_you');
  });

  it("another author's PR awaiting review is needs_you; approved and green is ready", () => {
    expect(classifyGitTurn(pr({ author: 'contrib', checks: 'pending' }), ctx([]))).toBe('needs_you');
    expect(classifyGitTurn(pr({ author: 'Contrib', reviewDecision: 'APPROVED' }), ctx([]))).toBe('ready_to_merge');
    expect(classifyGitTurn(pr({ author: 'contrib', checks: 'pending' }), ctx([link()], 'running'))).toBe('agents_on_it');
  });

  it("another author's PR on a repo the viewer cannot write to waits, red CI and conflicts included", () => {
    for (const permission of ['READ', 'TRIAGE', null] as const) {
      const c = ctx([], 'idle', 'owner', permission);
      expect(classifyGitTurn(pr({ author: 'contrib', checks: 'pending' }), c)).toBe('waiting_on_others');
      expect(classifyGitTurn(pr({ author: 'contrib', checks: 'failing' }), c)).toBe('waiting_on_others');
      expect(classifyGitTurn(pr({ author: 'contrib', mergeable: 'CONFLICTING' }), c)).toBe('waiting_on_others');
      expect(classifyGitTurn(pr({ author: 'contrib', checks: null }), c)).toBe('waiting_on_others');
      expect(classifyGitTurn(pr({ author: 'contrib', reviewDecision: 'APPROVED' }), c)).toBe('waiting_on_others');
    }
    // wmux's own signals still count there: an agent on it, or a link asking.
    expect(classifyGitTurn(pr({ author: 'contrib', checks: 'failing' }), ctx([link()], 'running', 'owner', 'READ'))).toBe('agents_on_it');
    expect(classifyGitTurn(pr({ author: 'contrib' }), ctx([link({ state: 'needs-you', reason: 'decision' })], 'idle', 'owner', 'READ'))).toBe('needs_you');
    // No permission lookup at all is unknown, so it waits too.
    expect(classifyGitTurn(pr({ author: 'contrib', checks: 'pending' }), { ...ctx([], 'idle'), repoPermission: undefined })).toBe('waiting_on_others');
    // The owner's own PR there is still the owner's turn.
    expect(classifyGitTurn(pr({ checks: 'failing' }), ctx([], 'idle', 'owner', 'READ'))).toBe('needs_you');
  });

  it("another author's PR is the owner's to review with write, maintain or admin", () => {
    for (const permission of ['WRITE', 'MAINTAIN', 'ADMIN'] as const) {
      expect(classifyGitTurn(pr({ author: 'contrib' }), ctx([], 'idle', 'owner', permission))).toBe('needs_you');
      expect(classifyGitTurn(pr({ author: 'contrib', checks: 'failing' }), ctx([], 'idle', 'owner', permission))).toBe('needs_you');
    }
  });

  it('with no gh login every author counts as the owner', () => {
    expect(classifyGitTurn(pr({ author: 'contrib', checks: 'pending' }), ctx([], 'idle', null))).toBe('waiting_on_others');
  });

  it('green, mergeable and approved or not requiring review is ready_to_merge', () => {
    expect(classifyGitTurn(pr(), ctx([]))).toBe('ready_to_merge');
    expect(classifyGitTurn(pr({ reviewDecision: 'APPROVED' }), ctx([]))).toBe('ready_to_merge');
    // Ranked above agents_on_it.
    expect(classifyGitTurn(pr(), ctx([link()], 'running'))).toBe('ready_to_merge');
  });

  it('an agent working on a pending PR is agents_on_it', () => {
    expect(classifyGitTurn(pr({ checks: 'pending' }), ctx([link()], 'running'))).toBe('agents_on_it');
  });

  it('a stale running link (pane not running) does not count as an agent', () => {
    expect(classifyGitTurn(pr({ checks: 'pending' }), ctx([link()], 'idle'))).toBe('waiting_on_others');
  });

  it('a link in review is not an agent on it even when the pane runs', () => {
    expect(classifyGitTurn(pr({ checks: 'failing' }), ctx([link({ state: 'review' })], 'running'))).toBe('needs_you');
  });

  it('drafts wait, even with red CI, unless an agent works on them', () => {
    expect(classifyGitTurn(pr({ state: 'draft' }), ctx([]))).toBe('waiting_on_others');
    expect(classifyGitTurn(pr({ state: 'draft', checks: 'failing' }), ctx([]))).toBe('waiting_on_others');
    expect(classifyGitTurn(pr({ state: 'draft', checks: 'failing' }), ctx([link()], 'running'))).toBe('agents_on_it');
  });

  it('CI pending or mergeable still computing with nobody to act is waiting_on_others', () => {
    expect(classifyGitTurn(pr({ checks: 'pending' }), ctx([]))).toBe('waiting_on_others');
    expect(classifyGitTurn(pr({ mergeable: 'UNKNOWN' }), ctx([]))).toBe('waiting_on_others');
  });

  it('no checks reported (a repo with no CI), mergeable and no review needed is ready_to_merge', () => {
    expect(classifyGitTurn(pr({ checks: null }), ctx([]))).toBe('ready_to_merge');
    expect(classifyGitTurn(pr({ checks: null, reviewDecision: 'APPROVED' }), ctx([]))).toBe('ready_to_merge');
    expect(classifyGitTurn(pr({ checks: null, mergeable: 'CONFLICTING' }), ctx([]))).toBe('needs_you');
    expect(classifyGitTurn(pr({ checks: null, mergeable: 'UNKNOWN' }), ctx([]))).toBe('waiting_on_others');
    expect(classifyGitTurn(pr({ checks: null, reviewDecision: 'REVIEW_REQUIRED' }), ctx([]))).toBe('needs_you');
  });

  it('unknown signals never read as ready: mergeable unreported, own review required', () => {
    expect(classifyGitTurn(pr({ mergeable: '' }), ctx([]))).toBe('needs_you');
    expect(classifyGitTurn(pr({ reviewDecision: 'REVIEW_REQUIRED' }), ctx([]))).toBe('needs_you');
  });

  it('merged 2h ago is settled; merged 3 days ago is dropped', () => {
    expect(classifyGitTurn(pr({ state: 'merged', updatedAt: iso(NOW - 2 * HOUR) }), ctx([]))).toBe('settled');
    expect(classifyGitTurn(pr({ state: 'merged', updatedAt: iso(NOW - 72 * HOUR) }), ctx([]))).toBeNull();
    expect(classifyGitTurn(pr({ state: 'closed', updatedAt: iso(NOW - 3 * HOUR) }), ctx([link()]))).toBe('settled');
  });

  it('closedAt wins over updatedAt; an unreadable time shows rather than hides', () => {
    const merged = { ...pr({ state: 'merged', updatedAt: iso(NOW - HOUR) }), closedAt: iso(NOW - 30 * HOUR) } as GitTurnItem;
    expect(classifyGitTurn(merged, ctx([]))).toBeNull();
    expect(classifyGitTurn(pr({ state: 'merged', updatedAt: '' }), ctx([]))).toBe('settled');
  });
});

describe('classifyGitTurn: issues', () => {
  it('an unrouted issue is needs_you', () => {
    expect(classifyGitTurn(issue(), ctx([]))).toBe('needs_you');
  });

  it('an issue whose agent works is agents_on_it; whose agent stopped is needs_you', () => {
    expect(classifyGitTurn(issue(), ctx([issueLink()], 'running'))).toBe('agents_on_it');
    expect(classifyGitTurn(issue(), ctx([issueLink()], null))).toBe('needs_you');
  });

  it('an issue whose link is in review waits (its PR row carries the turn)', () => {
    expect(classifyGitTurn(issue(), ctx([issueLink({ state: 'review' })], 'idle'))).toBe('waiting_on_others');
  });

  it('an issue assigned to someone else waits; assigned to the owner needs you', () => {
    expect(classifyGitTurn(issue({ assignees: ['helper'] }), ctx([]))).toBe('waiting_on_others');
    expect(classifyGitTurn(issue({ assignees: ['Owner'] }), ctx([]))).toBe('needs_you');
    expect(classifyGitTurn(issue({ assignees: ['Owner', 'helper'] }), ctx([]))).toBe('needs_you');
    expect(classifyGitTurn(issue({ assignees: ['helper'] }), ctx([], 'idle', null))).toBe('needs_you');
  });

  it('a done link does not route an issue', () => {
    expect(classifyGitTurn(issue(), ctx([issueLink({ state: 'done' })], 'running'))).toBe('needs_you');
  });
});

describe('pickItemLink', () => {
  it('takes the newest active link about this item only', () => {
    const old = link({ id: 'a', updatedAt: 5 });
    const fresh = link({ id: 'b', updatedAt: 9, state: 'blocked', reason: 'ci-failing' });
    const other = link({ id: 'c', updatedAt: 20, pr: { host: 'github.com', owner: 'o', repo: 'r', number: 8 } });
    const ended = link({ id: 'd', updatedAt: 30, state: 'done' });
    expect(pickItemLink(pr(), [old, fresh, other, ended])?.id).toBe('b');
    // An issue link that also carries this PR number in another field does not leak in.
    expect(pickItemLink(issue({ url: 'https://github.com/o/r/issues/7', number: 7 }), [old])).toBeNull();
  });
});

describe('countByTurn', () => {
  it('counts every section, zero included, and skips dropped items', () => {
    const counts = countByTurn([
      pr(),
      pr({ checks: 'failing' }),
      issue(),
      pr({ state: 'merged', updatedAt: iso(NOW - 72 * HOUR) }),
    ], ctx([]));
    expect(Object.keys(counts)).toEqual([...GIT_TURN_ORDER]);
    expect(counts).toEqual({ needs_you: 2, ready_to_merge: 1, agents_on_it: 0, waiting_on_others: 0, settled: 0 });
  });
});
