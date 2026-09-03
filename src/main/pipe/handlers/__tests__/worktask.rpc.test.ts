// ─── task.gate.* / task.adopt / task.close / task.pr — the wire trust boundary ─
//
// These five methods let a non-human close tasks, write to repositories and open
// PRs, so what is pinned here is the REFUSALS: a remote caller, a stated
// identity, a task someone else owns, a task that never materialized. The happy
// paths are asserted only to the extent of "the same service the GUI drives was
// called with server-derived arguments" — the services' own behaviour (close
// ordering, gh gates) is pinned in their own tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../workspace/ptyOwnership', () => ({ resolvePtyOwnerWorkspace: vi.fn() }));
vi.mock('../../../git/git', () => ({ git: vi.fn() }));

import { resolvePtyOwnerWorkspace } from '../../../workspace/ptyOwnership';
import { git } from '../../../git/git';
import {
  parseGitLog,
  parseGitStatus,
  registerWorktaskRpc,
  TASK_GIT_LOG_MAX,
  WORKTASK_RPC_METHODS,
  type WorktaskExec,
  type WorktaskRpcDeps,
} from '../worktask.rpc';
import type { RpcContext } from '../../../../shared/rpc';
import type { RpcRouter } from '../../RpcRouter';
import type { TaskAdoptService } from '../../../worktask/TaskAdoptService';
import type { TaskCloseService } from '../../../worktask/TaskCloseService';
import type { TaskGateRunner } from '../../../worktask/TaskGateRunner';
import type { TaskPrService } from '../../../worktask/TaskPrService';

const LOCAL: RpcContext = { origin: 'local' };
const CALLER_WS = 'ws-caller';
const TASK = {
  id: 'wtask-1',
  title: 'lane one',
  status: 'open' as const,
  branch: 'wtask/lane-one',
  worktreePath: '/wt/lane-one',
};

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<Record<string, unknown>>;

interface Harness {
  call: (method: string, params: Record<string, unknown>, ctx?: RpcContext) => Promise<Record<string, unknown>>;
  exec: ReturnType<typeof vi.fn>;
  closeTask: ReturnType<typeof vi.fn>;
  createPr: ReturnType<typeof vi.fn>;
  adopt: ReturnType<typeof vi.fn>;
  gateRun: ReturnType<typeof vi.fn>;
  gateCancel: ReturnType<typeof vi.fn>;
  missionListParams: () => Record<string, unknown> | undefined;
}

