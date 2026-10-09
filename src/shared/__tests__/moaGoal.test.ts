import { describe, expect, it } from 'vitest';
import {
  MOA_GOAL_LIMITS,
  buildMoaGoalCard,
  goalHardRuleHit,
  moaGoalPowers,
  parseMoaGoalProposal,
  type MoaGoalContract,
} from '../moaGoal';

const HOUR = 3_600_000;

function contract(over: Partial<MoaGoalContract> = {}): MoaGoalContract {
  return {
    id: 'G-abc123',
    hqWorkspaceId: 'ws-hq',
    goal: 'Fix the flaky login test',
    repoRoot: '/repo',
    workspaceIds: [],
    level: 2,
    budget: { maxTasks: 4, maxHours: 4, maxTurns: 40 },
    humanOnly: ['database migration'],
    status: 'active',
    createdAt: 0,
    approvedAt: 0,
    taskWorkspaceIds: [],
    tasksUsed: 0,
    turnsUsed: 0,
    ...over,
  };
}

describe('parseMoaGoalProposal — refuses, never cuts', () => {
  it('accepts a minimal repo-scoped goal with defaults', () => {
    const p = parseMoaGoalProposal({ goal: '  Fix   the test ', repo: '/repo' });
    expect(p).toEqual({
      goal: 'Fix the test',
      repo: '/repo',
      workspaceIds: [],
      level: 2,
      budget: { maxTasks: MOA_GOAL_LIMITS.TASKS.default, maxHours: MOA_GOAL_LIMITS.HOURS.default, maxTurns: MOA_GOAL_LIMITS.TURNS.default },
      humanOnly: [],
    });
  });

  it.each([
    [{}, 'goal_empty'],
    [{ goal: 'x'.repeat(MOA_GOAL_LIMITS.GOAL_MAX_CHARS + 1), repo: '/r' }, 'goal_too_long'],
    [{ goal: 'g', repo: '--upload-pack=evil' }, 'repo_invalid'],
    [{ goal: 'g', repo: 5 }, 'repo_invalid'],
    [{ goal: 'g', workspaceIds: ['a b'] }, 'workspaces_invalid'],
    [{ goal: 'g', workspaceIds: ['a', 'b', 'c', 'd', 'e'] }, 'workspaces_invalid'],
    [{ goal: 'g' }, 'no_scope'],
    [{ goal: 'g', repo: '/r', level: 1 }, 'level_invalid'],
    [{ goal: 'g', repo: '/r', level: 4 }, 'level_invalid'],
    [{ goal: 'g', repo: '/r', budget: { maxTasks: 99 } }, 'budget_invalid'],
    [{ goal: 'g', repo: '/r', budget: { maxHours: 0 } }, 'budget_invalid'],
    [{ goal: 'g', repo: '/r', budget: { maxTurns: 1.5 } }, 'budget_invalid'],
    [{ goal: 'g', repo: '/r', humanOnly: 'x' }, 'human_only_invalid'],
    [{ goal: 'g', repo: '/r', humanOnly: ['x'.repeat(MOA_GOAL_LIMITS.HUMAN_ONLY_ITEM_MAX_CHARS + 1)] }, 'human_only_invalid'],
    [{ goal: 'g', repo: '/r', humanOnly: Array.from({ length: MOA_GOAL_LIMITS.HUMAN_ONLY_MAX + 1 }, (_, i) => `item ${i}`) }, 'human_only_invalid'],
  ])('%j → %s', (params, error) => {
    expect(parseMoaGoalProposal(params as Record<string, unknown>)).toEqual({ error });
  });

  it('dedupes the human-only list case-insensitively', () => {
    const p = parseMoaGoalProposal({ goal: 'g', repo: '/r', humanOnly: ['Schema change', 'schema change', ' '] });
    expect('error' in p ? null : p.humanOnly).toEqual(['Schema change']);
  });
});

describe('buildMoaGoalCard', () => {
  it('shows everything the contract grants and what stays the operator\'s', () => {
    const card = buildMoaGoalCard(contract({ workspaceIds: ['ws-a'] }), (id) => (id === 'ws-a' ? 'alpha' : undefined));
    expect(card.options).toEqual(['Approve goal', 'Decline']);
    const all = `${card.question}\n${card.context}`;
    for (const s of ['Fix the flaky login test', '/repo', 'alpha', 'database migration', '4']) expect(all).toContain(s);
    expect(all.toLowerCase()).toMatch(/push|pr|merge/);
  });
});

describe('goalHardRuleHit — what never leaves the operator', () => {
  it.each([
    ['now git push origin main', 'remote'],
    ['please push the branch when done', 'remote'],
    ['force-push it', 'remote'],
    ['gh pr create --fill', 'remote'],
    ['open a pull request for this', 'remote'],
    ['merge the PR', 'remote'],
    ['npm publish the package', 'release'],
    ['git tag v1.2.3', 'release'],
    ['paste the API key into config', 'secret'],
    ['read .env and use it', 'secret'],
    ['cat ~/.ssh/id_rsa', 'secret'],
    ['rm -rf build', 'destructive'],
    ['git reset --hard HEAD~3', 'destructive'],
    ['DROP TABLE users', 'destructive'],
    ['run the database migration now', 'human-only'],
  ])('%s → %s', (text, rule) => {
    expect(goalHardRuleHit(text, ['database migration'])?.rule).toBe(rule);
  });

  it('lets negated mentions through (an instruction to stay local)', () => {
    expect(goalHardRuleHit('Commit locally. Do not push it; never open a PR.')).toBeNull();
    expect(goalHardRuleHit('Fix the test without running git push.')).toBeNull();
    expect(goalHardRuleHit("Don't run the database migration.", ['database migration'])).toBeNull();
  });

  it('a literal token is refused even in a negated sentence', () => {
    expect(goalHardRuleHit(`do not use ghp_${'a'.repeat(36)}`)?.rule).toBe('secret');
  });

  it('ordinary work passes', () => {
    expect(goalHardRuleHit('Run the unit tests, fix the failing assertion and commit on your branch.')).toBeNull();
    expect(goalHardRuleHit('')).toBeNull();
  });
});

describe('moaGoalPowers', () => {
  const hq = { workspaceId: 'ws-hq', level: 2 as const };
  it('grants min(contract, HQ) level while active and in budget', () => {
    expect(moaGoalPowers(contract({ level: 3 }), hq, 1)).toEqual({ ok: true, level: 2 });
    expect(moaGoalPowers(contract({ level: 3 }), { ...hq, level: 3 }, 1)).toEqual({ ok: true, level: 3 });
  });
  it.each([
    ['none', null, hq, 1],
    ['not-active', contract({ status: 'pending', approvedAt: undefined }), hq, 1],
    ['hq-moved', contract(), { workspaceId: 'ws-other', level: 2 as const }, 1],
    ['level', contract(), { workspaceId: 'ws-hq', level: 1 as const }, 1],
    ['level', contract(), { workspaceId: 'ws-hq', level: 0 as const }, 1],
    ['expired', contract(), hq, 4 * HOUR],
    ['turns', contract({ turnsUsed: 40 }), hq, 1],
    ['tasks', contract({ tasksUsed: 5 }), hq, 1],
  ])('%s', (reason, c, h, now) => {
    expect(moaGoalPowers(c as MoaGoalContract | null, h, now as number)).toEqual({ ok: false, reason });
  });
  it('a used-up task budget still answers its tasks', () => {
    expect(moaGoalPowers(contract({ tasksUsed: 4 }), hq, 1).ok).toBe(true);
  });
});
