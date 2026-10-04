import { describe, expect, it } from 'vitest';
import {
  WORK_LINK_STATES,
  deriveWorkLinkState,
  isWorkLink,
  isWorkLinkReason,
  isWorkLinkState,
  matchesWorkLinkFilter,
  parseWorkLink,
  parseWorkLinkFilter,
  prUrlParts,
  refKey,
  stateTakesReason,
  type WorkLink,
  type WorkLinkDeriveInput,
  type WorkLinkPrStatus,
} from '../workLink';
import { TASK_STATES, type TaskState } from '../types';

const issue = {
  host: 'github.com',
  owner: 'Acme',
  repo: 'widget',
  number: 42,
  title: 'Crash on save',
  url: 'https://github.com/Acme/widget/issues/42',
};

const base: WorkLink = {
  id: 'wl-1',
  origin: 'manual',
  owner: { workspaceId: 'ws-1', paneId: 'pane-a' },
  state: 'queued',
  decisionIds: [],
  createdAt: 1,
  updatedAt: 2,
};

describe('workLink guards', () => {
  it('accepts a full link and returns a clean copy', () => {
    const raw = {
      ...base,
      origin: 'issue',
      issue,
      title: 'x'.repeat(1000),
      a2aTaskId: 'task-1',
      a2aState: 'working',
      requester: { workspaceId: 'ws-0' },
      agent: 'claude',
      worktree: { path: '/tmp/wt', branch: 'feat/x' },
      pr: { host: 'github.com', owner: 'Acme', repo: 'widget', number: 7, url: 'https://github.com/Acme/widget/pull/7' },
      prStatus: { state: 'open', checks: 'pending', reviewDecision: '', mergeable: 'MERGEABLE', observedAt: 3 },
      state: 'blocked',
      reason: 'ci-failing',
      decisionIds: ['d1', 'd1', 'd2'],
      extra: 'dropped',
    };
    const link = parseWorkLink(raw)!;
    expect(link).not.toBeNull();
    expect(link.title).toHaveLength(256);
    expect(link.decisionIds).toEqual(['d1', 'd2']);
    expect(link).not.toHaveProperty('extra');
    expect(isWorkLink(raw)).toBe(true);
  });

  it.each([
    ['no owner', { ...base, owner: undefined }],
    ['bad workspace id', { ...base, owner: { workspaceId: 'ws 1' } }],
    ['unknown state', { ...base, state: 'paused' }],
    ['unknown origin', { ...base, origin: 'cron' }],
    ['issue origin without an issue', { ...base, origin: 'issue' }],
    ['issue whose number disagrees with its url', { ...base, issue: { ...issue, number: 43 } }],
    ['unknown a2a state', { ...base, a2aState: 'constructor' }],
    ['reason on a state that takes none', { ...base, state: 'running', reason: 'decision' }],
    ['pr url on another host', { ...base, pr: { host: 'github.com', owner: 'a', repo: 'b', number: 1, url: 'https://evil.example/a/b/pull/1' } }],
    ['branch with a space', { ...base, worktree: { path: '/tmp/wt', branch: 'a b' } }],
    ['non-array decisionIds', { ...base, decisionIds: 'd1' }],
    ['negative timestamp', { ...base, createdAt: -1 }],
    ['an array', [base]],
  ])('rejects %s', (_label, raw) => {
    expect(parseWorkLink(raw)).toBeNull();
    expect(isWorkLink(raw)).toBe(false);
  });

  it('keeps only the newest decisions past the cap', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `d${i}`);
    expect(parseWorkLink({ ...base, decisionIds: ids })!.decisionIds).toEqual(ids.slice(-32));
  });

  it('knows its enums', () => {
    expect(isWorkLinkState('needs-you')).toBe(true);
    expect(isWorkLinkState('toString')).toBe(false);
    expect(isWorkLinkReason('conflict')).toBe(true);
    expect(isWorkLinkReason('nope')).toBe(false);
  });
});

describe('workLink keys and filter', () => {
  it('parses a pull request url and keys refs case-insensitively', () => {
    expect(prUrlParts('https://github.com/Acme/widget/pull/7')).toEqual({ host: 'github.com', owner: 'Acme', repo: 'widget', number: 7 });
    expect(prUrlParts('https://github.com/Acme/widget/issues/7')).toBeNull();
    expect(refKey(issue)).toBe('github.com/acme/widget#42');
  });

  const linked: WorkLink = {
    ...base,
    origin: 'issue',
    issue,
    a2aTaskId: 'task-1',
    requester: { workspaceId: 'ws-hq' },
    pr: { host: 'github.com', owner: 'acme', repo: 'widget', number: 7 },
  };

  it('matches by repo, issue, PR, workspace on either side, task and state', () => {
    const f = (raw: unknown) => matchesWorkLinkFilter(linked, parseWorkLinkFilter(raw));
    expect(f({})).toBe(true);
    expect(f({ repo: { host: 'GitHub.com', owner: 'ACME', repo: 'Widget' } })).toBe(true);
    expect(f({ repo: { host: 'github.com', owner: 'acme', repo: 'other' } })).toBe(false);
    expect(f({ issue: { host: 'github.com', owner: 'acme', repo: 'widget', number: 42 } })).toBe(true);
    expect(f({ issue: { host: 'github.com', owner: 'acme', repo: 'widget', number: 7 } })).toBe(false);
    expect(f({ pr: { host: 'github.com', owner: 'acme', repo: 'widget', number: 7 } })).toBe(true);
    expect(f({ workspaceId: 'ws-1' })).toBe(true);
    expect(f({ workspaceId: 'ws-hq' })).toBe(true);
    expect(f({ workspaceId: 'ws-2' })).toBe(false);
    expect(f({ a2aTaskId: 'task-1' })).toBe(true);
    expect(f({ states: ['queued', 'running'] })).toBe(true);
    expect(f({ states: ['done'] })).toBe(false);
  });

  it('drops malformed filter keys instead of matching nothing', () => {
    expect(parseWorkLinkFilter({ repo: 'acme/widget', issue: { number: 1 }, workspaceId: 'a b', states: ['done', 'bogus'] }))
      .toEqual({ states: ['done'] });
    expect(parseWorkLinkFilter(null)).toEqual({});
  });
});