function harness(opts?: {
  tasks?: unknown[];
  ownerWorkspaceId?: string | null;
  onDisk?: boolean;
  exec?: WorktaskExec;
  /** 'throw' = transport failure, 'not-ok' = the daemon refusing. */
  missionList?: 'throw' | 'not-ok';
}): Harness {
  const handlers = new Map<string, Handler>();
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) } as unknown as RpcRouter;

  const closeTask = vi.fn(async () => ({ ok: true, taskId: TASK.id, archivePending: false }));
  const createPr = vi.fn(async () => ({ ok: true, prUrl: 'https://example.test/pr/1' }));
  const adopt = vi.fn(async () => ({ ok: true, taskId: TASK.id, targetRepo: '/repo', files: ['a.ts'] }));
  const gateRun = vi.fn(async () => ({
    ok: true,
    status: 'completed',
    taskId: TASK.id,
    result: { exitCode: 0, tail: '', at: 1, command: 'npm test' },
    recorded: true,
  }));
  const gateCancel = vi.fn(() => true);

  let missionParams: Record<string, unknown> | undefined;
  const daemon = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== 'task.mission.list') throw new Error(`unexpected daemon rpc: ${method}`);
      missionParams = params;
      if (opts?.missionList === 'throw') throw new Error('daemon socket closed');
      if (opts?.missionList === 'not-ok') return { ok: false, error: { message: 'mission log unavailable' } };
      return { ok: true, tasks: opts?.tasks ?? [TASK] };
    }),
  };

  // Every `git rev-parse` in the close path answers with the parent repo, so
  // the repo derivation succeeds and the close service is reached.
  vi.mocked(git).mockResolvedValue({ stdout: '/repo\n', stderr: '', code: 0 });

  const owner = opts?.ownerWorkspaceId === undefined ? CALLER_WS : opts.ownerWorkspaceId;
  vi.mocked(resolvePtyOwnerWorkspace).mockImplementation(async () => owner);

  const exec = vi.fn(opts?.exec ?? (async () => ({ stdout: '', stderr: '', code: 0 })));

  const deps: WorktaskRpcDeps = {
    daemon,
    exec: exec as unknown as WorktaskExec,
    getWindow: () => null,
    close: { closeTask } as unknown as TaskCloseService,
    pr: { createPr } as unknown as TaskPrService,
    adopt: { adopt } as unknown as TaskAdoptService,
    gate: { run: gateRun, cancel: gateCancel } as unknown as TaskGateRunner,
    fileExists: () => opts?.onDisk !== false,
  };
  registerWorktaskRpc(router, deps);

  return {
    call: async (method, params, ctx = LOCAL) => {
      const h = handlers.get(method);
      if (!h) throw new Error(`${method} was not registered`);
      return h(params, ctx);
    },
    closeTask,
    createPr,
    adopt,
    gateRun,
    gateCancel,
    exec,
    missionListParams: () => missionParams,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registration', () => {
  it('registers exactly the contracted methods', () => {
    const handlers = new Map<string, Handler>();
    const router = { register: (m: string, h: Handler) => handlers.set(m, h) } as unknown as RpcRouter;
    registerWorktaskRpc(router, {
      daemon: { rpc: vi.fn() },
      getWindow: () => null,
      close: {} as TaskCloseService,
      pr: {} as TaskPrService,
      adopt: {} as TaskAdoptService,
      gate: {} as TaskGateRunner,
    });
    expect([...handlers.keys()].sort()).toEqual([...WORKTASK_RPC_METHODS].sort());
  });
});

