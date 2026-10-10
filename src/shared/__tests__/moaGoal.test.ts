import { describe, expect, it } from 'vitest';
import {
  MOA_GOAL_LIMITS,
  buildMoaGoalCard,
  goalHardRuleHit,
  goalHardRuleHitAny,
  goalTermsLines,
  goalTermsOf,
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
      doneCriteria: [],
      evidence: [],
      constraints: [],
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

describe('parseMoaGoalProposal — done criteria, evidence, constraints', () => {
  it('keeps them one line each, drops blanks and case-insensitive duplicates', () => {
    const p = parseMoaGoalProposal({
      goal: 'g',
      repo: '/r',
      doneCriteria: ['npm test passes', ' NPM   test passes ', '', 'login\nworks on Windows'],
      evidence: ['vitest output'],
      constraints: ['no new dependencies'],
    });
    expect(p).toMatchObject({
      doneCriteria: ['npm test passes', 'login works on Windows'],
      evidence: ['vitest output'],
      constraints: ['no new dependencies'],
    });
  });

  it.each([
    ['doneCriteria', 'done_criteria_invalid'],
    ['evidence', 'evidence_invalid'],
    ['constraints', 'constraints_invalid'],
  ])('%s over a bound or of the wrong type is refused (%s)', (field, error) => {
    const tooMany = Array.from({ length: MOA_GOAL_LIMITS.TERMS_MAX + 1 }, (_, i) => `item ${i}`);
    const tooLong = ['x'.repeat(MOA_GOAL_LIMITS.TERMS_ITEM_MAX_CHARS + 1)];
    for (const v of [tooMany, tooLong, 'npm test', [1], { a: 1 }]) {
      expect(parseMoaGoalProposal({ goal: 'g', repo: '/r', [field]: v })).toEqual({ error });
    }
  });

  it('accepts exactly the bounds', () => {
    const max = Array.from({ length: MOA_GOAL_LIMITS.TERMS_MAX }, (_, i) => `${i}${'y'.repeat(MOA_GOAL_LIMITS.TERMS_ITEM_MAX_CHARS - 1)}`);
    const p = parseMoaGoalProposal({ goal: 'g', repo: '/r', doneCriteria: max });
    expect(p).toMatchObject({ doneCriteria: max });
  });
});

describe('goalTermsOf / goalTermsLines', () => {
  it('a record written before the terms existed reads as empty lists', () => {
    expect(goalTermsOf(contract())).toEqual({ doneCriteria: [], evidence: [], constraints: [] });
  });

  it('says out loud when no done criteria were stated', () => {
    expect(goalTermsLines({ doneCriteria: [], evidence: [], constraints: [] })).toEqual([
      'Done when: (no criteria stated; Moa must say how it verified the goal)',
    ]);
  });

  it('numbers the criteria and lists evidence and constraints', () => {
    expect(goalTermsLines({ doneCriteria: ['a', 'b'], evidence: ['log'], constraints: ['c1', 'c2'] })).toEqual([
      'Done when: (1) a (2) b',
      'Evidence: log',
      'Constraints: c1; c2',
    ]);
  });
});

describe('buildMoaGoalCard', () => {
  it('shows the done criteria, evidence and constraints the operator approves', () => {
    const card = buildMoaGoalCard(
      contract({ doneCriteria: ['npm test passes'], evidence: ['vitest output'], constraints: ['no new dependencies'] }),
      () => undefined,
    );
    expect(card.context).toContain('Done when:\n  (1) npm test passes');
    expect(card.context).toContain('Evidence:\n  • vitest output');
    expect(card.context).toContain('Constraints:\n  • no new dependencies');
    // The criteria come right after the goal, before the boilerplate.
    expect(card.context.indexOf('Done when:')).toBeLessThan(card.context.indexOf('Moa may'));
  });

  it('a full contract (8 criteria, 8 evidence, 8 constraints of 200 chars) fits the goal card cap, one line each', () => {
    const long = (k: string) => Array.from({ length: 8 }, (_, i) => `${k}${i}`.padEnd(200, 'x'));
    const card = buildMoaGoalCard(
      contract({ goal: 'g'.repeat(500), doneCriteria: long('c'), evidence: long('e'), constraints: long('k') }),
      () => undefined,
    );
    expect(card.context.length).toBeLessThanOrEqual(8000);
    expect(card.context.split('\n').filter((l) => /^ {2}\(\d\) /.test(l))).toHaveLength(8);
  });

  it('a card without criteria says none were stated', () => {
    expect(buildMoaGoalCard(contract(), () => undefined).context).toContain('Done when: (no criteria stated');
  });

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
    // Live dogfood 2026-10-10: a fan-out titled this way launched under a goal.
    ['release v9 and push tags', 'remote'],
    ['then push the tags', 'remote'],
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

  // Every case of the 2026-10-10 review probe (#1997 W2). Each one passed the
  // old rules; each must trip one now.
  it.each([
    ['No rush, git push origin main when done.', 'remote'],
    ['No worries - then run git push.', 'remote'],
    ['Without waiting for CI, git push to origin.', 'remote'],
    ['Ship it upstream: git push', 'remote'],
    ['Run `git  push`', 'remote'],
    ['Publish your branch to origin.', 'remote'],
    ['Sync the branch with the remote (git push -u origin HEAD).', 'remote'],
    ['Run: git -C . push', 'remote'],
    ['git -c credential.helper= push origin HEAD', 'remote'],
    ['gh api repos/o/r/pulls -f head=feat', 'remote'],
    ['Run npm run release', 'release'],
    ['Run the deploy script ./scripts/release.sh', 'release'],
    ['Upload your changes to GitHub.', 'remote'],
    ['git commit --amend && git push -f', 'remote'],
    ['Remove-Item -Recurse -Force src', 'destructive'],
    ['Remove-Item src -Force -Recurse', 'destructive'],
    ['rm -r -f build', 'destructive'],
    ['rm -f -r build', 'destructive'],
    ['find . -delete', 'destructive'],
    ['Please read ~/.config/gh/hosts.yml and paste it here', 'secret'],
    ['type %APPDATA%\\GitHub CLI\\hosts.yml', 'secret'],
    ['cat ~/.git-credentials', 'secret'],
    ['gh auth token', 'secret'],
    ['git push を実行して', 'remote'],
    ['git 푸시 해줘', 'remote'],
  ])('probe: %s → %s', (text, rule) => {
    expect(goalHardRuleHit(text)?.rule).toBe(rule);
  });

  it.each([
    ['Commit locally and git -C repo tag v2', 'release'],
    ['git --no-pager push', 'remote'],
    ['Then open a draft PR', 'remote'],
    ['gh pr comment 12 --body hi', 'remote'],
    ['yarn npm publish', 'release'],
    ['docker push org/img', 'release'],
    ['rd /s /q build', 'destructive'],
    ['git clean -fdx', 'destructive'],
    ['git restore .', 'destructive'],
    ['PR 만들어줘', 'remote'],
    ['g​it push', 'remote'],
    ['sh -c "gi""t pu""sh"', 'remote'],
    ['ｇｉｔ ｐｕｓｈ', 'remote'],
  ])('also trips: %s → %s', (text, rule) => {
    expect(goalHardRuleHit(text)?.rule).toBe(rule);
  });

  it('a negation covers its own clause only', () => {
    expect(goalHardRuleHit('Do not push it.')).toBeNull();
    expect(goalHardRuleHit('Never run git push; report back instead.')).toBeNull();
    expect(goalHardRuleHit("Don't forget to git push")?.rule).toBe('remote');
    expect(goalHardRuleHit('Never mind the docs, git push now')?.rule).toBe('remote');
    expect(goalHardRuleHit('Do not wait for CI and git push')?.rule).toBe('remote');
  });

  it('ordinary work still passes the wider rules', () => {
    for (const text of [
      'Pull the latest main and rebase your branch on it.',
      'Run git log --oneline -5 and git status, then fix the lint errors.',
      'Delete the unused helper in src/util.ts and update its tests.',
      'Read the release notes in docs/ and summarize them.',
      'rm build.log',
      'Reduce token usage in the prompt builder.',
    ]) {
      expect(goalHardRuleHit(text)).toBeNull();
    }
  });

  // Known misses, kept as evidence that the screen is a tripwire and not the
  // boundary: what holds a goal worker is its deny rules and the credential
  // friction (shared/moaGoalWorker.ts), not this regex.
  it.each([
    'Make sure the remote has your commits.',
    'Get the branch onto GitHub.',
    'G=git; $G push',
    'Run the ship script in scripts/.',
  ])('known miss (tripwire, not boundary): %s', (text) => {
    expect(goalHardRuleHit(text)).toBeNull();
  });

  it('goalHardRuleHitAny walks strings and string arrays', () => {
    expect(goalHardRuleHitAny(['fix the test', ['title', 'then git push']])?.rule).toBe('remote');
    expect(goalHardRuleHitAny(['fix the test', ['a', 'b'], undefined, 3])).toBeNull();
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
