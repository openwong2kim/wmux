// ─── task.gate.* / task.adopt / task.close / task.pr — the wire trust boundary ─
//
// These five methods let a non-human close tasks, write to repositories and open
// PRs, so what is pinned here is the REFUSALS: a remote caller, a stated
// identity, a task someone else owns, a task that never materialized. The happy
// paths are asserted only to the extent of "the same service the GUI drives was
// called with server-derived arguments" — the services' own behaviour (close
// ordering, gh gates) is pinned in their own tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  TASK_APPROVALS_MAX_PENDING_PER_WORKSPACE,
  type TaskApprovalOutcome,
  type TaskApprovalPort,
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
/** Where the calling terminal is, and therefore the repository the read methods
 *  answer for when no task is named. */
const CALLER_CWD = '/repo/main/src';
const CALLER_REPO = '/repo/main';
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
  requestApproval: ReturnType<typeof vi.fn>;
  callerCwd: ReturnType<typeof vi.fn>;
  missionListParams: () => Record<string, unknown> | undefined;
}

function harness(opts?: {
  tasks?: unknown[];
  ownerWorkspaceId?: string | null;
  onDisk?: boolean;
  exec?: WorktaskExec;
  /** 'throw' = transport failure, 'not-ok' = the daemon refusing. */
  missionList?: 'throw' | 'not-ok';
  /** How the human answers the close/pr prompt. Defaults to approved so the
   *  refusal tests below still see the gates they are about. */
  approval?: TaskApprovalOutcome;
  /** Full control of the prompt (dedupe / cap tests hold it open). */
  requestApproval?: TaskApprovalPort;
  /** The calling terminal's cwd, for the reads that name no task. */
  callerCwd?: (workspaceId: string, senderPtyId: string) => Promise<string>;
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

  const exec = vi.fn(
    opts?.exec ??
      (async (_cmd: 'git' | 'gh', args: string[]) =>
        args[0] === 'rev-parse' && args.includes('--show-toplevel')
          ? { stdout: `${CALLER_REPO}\n`, stderr: '', code: 0 }
          : { stdout: '', stderr: '', code: 0 }),
  );
  const requestApproval = vi.fn(
    opts?.requestApproval ?? (async () => opts?.approval ?? ('approved' as TaskApprovalOutcome)),
  );

  const callerCwd = vi.fn(opts?.callerCwd ?? (async () => CALLER_CWD));

  const deps: WorktaskRpcDeps = {
    daemon,
    exec: exec as unknown as WorktaskExec,
    requestApproval,
    callerCwd,
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
    requestApproval,
    callerCwd,
    missionListParams: () => missionParams,
  };
}

/** The two reads that also answer for the caller's own repository. */
const CALLER_REPO_METHODS = ['task.git.status', 'task.git.log'] as const;

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

  it('requires a taskId, unless it is one of the two caller-repo reads', async () => {
    const h = harness();
    const res = await h.call(method, { senderPtyId: 'pty-1' });
    if ((CALLER_REPO_METHODS as readonly string[]).includes(method)) {
      expect(res).toMatchObject({ ok: true, target: 'caller-repo', repoRoot: CALLER_REPO });
    } else {
      expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
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
    expect(h.adopt).toHaveBeenCalledWith({
      taskId: TASK.id,
      worktreePath: TASK.worktreePath,
      commit: false,
      title: TASK.title,
    });
    expect(res).toMatchObject({ ok: true, files: ['a.ts'] });
  });

  it('passes commit: true through, with the title from the SERVER projection row', async () => {
    const h = harness();
    await h.call('task.adopt', { taskId: TASK.id, senderPtyId: 'pty-1', commit: true, title: 'spoofed' });
    expect(h.adopt).toHaveBeenCalledWith({
      taskId: TASK.id,
      worktreePath: TASK.worktreePath,
      commit: true,
      title: TASK.title,
    });
  });

  it('refuses a non-boolean commit rather than silently staging', async () => {
    const h = harness();
    const res = await h.call('task.adopt', { taskId: TASK.id, senderPtyId: 'pty-1', commit: 'true' });
    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(h.adopt).not.toHaveBeenCalled();
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

// ── No taskId: the CALLER'S OWN repository ─────────────────────────────────
// A brain that had just adopted four tasks into its parent checkout could not
// read that checkout — every read wanted a task id, and the parent repository
// is not a task.
describe('task.git.status / task.git.log without a taskId', () => {
  const COMMANDER: RpcContext = { origin: 'local', commanderWorkspace: CALLER_WS };

  it('reads the repository the calling terminal is in, and names it', async () => {
    const h = harness();
    const res = await h.call('task.git.status', { senderPtyId: 'pty-1' });
    expect(h.callerCwd).toHaveBeenCalledWith(CALLER_WS, 'pty-1');
    // The cwd is normalised to the git TOPLEVEL, so a subdirectory answers for
    // the whole repository.
    expect(h.exec).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], CALLER_CWD);
    expect(h.exec).toHaveBeenCalledWith('git', ['status', '--porcelain=v1', '--branch', '-z'], CALLER_REPO);
    expect(res).toMatchObject({ ok: true, target: 'caller-repo', repoRoot: CALLER_REPO });
    expect(res).not.toHaveProperty('taskId');
  });

  it('never asks the daemon for a task list it does not need', async () => {
    const h = harness();
    await h.call('task.git.log', { senderPtyId: 'pty-1' });
    expect(h.missionListParams()).toBeUndefined();
    expect(h.exec).toHaveBeenCalledWith('git', expect.arrayContaining(['log']), CALLER_REPO);
  });

  it('borrows the workspace active pane for a commander caller, which has no pty', async () => {
    const h = harness();
    expect(await h.call('task.git.status', {}, COMMANDER)).toMatchObject({
      ok: true,
      target: 'caller-repo',
      repoRoot: CALLER_REPO,
    });
    expect(h.callerCwd).toHaveBeenCalledWith(CALLER_WS, '');
  });

  it('still refuses a task the caller does not own — omitting the id is the only way out', async () => {
    const h = harness({ tasks: [] });
    expect(await h.call('task.git.status', { taskId: TASK.id, senderPtyId: 'pty-1' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('still refuses a caller-stated verifiedWorkspaceId with no taskId to hide behind', async () => {
    const h = harness();
    expect(
      await h.call('task.git.status', { senderPtyId: 'pty-1', verifiedWorkspaceId: 'ws-other' }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(h.callerCwd).not.toHaveBeenCalled();
  });

  it('refuses when the calling terminal reports no directory', async () => {
    const h = harness({ callerCwd: async () => '' });
    expect(await h.call('task.git.status', { senderPtyId: 'pty-1' })).toMatchObject({
      ok: false,
      error: { code: 'FAILED_PRECONDITION' },
    });
  });

  it('refuses a cwd that is not inside a git repository', async () => {
    const h = harness({ exec: async () => ({ stdout: '', stderr: 'not a git repository', code: 128 }) });
    expect(await h.call('task.git.log', { senderPtyId: 'pty-1' })).toMatchObject({
      ok: false,
      error: { code: 'FAILED_PRECONDITION' },
    });
  });

  it('refuses a cwd that looks like a flag, carries control characters, or is relative', async () => {
    // A RELATIVE cwd used to be resolved against the DAEMON's own working
    // directory — a repository that has nothing to do with the calling pane.
    for (const bad of ['--upload-pack=evil', '/repo\u0007/x', 'src', '.', '../elsewhere']) {
      const h = harness({ callerCwd: async () => bad });
      expect(await h.call('task.git.status', { senderPtyId: 'pty-1' })).toMatchObject({
        ok: false,
        error: { code: 'FAILED_PRECONDITION' },
      });
      expect(h.exec).not.toHaveBeenCalled();
    }
  });

  // Same rule as the fan-out gate's repoRootOf: two names for one repository
  // must not read as two repositories.
  it('realpaths the toplevel, so a symlinked checkout cannot alias another repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rpc-repo-'));
    const real = path.join(dir, 'real');
    const link = path.join(dir, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    try {
      const h = harness({
        callerCwd: async () => link,
        exec: async (_cmd, args) =>
          args.includes('--show-toplevel')
            ? { stdout: `${link}\n`, stderr: '', code: 0 }
            : { stdout: '', stderr: '', code: 0 },
      });
      expect(await h.call('task.git.status', { senderPtyId: 'pty-1' })).toMatchObject({
        ok: true,
        target: 'caller-repo',
        repoRoot: fs.realpathSync(real),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // `z.string().min(1)` lets ' ' through. Trimming it to '' and falling into
  // the caller-repo branch answered a question about a TASK with a different
  // repository's state, under ok: true.
  it('refuses a taskId that is present but blank rather than reading the caller repo', async () => {
    for (const blank of ['', '   ', '\t']) {
      const h = harness();
      expect(await h.call('task.git.status', { taskId: blank, senderPtyId: 'pty-1' })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_ARGUMENT' },
      });
      expect(h.callerCwd).not.toHaveBeenCalled();
    }
    const h = harness();
    expect(await h.call('task.git.log', { taskId: 42, senderPtyId: 'pty-1' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(h.callerCwd).not.toHaveBeenCalled();
  });

  it('names the target on a task read too, so the two can never be confused', async () => {
    const h = harness();
    expect(await h.call('task.git.status', { taskId: TASK.id, senderPtyId: 'pty-1' })).toMatchObject({
      ok: true,
      target: 'task',
      taskId: TASK.id,
    });
    expect(await h.call('task.git.log', { taskId: TASK.id, senderPtyId: 'pty-1' })).toMatchObject({
      ok: true,
      target: 'task',
      taskId: TASK.id,
    });
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

// ── Human approval on the two irreversible methods ─────────────────────────
// A commander brain's own tools are auto-allowed by the SDK adapter, so for the
// caller these methods exist for there is no upstream permission prompt to be
// the second of. Removing a worktree and pushing a branch to a remote are the
// two effects here that no returned result can take back.
describe('task.close / task.pr approval gate', () => {
  const COMMANDER: RpcContext = { origin: 'local', commanderWorkspace: CALLER_WS };

  it('refuses task.close when the user declines, and never reaches the service', async () => {
    const h = harness({ approval: 'declined' });
    const res = await h.call('task.close', { taskId: TASK.id }, COMMANDER);
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(String((res as { error: { message: string } }).error.message)).toContain('the user denied it');
    expect(h.closeTask).not.toHaveBeenCalled();
  });

  it('refuses task.pr when nobody answers, and says so was the timer', async () => {
    const h = harness({ approval: 'timeout' });
    const res = await h.call('task.pr', { taskId: TASK.id }, COMMANDER);
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(String((res as { error: { message: string } }).error.message)).toContain('expired');
    expect(h.createPr).not.toHaveBeenCalled();
  });

  it('refuses when the prompt could not be shown at all (fail closed)', async () => {
    const h = harness({ approval: 'unavailable' });
    expect(await h.call('task.close', { taskId: TASK.id }, COMMANDER)).toMatchObject({
      ok: false,
      error: { code: 'NOT_AUTHORIZED' },
    });
    expect(h.closeTask).not.toHaveBeenCalled();
  });

  it('proceeds once approved, and asks about the SERVER\'s own projection row', async () => {
    const h = harness();
    expect(await h.call('task.close', { taskId: TASK.id }, COMMANDER)).toMatchObject({ ok: true });
    expect(h.closeTask).toHaveBeenCalled();
    expect(h.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'close',
        taskId: TASK.id,
        title: TASK.title,
        branch: TASK.branch,
        worktreePath: TASK.worktreePath,
        workspaceId: CALLER_WS,
      }),
    );
  });

  it('leaves the reversible and read-only methods unprompted', async () => {
    for (const method of ['task.gate.run', 'task.adopt', 'task.git.status', 'task.git.log', 'task.gh.prView']) {
      const h = harness({ approval: 'declined' });
      await h.call(method, { taskId: TASK.id }, COMMANDER);
      expect(h.requestApproval, `${method} raised a prompt`).not.toHaveBeenCalled();
    }
  });
});

// ── The prompt is about a COMMIT, not a branch name ────────────────────────
// The worker owning this worktree is still running while the dialog is up.
describe('task.pr branch-tip binding', () => {
  const COMMANDER: RpcContext = { origin: 'local', commanderWorkspace: CALLER_WS };

  function tipHarness(tips: string[]) {
    let n = 0;
    return harness({
      exec: (async (_cmd, args) => {
        if (args[0] === 'rev-parse') {
          const tip = tips[Math.min(n, tips.length - 1)] ?? '';
          n += 1;
          return { stdout: `${tip}\n`, stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 0 };
      }) as WorktaskExec,
    });
  }

  it('shows the tip it captured and pushes when it has not moved', async () => {
    const h = tipHarness(['abc1234', 'abc1234']);
    expect(await h.call('task.pr', { taskId: TASK.id }, COMMANDER)).toMatchObject({ ok: true });
    expect(h.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ branchTip: 'abc1234' }));
    expect(h.createPr).toHaveBeenCalled();
  });

  it('refuses when the branch moved while the approval was on screen', async () => {
    const h = tipHarness(['abc1234', 'def5678']);
    const res = await h.call('task.pr', { taskId: TASK.id }, COMMANDER);
    expect(res).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
    expect(String((res as { error: { message: string } }).error.message)).toContain('abc1234');
    expect(h.createPr).not.toHaveBeenCalled();
  });
});

// ── One question, asked once; and a bounded queue ──────────────────────────
describe('task approval dedupe and cap', () => {
  const COMMANDER: RpcContext = { origin: 'local', commanderWorkspace: CALLER_WS };

  it('reuses one pending prompt for an identical retried request', async () => {
    // A holder, not a bare `let`: TS does not track assignments made inside a
    // callback and would narrow the variable to `never`.
    const answer: { resolve: ((outcome: TaskApprovalOutcome) => void) | null } = { resolve: null };
    const requestApproval = vi.fn(
      () => new Promise<TaskApprovalOutcome>((resolve) => { answer.resolve = resolve; }),
    );
    const h = harness({ requestApproval });

    const a = h.call('task.close', { taskId: TASK.id }, COMMANDER);
    const b = h.call('task.close', { taskId: TASK.id }, COMMANDER);
    await new Promise((r) => setTimeout(r, 0));
    // One dialog, not two: it is literally the same question.
    expect(requestApproval).toHaveBeenCalledTimes(1);

    answer.resolve?.('approved');
    expect(await a).toMatchObject({ ok: true });
    expect(await b).toMatchObject({ ok: true });
  });

  it('refuses past the per-workspace cap instead of stacking dialogs', async () => {
    const requestApproval = vi.fn(() => new Promise<TaskApprovalOutcome>(() => undefined));
    const tasks = Array.from({ length: TASK_APPROVALS_MAX_PENDING_PER_WORKSPACE + 1 }, (_, i) => ({
      ...TASK,
      id: `wtask-${i}`,
    }));
    const h = harness({ tasks, requestApproval });

    for (let i = 0; i < TASK_APPROVALS_MAX_PENDING_PER_WORKSPACE; i++) {
      void h.call('task.close', { taskId: `wtask-${i}` }, COMMANDER);
    }
    await new Promise((r) => setTimeout(r, 0));
    const overflow = await h.call(
      'task.close',
      { taskId: `wtask-${TASK_APPROVALS_MAX_PENDING_PER_WORKSPACE}` },
      COMMANDER,
    );
    expect(overflow).toMatchObject({ ok: false, error: { code: 'RESOURCE_EXHAUSTED' } });
    expect(requestApproval).toHaveBeenCalledTimes(TASK_APPROVALS_MAX_PENDING_PER_WORKSPACE);
  });
});