describe.each(WORKTASK_RPC_METHODS)('%s — shared gates', (method) => {
  it('refuses a non-local origin', async () => {
    const h = harness();
    const res = await h.call(method, { taskId: TASK.id }, { origin: 'remote' } as RpcContext);
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
  });

  it('refuses a caller-stated verifiedWorkspaceId instead of ignoring it', async () => {
    const h = harness();
    const res = await h.call(method, { taskId: TASK.id, senderPtyId: 'pty-1', verifiedWorkspaceId: 'ws-other' });
    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(String((res.error as { message: string }).message)).toContain('verifiedWorkspaceId');
  });

  it('refuses a caller whose identity cannot be resolved', async () => {
    const h = harness({ ownerWorkspaceId: null });
    const res = await h.call(method, { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
  });

  it('requires a taskId', async () => {
    const h = harness();
    const res = await h.call(method, { senderPtyId: 'pty-1' });
    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });

  it('reports an unknown task and a foreign task identically (owner-scoped list)', async () => {
    const unknown = await harness({ tasks: [] }).call(method, { taskId: 'wtask-nope', senderPtyId: 'pty-1' });
    const foreign = await harness({ tasks: [] }).call(method, { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('scopes the ownership lookup to the resolved workspace', async () => {
    const h = harness();
    await h.call(method, { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(h.missionListParams()).toEqual({ verifiedWorkspaceId: CALLER_WS });
  });

  it('takes the commander binding over a stated senderPtyId', async () => {
    const h = harness();
    await h.call(method, { taskId: TASK.id, senderPtyId: 'pty-someone-else' }, {
      origin: 'local',
      commanderWorkspace: CALLER_WS,
    } as RpcContext);
    expect(h.missionListParams()).toEqual({ verifiedWorkspaceId: CALLER_WS });
    expect(vi.mocked(resolvePtyOwnerWorkspace)).not.toHaveBeenCalled();
  });
});

describe('task.gate.run', () => {
  it('runs the gate in the task worktree as a system actor', async () => {
    const h = harness();
    const res = await h.call('task.gate.run', { taskId: TASK.id, senderPtyId: 'pty-1' });
    // The wmux.json trust verdict is keyed by the parent repository, never by a
    // wtask/ worktree the daemon minted (which has no trust record at all, so
    // the whole verify branch was dead).
    expect(h.gateRun).toHaveBeenCalledWith({
      taskId: TASK.id,
      worktreePath: TASK.worktreePath,
      systemWorkspaceId: 'ws-daemon',
      projectRoot: '/repo',
    });
    expect(res).toMatchObject({ ok: true, status: 'completed', title: TASK.title });
  });

  it('refuses a task with no worktree on disk instead of failing inside git', async () => {
    const h = harness({ onDisk: false });
    const res = await h.call('task.gate.run', { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(res).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(h.gateRun).not.toHaveBeenCalled();
  });

  it('passes a busy verdict through as an answer, not an error envelope', async () => {
    const h = harness();
    h.gateRun.mockResolvedValueOnce({ ok: false, status: 'busy', taskId: TASK.id });
    const res = await h.call('task.gate.run', { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(res).toMatchObject({ ok: false, status: 'busy' });
  });
});

describe('task.gate.cancel', () => {
  it('reports whether anything was actually cancelled', async () => {
    const h = harness();
    expect(await h.call('task.gate.cancel', { taskId: TASK.id, senderPtyId: 'pty-1' })).toMatchObject({
      ok: true,
      cancelled: true,
    });
    h.gateCancel.mockReturnValueOnce(false);
    expect(await h.call('task.gate.cancel', { taskId: TASK.id, senderPtyId: 'pty-1' })).toMatchObject({
      ok: true,
      cancelled: false,
    });
  });
});

describe('task.adopt', () => {
  it('adopts the whole task worktree', async () => {
    const h = harness();
    const res = await h.call('task.adopt', { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(h.adopt).toHaveBeenCalledWith({ taskId: TASK.id, worktreePath: TASK.worktreePath });
    expect(res).toMatchObject({ ok: true, files: ['a.ts'] });
  });

  it('passes a dirty-target refusal straight through', async () => {
    const h = harness();
    h.adopt.mockResolvedValueOnce({ ok: false, taskId: TASK.id, reason: 'dirty-target', error: 'x' });
    expect(await h.call('task.adopt', { taskId: TASK.id, senderPtyId: 'pty-1' })).toMatchObject({
      ok: false,
      reason: 'dirty-target',
    });
  });
});

describe('task.close', () => {
  it('closes with the server-derived identity', async () => {
    const h = harness();
    await h.call('task.close', { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(h.closeTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK.id, verifiedWorkspaceId: CALLER_WS, worktreePath: TASK.worktreePath }),
    );
  });

  it('close-only when the worktree is gone from disk', async () => {
    const h = harness({ onDisk: false });
    await h.call('task.close', { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(h.closeTask).toHaveBeenCalledWith({ taskId: TASK.id, verifiedWorkspaceId: CALLER_WS });
  });

  it('reports the dirty-worktree refusal from the close service', async () => {
    const h = harness();
    h.closeTask.mockResolvedValueOnce({ ok: false, taskId: TASK.id, reason: 'dirty', error: 'preserved' });
    expect(await h.call('task.close', { taskId: TASK.id, senderPtyId: 'pty-1' })).toMatchObject({
      ok: false,
      reason: 'dirty',
    });
  });

  it('reports the unpushed-branch refusal from the close service', async () => {
    const h = harness();
    h.closeTask.mockResolvedValueOnce({ ok: false, taskId: TASK.id, reason: 'unpushed', error: '2 commits', aheadCount: 2 });
    expect(await h.call('task.close', { taskId: TASK.id, senderPtyId: 'pty-1' })).toMatchObject({
      ok: false,
      reason: 'unpushed',
      aheadCount: 2,
    });
  });
});

describe('task.pr', () => {
  it('opens the PR from the task branch the daemon reported', async () => {
    const h = harness();
    const res = await h.call('task.pr', { taskId: TASK.id, senderPtyId: 'pty-1', body: 'why' });
    expect(h.createPr).toHaveBeenCalledWith({
      taskId: TASK.id,
      verifiedWorkspaceId: CALLER_WS,
      worktreePath: TASK.worktreePath,
      branch: TASK.branch,
      title: TASK.title,
      body: 'why',
    });
    expect(res).toMatchObject({ ok: true, prUrl: 'https://example.test/pr/1' });
  });

  it('refuses an unmaterialized task rather than pushing nothing', async () => {
    const h = harness({ tasks: [{ ...TASK, branch: undefined, worktreePath: undefined }] });
    const res = await h.call('task.pr', { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(res).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(h.createPr).not.toHaveBeenCalled();
  });
});


describe('task.git.status', () => {
  it('runs a fixed argv in the task worktree and returns structure, not text', async () => {
    const h = harness({
      exec: async () => ({
        stdout: '## wtask/lane-one...origin/wtask/lane-one [ahead 2]\0 M src/a.ts\0?? src/new.ts\0',
        stderr: '',
        code: 0,
      }),
    });
    const res = await h.call('task.git.status', { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(h.exec).toHaveBeenCalledWith('git', ['status', '--porcelain=v1', '--branch', '-z'], TASK.worktreePath);
    expect(res).toMatchObject({
      ok: true,
      branch: 'wtask/lane-one',
      ahead: 2,
      behind: 0,
      clean: false,
      files: [
        { status: ' M', path: 'src/a.ts' },
        { status: '??', path: 'src/new.ts' },
      ],
    });
  });

  it('reports a git failure as data', async () => {
    const h = harness({ exec: async () => ({ stdout: '', stderr: 'not a git repository', code: 128 }) });
    expect(await h.call('task.git.status', { taskId: TASK.id, senderPtyId: 'pty-1' })).toMatchObject({
      ok: false,
      reason: 'git-failed',
    });
  });
});

describe('task.git.log', () => {
  it('clamps the limit instead of refusing, and reports what ran', async () => {
    const h = harness({ exec: async () => ({ stdout: '', stderr: '', code: 0 }) });
    const res = await h.call('task.git.log', { taskId: TASK.id, senderPtyId: 'pty-1', limit: 500 });
    expect(res).toMatchObject({ ok: true, limit: TASK_GIT_LOG_MAX });
    expect(h.exec.mock.calls[0]?.[1]).toContain(String(TASK_GIT_LOG_MAX));
  });

  it('rejects a limit that is not a positive integer', async () => {
    const h = harness();
    expect(await h.call('task.git.log', { taskId: TASK.id, senderPtyId: 'pty-1', limit: 0 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(await h.call('task.git.log', { taskId: TASK.id, senderPtyId: 'pty-1', limit: 'all' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('parses the separator-delimited commit lines', async () => {
    const line = ['abc', 'A Dev', '2026-09-04T00:00:00Z', 'fix: a subject with -- dashes'].join('\u001f');
    const h = harness({ exec: async () => ({ stdout: `${line}\n`, stderr: '', code: 0 }) });
    const res = await h.call('task.git.log', { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect((res as { commits: unknown[] }).commits).toEqual([
      { hash: 'abc', author: 'A Dev', date: '2026-09-04T00:00:00Z', subject: 'fix: a subject with -- dashes' },
    ]);
  });
});

describe('task.gh.prView', () => {
  it('returns the parsed PR json', async () => {
    const h = harness({ exec: async () => ({ stdout: '{"number":7,"state":"OPEN"}', stderr: '', code: 0 }) });
    const res = await h.call('task.gh.prView', { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(h.exec.mock.calls[0]?.[0]).toBe('gh');
    expect(res).toMatchObject({ ok: true, pr: { number: 7, state: 'OPEN' } });
  });

  it('reports "no PR" as data rather than as a failure', async () => {
    const h = harness({ exec: async () => ({ stdout: '', stderr: 'no pull requests found', code: 1 }) });
    expect(await h.call('task.gh.prView', { taskId: TASK.id, senderPtyId: 'pty-1' })).toMatchObject({
      ok: false,
      reason: 'no-pr',
    });
  });
});

describe('porcelain parsing', () => {
  it('reads a rename as its destination and consumes the origin record', () => {
    const parsed = parseGitStatus('## main\0R  new.ts\0old.ts\0 M other.ts\0');
    expect(parsed.files).toEqual([
      { status: 'R ', path: 'new.ts' },
      { status: ' M', path: 'other.ts' },
    ]);
  });

  // Without -z git quotes non-ASCII paths and splits a path containing a
  // newline across two lines, so a caller acting on `path` was handed a name
  // that does not exist on disk.
  it('keeps a path containing a newline as one entry', () => {
    expect(parseGitStatus('## main\0 M src/a\nb.ts\0').files).toEqual([{ status: ' M', path: 'src/a\nb.ts' }]);
  });

  it('reads a non-ASCII path verbatim rather than git-quoted', () => {
    expect(parseGitStatus('## main\0 M src/é.ts\0').files).toEqual([{ status: ' M', path: 'src/é.ts' }]);
  });

  it('reports a branch with no upstream and no changes as clean', () => {
    const parsed = parseGitStatus('## wtask/x\0');
    expect(parsed).toMatchObject({ branch: 'wtask/x', ahead: 0, behind: 0, clean: true });
  });

  it('reads ahead and behind together', () => {
    expect(parseGitStatus('## a...origin/a [ahead 1, behind 3]\0')).toMatchObject({ ahead: 1, behind: 3 });
  });

  it('ignores empty log output', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});

// ── A closed or detached task is not something to act on ───────────────────
// Its worktree has been removed (closed) or deliberately handed away
// (detached); running a gate or opening a PR there is at best a confusing git
// error and at worst work done in a directory nobody is watching.
describe.each(['task.gate.run', 'task.adopt', 'task.pr'])('%s — the task must still be live', (method) => {
  it('refuses a closed task', async () => {
    const h = harness({ tasks: [{ ...TASK, status: 'closed' }] });
    const res = await h.call(method, { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(res).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });

  it('refuses a detached task', async () => {
    const h = harness({ tasks: [{ ...TASK, detachedAt: 1 }] });
    const res = await h.call(method, { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(res).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });
});

describe('reads and close still work on a finished task', () => {
  it.each(['task.git.status', 'task.git.log', 'task.gh.prView'])('%s reads a closed task', async (method) => {
    const h = harness({ tasks: [{ ...TASK, status: 'closed' }] });
    const res = await h.call(method, { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(res).not.toMatchObject({ error: { code: 'FAILED_PRECONDITION' } });
  });

  it('task.close reconciles an already-closed task instead of refusing', async () => {
    const h = harness({ tasks: [{ ...TASK, status: 'closed' }] });
    await h.call('task.close', { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(h.closeTask).toHaveBeenCalled();
  });
});

// ── A daemon outage is not "no such task" ──────────────────────────────────
// NOT_FOUND is the one answer that tells a caller to stop retrying and go look
// for a bug in its own bookkeeping.
describe.each(WORKTASK_RPC_METHODS)('%s — daemon reachability', (method) => {
  it('reports a transport failure as UNAVAILABLE', async () => {
    const h = harness({ missionList: 'throw' });
    const res = await h.call(method, { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(res).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });

  it('reports a refusing daemon as UNAVAILABLE too', async () => {
    const h = harness({ missionList: 'not-ok' });
    const res = await h.call(method, { taskId: TASK.id, senderPtyId: 'pty-1' });
    expect(res).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });
});
