// ─── TaskAdoptService — all-or-nothing adopt, with git injected ──────────────
//
// The target repository is DERIVED, the target must be clean, and the patch is
// taken against the parent's own HEAD. Each of those is a refusal path, and the
// refusals are the point: adopting onto uncommitted work is not recoverable.

import { describe, it, expect, vi } from 'vitest';

import { TaskAdoptService, type AdoptGit } from '../TaskAdoptService';

const WT = '/wt/lane-one';
const REPO = '/repo';

/** A git that answers by subcommand; `status` and `diff` are the knobs. */
function fakeGit(opts: {
  status?: string;
  diff?: string;
  applyCode?: number;
  seen?: string[][];
}): AdoptGit {
  return async (args, cwd) => {
    opts.seen?.push([cwd, ...args]);
    const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return ok(`${REPO}/.git\n`);
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(`${REPO}\n`);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc123\n');
    if (args[0] === 'status') return ok(opts.status ?? '');
    if (args[0] === 'add') return ok('');
    if (args[0] === 'diff' && args.includes('--name-only')) return ok(opts.diff ? 'src/a.ts\nsrc/b.ts\n' : '');
    if (args[0] === 'diff') return ok(opts.diff ?? '');
    if (args[0] === 'apply') {
      return opts.applyCode === 0 || opts.applyCode === undefined
        ? ok('')
        : { stdout: '', stderr: 'patch does not apply', code: 1 };
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function service(git: AdoptGit): { svc: TaskAdoptService; written: string[] } {
  const written: string[] = [];
  const svc = new TaskAdoptService({
    git,
    writePatch: (p) => {
      written.push(p);
      return '/tmp/patch';
    },
    removePatch: vi.fn(),
  });
  return { svc, written };
}

describe('TaskAdoptService', () => {
  it('applies the task diff into the derived parent repository, unstaged', async () => {
    const seen: string[][] = [];
    const { svc, written } = service(fakeGit({ diff: 'diff --git a/src/a.ts\n', seen }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });

    expect(res).toMatchObject({ ok: true, targetRepo: REPO, files: ['src/a.ts', 'src/b.ts'] });
    expect(written).toEqual(['diff --git a/src/a.ts\n']);
    const apply = seen.find((c) => c[1] === 'apply');
    expect(apply?.[0]).toBe(REPO);
    expect(apply).toContain('--3way');
    // Unstaged on purpose — adopting is not committing.
    expect(apply).not.toContain('--index');
  });

  it('takes the patch against the parent HEAD, from inside the task worktree', async () => {
    const seen: string[][] = [];
    const { svc } = service(fakeGit({ diff: 'patch', seen }));
    await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });
    const diff = seen.find((c) => c[1] === 'diff' && c.includes('--binary'));
    expect(diff?.[0]).toBe(WT);
    expect(diff).toContain('abc123');
  });

  it('refuses when the parent repository has uncommitted changes', async () => {
    const { svc, written } = service(fakeGit({ status: ' M src/x.ts\n', diff: 'patch' }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });
    expect(res).toMatchObject({ ok: false, reason: 'dirty-target' });
    expect(written).toEqual([]);
  });

  it('refuses when the task has produced nothing', async () => {
    const { svc } = service(fakeGit({ diff: '' }));
    expect(await svc.adopt({ taskId: 'wtask-1', worktreePath: WT })).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('reports a patch that does not apply rather than claiming success', async () => {
    const { svc } = service(fakeGit({ diff: 'patch', applyCode: 1 }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });
    expect(res).toMatchObject({ ok: false, reason: 'apply-failed' });
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('did not apply cleanly');
  });

  it('refuses a task that is the main checkout, not a worktree of it', async () => {
    const git: AdoptGit = async (args) => {
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return { stdout: `${WT}/.git\n`, stderr: '', code: 0 };
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return { stdout: `${WT}\n`, stderr: '', code: 0 };
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const { svc } = service(git);
    expect(await svc.adopt({ taskId: 'wtask-1', worktreePath: WT })).toMatchObject({
      ok: false,
      reason: 'not-a-task-worktree',
    });
  });

  it('always removes the temp patch, including after a failed apply', async () => {
    const removePatch = vi.fn();
    const svc = new TaskAdoptService({
      git: fakeGit({ diff: 'patch', applyCode: 1 }),
      writePatch: () => '/tmp/patch',
      removePatch,
    });
    await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });
    expect(removePatch).toHaveBeenCalledWith('/tmp/patch');
  });
});
