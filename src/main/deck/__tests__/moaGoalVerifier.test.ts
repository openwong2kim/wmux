import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCriterionClaims, verifyGoal, type GoalTaskRef, type MoaGoalVerifierPorts } from '../moaGoalVerifier';
import type { GateRunResult } from '../../worktask/TaskGateRunner';
import type { MoaGoalContract } from '../../../shared/moaGoal';

const SHA = 'a'.repeat(40);
let dir: string;
let repo: string;
let wt: string;
let evidence: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moa-verify-')));
  repo = path.join(dir, 'repo');
  wt = path.join(dir, 'wt');
  evidence = path.join(dir, 'evidence');
  fs.mkdirSync(repo);
  fs.mkdirSync(wt);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function contract(over: Partial<MoaGoalContract> = {}): MoaGoalContract {
  return {
    id: 'G-abc123',
    hqWorkspaceId: 'ws-hq',
    goal: 'Fix the login test',
    repoRoot: repo,
    workspaceIds: [],
    level: 2,
    budget: { maxTasks: 4, maxHours: 4, maxTurns: 40 },
    humanOnly: [],
    doneCriteria: ['login test passes'],
    status: 'active',
    createdAt: 0,
    approvedAt: 0,
    taskWorkspaceIds: ['ws-t1'],
    tasksUsed: 1,
    turnsUsed: 0,
    ...over,
  };
}

const passed = (command = 'npm test', exitCode: number | null = 0): GateRunResult => ({
  ok: true,
  status: 'completed',
  taskId: 't1',
  result: { exitCode, tail: 'Tests 3 passed', at: 5, command },
  recorded: true,
});

function ports(over: Partial<MoaGoalVerifierPorts> = {}): MoaGoalVerifierPorts {
  const tasks: GoalTaskRef[] = [{ taskId: 't1', workspaceId: 'ws-t1', worktreePath: wt }];
  return {
    tasks: async () => tasks,
    runGate: async () => passed(),
    headSha: async () => SHA,
    evidenceDir: () => evidence,
    now: () => 9,
    ...over,
  };
}

function artifact(name = 'login.log', body = 'PASS login'): string {
  const p = path.join(wt, name);
  fs.writeFileSync(p, body);
  return p;
}

