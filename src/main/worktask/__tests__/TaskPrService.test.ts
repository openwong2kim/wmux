// ─── TaskPrService — J3 §2 gh four-gate one-click PR ────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { TaskPrService, type PrExec, type CreatePrInput } from '../TaskPrService';

const VALID_PR = 'https://github.com/acme/widget/pull/42';

const INPUT: CreatePrInput = {
  taskId: 'wtask-1',
  verifiedWorkspaceId: 'ws-owner',
  worktreePath: '/wt/task-1',
  branch: 'wtask/task-1-abcd1234',
  title: 'Fix the thing',
};

/** exec stub: return stdout or throw per (cmd,args) signature. Exposes call log. */
function makeExec(
  behavior: (cmd: string, args: string[]) => { stdout: string } | { throw: string },
): { exec: PrExec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: PrExec = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = behavior(cmd, args);
    if ('throw' in r) {
      const err = new Error(r.throw) as Error & { stderr?: string };
      err.stderr = r.throw;
      throw err;
    }
    return { stdout: r.stdout, stderr: '' };
  };
  return { exec, calls };
}

function isGh(cmd: string): boolean {
  return cmd === 'gh' || cmd === 'gh.exe';
}
function argStr(args: string[]): string {
  return args.join(' ');
}

/** Default happy-path behavior (tests override individual stubs). */
function happyBehavior(cmd: string, args: string[]): { stdout: string } | { throw: string } {
  const a = argStr(args);
  if (isGh(cmd)) {
    if (a.startsWith('--version')) return { stdout: 'gh version 2.0.0' };
    if (a.startsWith('auth status')) return { stdout: 'Logged in' };
    if (a.startsWith('repo view')) return { stdout: 'main' };
    if (a.startsWith('pr create')) return { stdout: `Creating pull request\n${VALID_PR}` };
    if (a.startsWith('pr list')) return { stdout: VALID_PR };
  }
  if (cmd === 'git') {
    if (a.startsWith('status')) return { stdout: '' }; // clean
    if (a.startsWith('remote')) return { stdout: 'origin' };
    if (a.startsWith('push')) return { stdout: '' };
  }
  return { stdout: '' };
}

function makeService(exec: PrExec, opts?: { daemonOk?: boolean }) {
  const daemonCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const daemon = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      daemonCalls.push({ method, params });
      return { ok: opts?.daemonOk ?? true };
    }),
  };
  const invalidate = vi.fn();
  const svc = new TaskPrService({ daemon, cache: { invalidate }, exec });
  return { svc, daemon, daemonCalls, invalidate };
}

describe('J3 §2 gh gate (version·auth)', () => {
  it('gh not installed: gh-missing + browser fallback', async () => {
    const { exec } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('--version') ? { throw: 'not found' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('gh-missing');
    expect(res.browseFallback).toBeTruthy();
  });

  it('gh not authenticated (version ok): gh-unauth', async () => {
    const { exec } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('auth status') ? { throw: 'not logged in' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('gh-unauth');
  });
});

describe('J3 §2 dirty block (CX7)', () => {
  it('uncommitted changes block as dirty before push', async () => {
    const { exec, calls } = makeExec((cmd, args) =>
      cmd === 'git' && argStr(args).startsWith('status') ? { stdout: ' M file.ts\n' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('dirty');
    // push must not have run (stopped after block).
    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')).toBeUndefined();
  });
});

describe('J3 §2 no-origin (fork·multi-remote auto-guess forbidden §7·CL9)', () => {
  it('missing origin remote is explicit error', async () => {
    const { exec } = makeExec((cmd, args) =>
      cmd === 'git' && argStr(args).startsWith('remote') ? { stdout: 'upstream\nfork' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('no-origin');
  });
});

describe('J3 §2 normal one-click PR', () => {
  it('push + pr create (--base explicit) + prUrl commit + invalidate', async () => {
    const { exec, calls } = makeExec(happyBehavior);
    const { svc, daemonCalls, invalidate } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.prUrl).toBe(VALID_PR);

    // push -u origin -- {branch} (F6 separator).
    const push = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
    expect(push?.args).toEqual(['push', '-u', 'origin', '--', INPUT.branch]);

    // pr create received --base with actual value (main).
    const create = calls.find((c) => isGh(c.cmd) && c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create?.args).toContain('--base');
    const baseIdx = create!.args.indexOf('--base');
    expect(create!.args[baseIdx + 1]).toBe('main');
    // --head also explicit as branch.
    expect(create!.args).toContain('--head');

    // prUrl daemon commit + PrStatusCache invalidate.
    const upd = daemonCalls.find((c) => c.method === 'task.mission.update');
    expect(upd?.params.prUrl).toBe(VALID_PR);
    expect(invalidate).toHaveBeenCalledWith(INPUT.worktreePath, INPUT.branch);
  });

  it('F6 — repo view failure → explicit error without base guess (no pr create)', async () => {
    const { exec, calls } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('repo view') ? { throw: 'no default' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
    expect(res.error).toContain('base');
    // when base unknown, must not attempt pr create (avoid wrong base).
    expect(calls.find((c) => isGh(c.cmd) && c.args[0] === 'pr' && c.args[1] === 'create')).toBeUndefined();
  });

  it('F6 — empty defaultBranchRef response is explicit error', async () => {
    const { exec } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('repo view') ? { stdout: '' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
  });
});

describe('J3 §2 idempotent re-entry (CX5+G4)', () => {
  it('pr create failure → converge via pr list to existing URL', async () => {
    const { exec } = makeExec((cmd, args) => {
      const a = argStr(args);
      if (isGh(cmd) && a.startsWith('pr create')) return { throw: 'a pull request already exists' };
      if (isGh(cmd) && a.startsWith('pr list')) return { stdout: VALID_PR };
      return happyBehavior(cmd, args);
    });
    const { svc, daemonCalls } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.recovered).toBe(true);
    expect(res.prUrl).toBe(VALID_PR);
    // recovery path also commits prUrl.
    expect(daemonCalls.find((c) => c.method === 'task.mission.update')?.params.prUrl).toBe(VALID_PR);
  });

  it('pr create failure + no existing PR → pr-failed', async () => {
    const { exec } = makeExec((cmd, args) => {
      const a = argStr(args);
      if (isGh(cmd) && a.startsWith('pr create')) return { throw: 'boom' };
      if (isGh(cmd) && a.startsWith('pr list')) return { stdout: '' };
      return happyBehavior(cmd, args);
    });
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
  });
});

describe('J3 §2 URL validation (G5)', () => {
  it('pr create emits non-github URL → pr-failed when recovery fails', async () => {
    const { exec } = makeExec((cmd, args) => {
      const a = argStr(args);
      if (isGh(cmd) && a.startsWith('pr create')) return { stdout: 'https://evil.example.com/pull/1' };
      if (isGh(cmd) && a.startsWith('pr list')) return { stdout: '' };
      return happyBehavior(cmd, args);
    });
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
  });
});

describe('J3 §2 push failure', () => {
  it('git push failure → push-failed', async () => {
    const { exec } = makeExec((cmd, args) =>
      cmd === 'git' && argStr(args).startsWith('push') ? { throw: 'permission denied' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('push-failed');
  });
});

describe('J3 §2 prUrl commit failure (non-fatal)', () => {
  it('daemon update failure marked commitPending (PR itself succeeds)', async () => {
    const { exec } = makeExec(happyBehavior);
    const { svc } = makeService(exec, { daemonOk: false });
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.commitPending).toBe(true);
    expect(res.prUrl).toBe(VALID_PR);
  });
});