describe('deriveWorkLinkState', () => {
  const pr = (over: Partial<WorkLinkPrStatus> = {}): WorkLinkPrStatus => ({
    state: 'open', checks: 'passing', reviewDecision: '', mergeable: 'MERGEABLE', observedAt: 1, ...over,
  });
  const derive = (over: Partial<WorkLinkDeriveInput>) =>
    deriveWorkLinkState({ state: 'queued', hasPr: false, pendingDecision: false, ...over });

  it.each<[string, Partial<WorkLinkDeriveInput>, string, string?]>([
    ['submitted task', { a2aState: 'submitted' }, 'queued'],
    ['working task', { a2aState: 'working' }, 'running'],
    ['input-required task', { a2aState: 'input-required' }, 'needs-you', 'input-required'],
    ['failed task', { a2aState: 'failed' }, 'blocked', 'task-failed'],
    ['canceled task', { a2aState: 'canceled' }, 'abandoned'],
    ['canceled task beats a pending decision', { a2aState: 'canceled', pendingDecision: true }, 'abandoned'],
    ['completed, no PR', { a2aState: 'completed' }, 'done'],
    ['completed, PR not read yet', { a2aState: 'completed', hasPr: true }, 'review'],
    ['completed, PR open and green', { a2aState: 'completed', hasPr: true, prStatus: pr() }, 'review'],
    ['completed, draft PR', { a2aState: 'completed', hasPr: true, prStatus: pr({ state: 'draft' }) }, 'review'],
    ['completed, CI failing', { a2aState: 'completed', hasPr: true, prStatus: pr({ checks: 'failing' }) }, 'blocked', 'ci-failing'],
    ['completed, conflict', { a2aState: 'completed', hasPr: true, prStatus: pr({ mergeable: 'CONFLICTING' }) }, 'blocked', 'conflict'],
    ['completed, changes requested', { a2aState: 'completed', hasPr: true, prStatus: pr({ reviewDecision: 'CHANGES_REQUESTED' }) }, 'blocked', 'changes-requested'],
    ['completed, PR closed unmerged', { a2aState: 'completed', hasPr: true, prStatus: pr({ state: 'closed' }) }, 'abandoned'],
    ['merged PR beats everything', { a2aState: 'failed', hasPr: true, prStatus: pr({ state: 'merged' }), pendingDecision: true, state: 'abandoned' }, 'done'],
    ['abandoned is sticky', { state: 'abandoned', a2aState: 'working' }, 'abandoned'],
    ['pending decision while working', { a2aState: 'working', pendingDecision: true }, 'needs-you', 'decision'],
    ['working task with a failing PR is still running', { a2aState: 'working', hasPr: true, prStatus: pr({ checks: 'failing' }) }, 'running'],
    ['no task, a PR', { hasPr: true }, 'review'],
    ['no task, nothing else keeps the state', { state: 'running' }, 'running'],
    ['no task, explicit blocked keeps its reason', { state: 'blocked', reason: 'other' }, 'blocked', 'other'],
    ['no task, decision answered', { state: 'needs-you', reason: 'decision' }, 'queued'],
  ])('%s', (_label, input, state, reason) => {
    const out = derive(input);
    expect(out.state).toBe(state);
    expect(out.reason).toBe(reason);
  });

  it('is total and coherent over every input combination', () => {
    const tasks: (TaskState | undefined)[] = [undefined, ...TASK_STATES];
    const prs: (WorkLinkPrStatus | undefined)[] = [
      undefined,
      pr(), pr({ state: 'draft' }), pr({ state: 'merged' }), pr({ state: 'closed' }),
      pr({ checks: 'failing' }), pr({ checks: null }), pr({ mergeable: 'CONFLICTING' }),
      pr({ reviewDecision: 'CHANGES_REQUESTED' }),
    ];
    let cells = 0;
    for (const state of WORK_LINK_STATES) {
      for (const a2aState of tasks) {
        for (const prStatus of prs) {
          for (const hasPr of [false, true]) {
            for (const pendingDecision of [false, true]) {
              const out = deriveWorkLinkState({
                state,
                ...(stateTakesReason(state) ? { reason: 'other' as const } : {}),
                a2aState,
                hasPr: hasPr || !!prStatus,
                prStatus,
                pendingDecision,
              });
              cells++;
              expect(isWorkLinkState(out.state)).toBe(true);
              expect(out.reason === undefined || stateTakesReason(out.state)).toBe(true);
              if (prStatus?.state === 'merged') expect(out.state).toBe('done');
              else if (state === 'abandoned' || a2aState === 'canceled') expect(out.state).toBe('abandoned');
              else if (pendingDecision) expect(out).toEqual({ state: 'needs-you', reason: 'decision' });
            }
          }
        }
      }
    }
    expect(cells).toBe(7 * 7 * 9 * 2 * 2);
  });
});