describe('verifyGoal — passes only with gates and evidence', () => {
  it('a passing gate and an artifact per criterion pass, pinned to the head sha, with the gate log saved', async () => {
    const a = artifact();
    const r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [a] }], ports());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verification.gates).toEqual([
      expect.objectContaining({ taskId: 't1', workspaceId: 'ws-t1', headSha: SHA, command: 'npm test', exitCode: 0 }),
    ]);
    const log = r.verification.gates[0].logPath;
    expect(log.startsWith(evidence)).toBe(true);
    expect(fs.readFileSync(log, 'utf8')).toContain('Tests 3 passed');
    expect(fs.readFileSync(log, 'utf8')).toContain(`# head ${SHA}`);
    expect(r.verification.criteria).toEqual([
      { criterion: 1, text: 'login test passes', artifacts: [{ path: a, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: 10 }] },
    ]);
  });

  it('a memo alone (no criteria claims) is refused', async () => {
    const r = await verifyGoal(contract(), [], ports());
    expect(r).toMatchObject({ ok: false, code: 'unverified' });
    if (!r.ok) expect(r.problems.join('\n')).toMatch(/criterion 1 .* no evidence named/);
  });

  it('a failing gate fails and names the log', async () => {
    const r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [artifact()] }], ports({ runGate: async () => passed('npm test', 1) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/the gate failed \(npm test, exit 1\); see .*t1-aaaaaaaaaaaa\.log/);
  });

  it('a gate killed by a signal (exit null) fails', async () => {
    const r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [artifact()] }], ports({ runGate: async () => passed('npm test', null) }));
    expect(r.ok).toBe(false);
  });

  it('a project with no test command fails for a goal', async () => {
    const skip: GateRunResult = { ok: true, status: 'skipped', taskId: 't1', skipped: 'no_gate_command', detail: 'none', recorded: true };
    const r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [artifact()] }], ports({ runGate: async () => skip }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/declares no test command/);
  });

  it.each([
    [{ ok: true, status: 'skipped', taskId: 't1', skipped: 'deps_missing', detail: 'no node_modules' } as GateRunResult, /did not run \(deps_missing/],
    [{ ok: false, status: 'busy', taskId: 't1' } as GateRunResult, /already running/],
    [{ ok: false, status: 'refused', taskId: 't1', error: 'bad verify' } as GateRunResult, /refused \(bad verify\)/],
  ])('%#: other non-verdicts fail', async (res, msg) => {
    const r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [artifact()] }], ports({ runGate: async () => res }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(msg);
  });

  it('HEAD moving under the gate fails', async () => {
    let n = 0;
    const r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [artifact()] }], ports({ headSha: async () => (n++ === 0 ? SHA : 'b'.repeat(40)) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/HEAD moved/);
  });

  it('a goal with no fan-out task fails', async () => {
    const r = await verifyGoal(contract({ taskWorkspaceIds: [] }), [{ criterion: 1, artifacts: [artifact()] }], ports());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/no fan-out task/);
  });

  it('every task must run: a missing task, a missing worktree and an unreadable list fail', async () => {
    const a = artifact();
    const two = contract({ taskWorkspaceIds: ['ws-t1', 'ws-t2'] });
    let r = await verifyGoal(two, [{ criterion: 1, artifacts: [a] }], ports());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual(['task workspace ws-t2: no task found for it']);
    r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [a] }], ports({ tasks: async () => [{ taskId: 't1', workspaceId: 'ws-t1', worktreePath: path.join(dir, 'gone') }] }));
    expect(r.ok).toBe(false);
    r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [a] }], ports({ tasks: async () => null }));
    expect(r.ok).toBe(false);
  });

  it('runs every gate even after one fails', async () => {
    const wt2 = path.join(dir, 'wt2');
    fs.mkdirSync(wt2);
    const runGate = vi.fn(async (i: { taskId: string }) => ({ ...passed('npm test', i.taskId === 't1' ? 1 : 0), taskId: i.taskId }) as GateRunResult);
    const r = await verifyGoal(
      contract({ taskWorkspaceIds: ['ws-t1', 'ws-t2'] }),
      [{ criterion: 1, artifacts: [artifact()] }],
      ports({ runGate, tasks: async () => [{ taskId: 't1', workspaceId: 'ws-t1', worktreePath: wt }, { taskId: 't2', workspaceId: 'ws-t2', worktreePath: wt2 }] }),
    );
    expect(runGate).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
  });

  it('artifacts must be existing, non-empty files inside the goal\'s worktrees, repository or evidence folder', async () => {
    const outside = path.join(dir, 'outside.log');
    fs.writeFileSync(outside, 'x');
    const empty = artifact('empty.log', '');
    for (const bad of [outside, empty, path.join(wt, 'nope.log'), 'relative.log', wt]) {
      const r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [bad] }], ports());
      expect(r.ok, bad).toBe(false);
    }
    const inRepo = path.join(repo, 'junit.xml');
    fs.writeFileSync(inRepo, '<testsuite/>');
    expect((await verifyGoal(contract(), [{ criterion: 1, artifacts: [inRepo] }], ports())).ok).toBe(true);
  });

  it('a symlink pointing outside is judged by where it points', async () => {
    const outside = path.join(dir, 'secret.txt');
    fs.writeFileSync(outside, 'x');
    const link = path.join(wt, 'link.log');
    fs.symlinkSync(outside, link);
    expect((await verifyGoal(contract(), [{ criterion: 1, artifacts: [link] }], ports())).ok).toBe(false);
  });

  it('a claim for a criterion the goal does not have fails', async () => {
    const a = artifact();
    const r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [a] }, { criterion: 2, artifacts: [a] }], ports());
    expect(r.ok).toBe(false);
  });

  it('a goal with no done criteria still needs its gates', async () => {
    expect((await verifyGoal(contract({ doneCriteria: [] }), [], ports())).ok).toBe(true);
    expect((await verifyGoal(contract({ doneCriteria: [] }), [], ports({ runGate: async () => passed('npm test', 2) }))).ok).toBe(false);
  });
});

describe('parseCriterionClaims', () => {
  it('accepts the shape and refuses anything else', () => {
    expect(parseCriterionClaims(undefined)).toEqual([]);
    expect(parseCriterionClaims([{ criterion: 1, artifacts: [' /a '] }])).toEqual([{ criterion: 1, artifacts: ['/a'] }]);
    for (const bad of ['x', [{}], [{ criterion: 0, artifacts: ['/a'] }], [{ criterion: 1, artifacts: [] }], [{ criterion: 1, artifacts: [3] }], [{ criterion: 1.5, artifacts: ['/a'] }]]) {
      expect(parseCriterionClaims(bad)).toHaveProperty('error');
    }
  });
});

describe('verifyGoal — one retry tells a flake from a failure (learning loop)', () => {
  it('fails twice: a real failure is reported and the goal is refused', async () => {
    const outcomes: unknown[] = [];
    let runs = 0;
    const r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [artifact()] }], ports({
      runGate: async () => { runs++; return passed('npm test', 1); },
      onGateOutcome: (o) => outcomes.push(o),
    }));
    expect(runs).toBe(2);
    expect(r.ok).toBe(false);
    expect(outcomes).toEqual([expect.objectContaining({ kind: 'failure', taskId: 't1', command: 'npm test', goalId: contract().id })]);
  });

  it('fails then passes: a flake is reported, the gate counts as passed and is marked flaky', async () => {
    const outcomes: { kind: string }[] = [];
    let runs = 0;
    const r = await verifyGoal(contract(), [{ criterion: 1, artifacts: [artifact()] }], ports({
      runGate: async () => (++runs === 1 ? passed('npm test', 1) : passed()),
      onGateOutcome: (o) => outcomes.push(o),
    }));
    expect(outcomes.map((o) => o.kind)).toEqual(['flake']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verification.gates[0]).toMatchObject({ exitCode: 0, flaky: true });
  });

  it('without the learning port nothing is retried', async () => {
    let runs = 0;
    await verifyGoal(contract(), [{ criterion: 1, artifacts: [artifact()] }], ports({ runGate: async () => { runs++; return passed('npm test', 1); } }));
    expect(runs).toBe(1);
  });
});
