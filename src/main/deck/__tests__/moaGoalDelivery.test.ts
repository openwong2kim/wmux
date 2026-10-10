import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELIVERABLE_BRANCH_RE, deliverGoal, prNumberOf, revertDelivery, runDueMerges, type ExecResult, type MoaGoalDeliveryPorts } from '../moaGoalDelivery';
import { MOA_GOAL_AUTO_MERGE, MOA_GOAL_DEFAULT_HUMAN_ONLY, type MoaGoalContract, type MoaGoalVerification } from '../../../shared/moaGoal';

let dir: string;
let remote: string;
let repo: string;
let wt: string;
let head: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}
async function gitPort(args: string[], cwd: string): Promise<ExecResult> {
  try {
    return { code: 0, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moa-deliver-')));
  remote = path.join(dir, 'remote.git');
  git(['init', '-q', '--bare', '-b', 'main', remote], dir);
  repo = path.join(dir, 'repo');
  git(['clone', '-q', remote, repo], dir);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  git(['push', '-q', 'origin', 'HEAD:main'], repo);
  git(['remote', 'set-head', 'origin', 'main'], repo);
  wt = path.join(dir, 'wt');
  git(['worktree', 'add', '-q', '-b', 'wtask/fix-a', wt], repo);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'fixed\n');
  git(['commit', '-qam', 'fix a'], wt);
  head = git(['rev-parse', 'HEAD'], wt);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function contract(over: Partial<MoaGoalContract> = {}): MoaGoalContract {
  return {
    id: 'G-abc123', hqWorkspaceId: 'ws-hq', goal: 'Fix a.txt', repoRoot: repo, workspaceIds: [], level: 2,
    budget: { maxTasks: 4, maxHours: 4, maxTurns: 40 }, humanOnly: [], doneCriteria: ['a.txt says fixed'],
    status: 'active', createdAt: 0, approvedAt: 0, taskWorkspaceIds: ['ws-t1'], tasksUsed: 1, turnsUsed: 0, ...over,
  };
}
const verification = (sha = head): MoaGoalVerification => ({
  at: 1,
  gates: [{ taskId: 't1', workspaceId: 'ws-t1', headSha: sha, command: 'npm test', exitCode: 0, at: 1, logPath: '/e/t1.log', logSha256: 'c'.repeat(64) }],
  criteria: [{ criterion: 1, text: 'a.txt says fixed', artifacts: [{ path: '/e/a.txt', sha256: 'd'.repeat(64), bytes: 6 }] }],
});

function ports(over: Partial<MoaGoalDeliveryPorts> = {}) {
  const gh = vi.fn(async (args: string[]): Promise<ExecResult> =>
    args[0] === 'pr' && args[1] === 'create'
      ? { code: 0, stdout: 'https://github.com/o/r/pull/42\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' });
  const git = vi.fn(gitPort);
  const p: MoaGoalDeliveryPorts = { tasks: async () => [{ taskId: 't1', workspaceId: 'ws-t1', worktreePath: wt }], git, gh, now: () => 1000, ...over };
  return { p, gh, git };
}

describe('deliverGoal — push the verified commit, open the PR', () => {
  it('pushes exactly the verified commit to the same-named branch and opens a PR against the default branch', async () => {
    const { p, gh } = ports();
    const d = await deliverGoal(contract(), verification(), p);
    expect(d.items).toEqual([{ taskId: 't1', branch: 'wtask/fix-a', headSha: head, base: 'main', pushed: true, prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 }]);
    expect(git(['rev-parse', 'refs/heads/wtask/fix-a'], remote)).toBe(head);
    const create = gh.mock.calls[0][0];
    expect(create.slice(0, 6)).toEqual(['pr', 'create', '--head', 'wtask/fix-a', '--base', 'main']);
    const body = create[create.indexOf('--body') + 1];
    expect(body).toContain('G-abc123');
    expect(body).toContain('✅ (1) a.txt says fixed');
    expect(body).toContain(head);
    expect(d.revertRecipe[0]).toMatch(/^gh pr close 42/);
    expect(d.items[0].mergeAfter).toBeUndefined();
  });

  it('never force-pushes: a remote that moved ahead rejects the push, and the item says so', async () => {
    const other = path.join(dir, 'other');
    git(['clone', '-q', remote, other], dir);
    git(['checkout', '-q', '-b', 'wtask/fix-a'], other);
    fs.writeFileSync(path.join(other, 'b.txt'), 'b');
    git(['add', '.'], other);
    git(['commit', '-qm', 'someone else'], other);
    git(['push', '-q', 'origin', 'wtask/fix-a'], other);
    const theirs = git(['rev-parse', 'HEAD'], other);
    const { p, gh, git: g } = ports();
    const d = await deliverGoal(contract(), verification(), p);
    expect(d.items[0]).toMatchObject({ pushed: false, error: expect.stringMatching(/^push failed/) });
    expect(git(['rev-parse', 'refs/heads/wtask/fix-a'], remote)).toBe(theirs);
    expect(gh).not.toHaveBeenCalled();
    for (const [args] of g.mock.calls) expect(args.join(' ')).not.toMatch(/--force|\s-f\b|\s\+/);
  });

  it('refuses a branch outside wtask/ and a branch that moved after verification', async () => {
    git(['checkout', '-q', '-b', 'main-copy'], wt);
    let d = await deliverGoal(contract(), verification(), ports().p);
    expect(d.items[0]).toMatchObject({ pushed: false, error: expect.stringMatching(/only wtask\//) });
    git(['checkout', '-q', 'wtask/fix-a'], wt);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'later\n');
    git(['commit', '-qam', 'later'], wt);
    d = await deliverGoal(contract(), verification(), ports().p);
    expect(d.items[0]).toMatchObject({ pushed: false, error: expect.stringMatching(/moved after verification/) });
    expect(DELIVERABLE_BRANCH_RE.test('main')).toBe(false);
  });

  it('a failed PR keeps the push and records the error', async () => {
    const { p } = ports({ gh: async () => ({ code: 1, stdout: '', stderr: 'gh: not logged in' }) });
    const d = await deliverGoal(contract(), verification(), p);
    expect(d.items[0]).toMatchObject({ pushed: true, error: 'pull request failed: gh: not logged in' });
  });

  it('a missing worktree is an item error, not a throw', async () => {
    const d = await deliverGoal(contract(), verification(), ports({ tasks: async () => null }).p);
    expect(d.items[0].error).toMatch(/worktree is gone/);
  });
});

describe('merge path — behind the disabled flag', () => {
  it('the flag ships off and merges stay human-only; push and PR do not', () => {
    expect(MOA_GOAL_AUTO_MERGE).toBe(false);
    const all = MOA_GOAL_DEFAULT_HUMAN_ONLY.join('; ');
    expect(all).toMatch(/merges/);
    expect(all).toMatch(/force-push/);
    expect(all).toMatch(/secrets/);
    expect(all).toMatch(/releases/);
    expect(all).not.toMatch(/push, pull requests/);
  });

  it('with the flag on at level 3 it waits out the one-hour window, then merges with a merge commit', async () => {
    const { p, gh } = ports({ autoMerge: true });
    const c = contract({ level: 3 });
    const d = await deliverGoal(c, verification(), p);
    expect(d.items[0].mergeAfter).toBe(1000 + 3_600_000);
    let after = await runDueMerges(c, d, { ...p, now: () => 1000 + 3_599_999 });
    expect(after.items[0].merged).toBeUndefined();
    after = await runDueMerges(c, d, { ...p, now: () => 1000 + 3_600_000 });
    expect(after.items[0].merged).toBe(true);
    expect(gh.mock.calls.at(-1)?.[0]).toEqual(['pr', 'merge', '42', '--merge']);
    expect(after.revertRecipe[0]).toMatch(/git revert -m 1/);
  });

  it('with the flag off (or below level 3) nothing is ever merged', async () => {
    const { p, gh } = ports();
    const d = await deliverGoal(contract({ level: 3 }), verification(), p);
    const after = await runDueMerges(contract({ level: 3 }), { ...d, items: d.items.map((x) => ({ ...x, mergeAfter: 0 })) }, p);
    expect(after.items[0].merged).toBeUndefined();
    expect(gh.mock.calls.some(([a]) => a[1] === 'merge')).toBe(false);
  });
});

describe('revertDelivery — "Revert this goal"', () => {
  it('closes the open PR and keeps the branch', async () => {
    const { p, gh } = ports();
    const d = await deliverGoal(contract(), verification(), p);
    const r = await revertDelivery(contract({ status: 'completed' }), d, p);
    expect(r.ok).toBe(true);
    expect(gh.mock.calls.at(-1)?.[0].slice(0, 3)).toEqual(['pr', 'close', '42']);
    expect(r.delivery.reverted).toMatchObject({ by: 'operator', notes: ['closed PR #42 (wtask/fix-a kept)'] });
    expect(git(['rev-parse', 'refs/heads/wtask/fix-a'], remote)).toBe(head);
  });

  it('a merged PR is not touched; the recipe is reported', async () => {
    const { p, gh } = ports();
    const d = await deliverGoal(contract(), verification(), p);
    const merged = { ...d, items: d.items.map((x) => ({ ...x, merged: true })) };
    gh.mockClear();
    const r = await revertDelivery(contract(), merged, p);
    expect(r.ok).toBe(false);
    expect(r.notes[0]).toMatch(/git revert -m 1/);
    expect(gh).not.toHaveBeenCalled();
  });
});

it('prNumberOf', () => {
  expect(prNumberOf('https://github.com/o/r/pull/7')).toBe(7);
  expect(prNumberOf('nope')).toBeUndefined();
});
