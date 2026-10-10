// Integration: a real git repository and worktree, the real TaskGateRunner
// spawning the project's real `npm test`, and MoaGoalService.end() gated by
// the real verifier. Only the ledger and the decision card are stand-ins.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MoaGoalService, type MoaGoalPorts } from '../moaGoalContract';
import { verifyGoal } from '../moaGoalVerifier';
import { listGoalTasks } from '../moaGoalHost';
import { TaskGateRunner } from '../../worktask/TaskGateRunner';
import type { LedgerPort } from '../../worktask/ledgerPort';
import type { WorkspaceDecision } from '../deckDecisionStore';

const HQ = 'ws-hq';
let dir: string;
let repo: string;
let wt: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function pkg(testScript: string | null): string {
  return JSON.stringify({ name: 'p', version: '1.0.0', scripts: testScript ? { test: testScript } : {} });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moa-goal-int-')));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'package.json'), pkg('node -e "console.log(\'3 tests passed\')"'));
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  wt = path.join(dir, 'wt');
  git(['worktree', 'add', '-q', '-b', 'wtask/g', wt], repo);
  fs.mkdirSync(path.join(wt, 'node_modules')); // the gate wants deps present
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ledger: LedgerPort = {
  read: async (taskId) => ({ id: taskId, rev: 1 }),
  writeGate: async () => ({ ok: true, rev: 2 }) as never,
};

function service(): MoaGoalService {
  const slots = new Map<string, WorkspaceDecision>();
  const runner = new TaskGateRunner({ ledger, timeoutMs: 60_000 });
  const daemon = async (method: string) =>
    method === 'task.mission.list' ? { ok: true, tasks: [{ id: 't1', title: 'fix', status: 'open', worktreePath: wt }, { id: 'other', title: 'x', status: 'open', worktreePath: repo }] } : null;
  const ports: MoaGoalPorts = {
    hqWorkspaceId: () => HQ,
    hqLevel: () => 2,
    moaReady: () => true,
    vetRepo: async () => repo,
    workspaceExists: () => true,
    workspaceName: () => undefined,
    workerPermissionMode: () => 'bypassPermissions',
    decisions: {
      raiseIfFree: async (ws, card) => {
        const d = { id: 'd1', status: 'pending', ...card } as unknown as WorkspaceDecision;
        slots.set(ws, d);
        return d;
      },
      load: (ws) => slots.get(ws) ?? null,
      resolve: async (ws, _id, resolution) => {
        const d = { ...slots.get(ws)!, status: 'resolved', resolution } as WorkspaceDecision;
        slots.set(ws, d);
        return d;
      },
      clearResolved: async (ws) => void slots.delete(ws),
      clearPendingIfUnchanged: async (ws) => slots.delete(ws),
    },
    filePath: path.join(dir, 'moa-goals.json'),
    verify: (c, claims) =>
      verifyGoal(c, claims, {
        tasks: (x) => listGoalTasks(x, daemon, (id) => (id === 't1' ? 'ws-t1' : 'ws-other')),
        runGate: (input) => runner.run(input),
        headSha: async (p) => git(['rev-parse', 'HEAD'], p),
        evidenceDir: (id) => path.join(dir, 'evidence', id),
      }),
  };
  return new MoaGoalService(ports);
}

async function activeGoal(svc: MoaGoalService): Promise<string> {
  const p = await svc.propose(HQ, { goal: 'Make the tests pass', repo, doneCriteria: ['npm test passes'] });
  if (!p.ok) throw new Error(p.error);
  const r = await svc.resolveCard(HQ, 'd1', 'Approve goal');
  if (!r?.ok) throw new Error('not approved');
  expect(svc.attachTaskWorkspaces(p.id, ['ws-t1'])).toBeUndefined();
  return p.id;
}

describe('goal completion — real repo, real gate', () => {
  it('completes with a real passing npm test and a real artifact; the record is pinned to the commit', async () => {
    const svc = service();
    const id = await activeGoal(svc);
    const art = path.join(wt, 'test-output.txt');
    fs.writeFileSync(art, '3 tests passed\n');
    const head = git(['rev-parse', 'HEAD'], wt);
    expect(await svc.end('moa', 'completed', 'tests pass', [{ criterion: 1, artifacts: [art] }])).toEqual({ ok: true, id });
    const v = svc.get(id)?.verification;
    expect(v?.gates).toEqual([expect.objectContaining({ taskId: 't1', headSha: head, exitCode: 0, command: expect.stringContaining('test') })]);
    expect(fs.readFileSync(v!.gates[0].logPath, 'utf8')).toContain('3 tests passed');
    expect(v?.criteria[0].artifacts[0]).toMatchObject({ path: art, bytes: 15 });
  }, 60_000);

  it('a memo alone does not complete it', async () => {
    const svc = service();
    const id = await activeGoal(svc);
    const r = await svc.end('moa', 'completed', 'done, trust me');
    expect(r).toMatchObject({ ok: false, code: 'unverified' });
    expect(svc.get(id)?.status).toBe('active');
  }, 60_000);

  it('a really failing npm test keeps the goal open', async () => {
    fs.writeFileSync(path.join(wt, 'package.json'), pkg('node -e "process.exit(3)"'));
    git(['commit', '-qam', 'break'], wt);
    const svc = service();
    const id = await activeGoal(svc);
    const art = path.join(wt, 'package.json');
    const r = await svc.end('moa', 'completed', 'done', [{ criterion: 1, artifacts: [art] }]);
    expect(r).toMatchObject({ ok: false, code: 'unverified' });
    expect(r.problems?.join('\n')).toMatch(/gate failed .*exit 3/);
    expect(svc.get(id)?.status).toBe('active');
  }, 60_000);

  it('a project with no test command cannot complete a goal', async () => {
    fs.writeFileSync(path.join(wt, 'package.json'), pkg(null));
    fs.writeFileSync(path.join(repo, 'package.json'), pkg(null));
    const svc = service();
    await activeGoal(svc);
    const r = await svc.end('moa', 'completed', 'done', [{ criterion: 1, artifacts: [path.join(wt, 'package.json')] }]);
    expect(r).toMatchObject({ ok: false, code: 'unverified' });
    expect(r.problems?.join('\n')).toMatch(/no test command/);
  }, 60_000);
});
