// ─── TaskAdoptService — all-or-nothing adopt, with git injected ──────────────
//
// The refusals are the point: adopting onto uncommitted work is not
// recoverable, and a patch taken against the wrong base silently DELETES the
// previous task's work rather than failing. Nothing here spawns git; what is
// asserted is which commands run, with which arguments, in which directory.

import { describe, it, expect, vi } from 'vitest';

import {
  adoptCommitMessage,
  ADOPT_SUBJECT_MAX,
  parsePorcelainZ,
  TaskAdoptService,
  type AdoptGit,
} from '../TaskAdoptService';

const WT = '/wt/lane-one';
const REPO = '/repo';
const PARENT_HEAD = 'parenthead';
const TASK_HEAD = 'taskhead';
const BASE = 'mergebase';

interface Call {
  cwd: string;
  args: string[];
  env?: Record<string, string>;
}

/** A git that answers by subcommand. Every knob is a refusal path. */
function fakeGit(opts: {
  status?: string;
  /** The SECOND status read — the one taken immediately before the commit, to
   *  see whether anything outside the adopted set appeared in the meantime.
   *  Defaults to `status`. */
  statusBeforeCommit?: string;
  /** What `diff --name-only` reports, NUL-framed. Defaults to two paths. */
  names?: string;
  diff?: string;
  mergeBaseCode?: number;
  checkCode?: number;
  applyCode?: number;
  addCode?: number;
  commitCode?: number;
  statusCode?: number;
  shortCode?: number;
  calls?: Call[];
}): AdoptGit {
  let statusReads = 0;
  return async (args, cwd, env) => {
    opts.calls?.push({ cwd, args, ...(env ? { env } : {}) });
    const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
    const fail = (stderr: string, code = 1) => ({ stdout: '', stderr, code });
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return ok(`${REPO}/.git\n`);
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(`${REPO}\n`);
    if (args[0] === 'rev-parse' && args[1] === '--short') {
      return opts.shortCode ? fail('fatal: bad revision', opts.shortCode) : ok('deadbee\n');
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(cwd === REPO ? `${PARENT_HEAD}\n` : `${TASK_HEAD}\n`);
    if (args[0] === 'commit') return opts.commitCode ? fail('pre-commit hook refused') : ok('');
    if (args[0] === 'merge-base') return opts.mergeBaseCode ? fail('no merge base') : ok(`${BASE}\n`);
    if (args[0] === 'status') {
      statusReads += 1;
      if (opts.statusCode && statusReads > 1) return fail('status failed', opts.statusCode);
      return ok(statusReads === 1 ? (opts.status ?? '') : (opts.statusBeforeCommit ?? opts.status ?? ''));
    }
    if (args[0] === 'read-tree') return ok('');
    if (args[0] === 'add') return opts.addCode ? fail('add failed') : ok('');
    if (args[0] === 'diff' && args.includes('--name-only')) {
      return ok(opts.diff ? (opts.names ?? 'src/a.ts\0src/b.ts\0') : '');
    }
    if (args[0] === 'diff') return ok(opts.diff ?? '');
    if (args[0] === 'apply' && args.includes('--check')) {
      return opts.checkCode ? fail('patch does not apply') : ok('');
    }
    if (args[0] === 'apply') return opts.applyCode ? fail('patch failed mid-apply') : ok('');
    if (args[0] === 'reset' || args[0] === 'checkout' || args[0] === 'clean') return ok('');
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function service(git: AdoptGit): { svc: TaskAdoptService; written: string[]; indexCleanups: number } {
  const written: string[] = [];
  const state = { indexCleanups: 0 };
  const svc = new TaskAdoptService({
    git,
    writePatch: (p) => {
      written.push(p);
      return '/tmp/patch';
    },
    removePatch: vi.fn(),
    makeTempIndex: () => ({
      indexFile: '/tmp/idx/index',
      cleanup: () => {
        state.indexCleanups += 1;
      },
    }),
  });
  return {
    svc,
    written,
    get indexCleanups() {
      return state.indexCleanups;
    },
  };
}

describe('TaskAdoptService', () => {
  it('applies the task diff into the derived parent repository', async () => {
    const calls: Call[] = [];
    const { svc, written } = service(fakeGit({ diff: 'diff --git a/src/a.ts\n', calls }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });

    expect(res).toMatchObject({ ok: true, targetRepo: REPO, files: ['src/a.ts', 'src/b.ts'], base: BASE });
    expect(written).toEqual(['diff --git a/src/a.ts\n']);
    const apply = calls.find((c) => c.args[0] === 'apply' && !c.args.includes('--check'));
    expect(apply?.cwd).toBe(REPO);
    expect(apply?.args).toContain('--3way');
    // --3way needs the index for its merge, so what lands is STAGED. Nothing
    // commits it — that is the line adopt does not cross.
    expect(apply?.args).not.toContain('--cached');
    expect(calls.some((c) => c.args[0] === 'commit')).toBe(false);
  });

  // The whole reason this service was reviewed: diffing against the parent's
  // CURRENT head turns every commit the parent has and the task lacks into a
  // deletion. Adopt task 1, commit, adopt task 2 → task 1's work disappears.
  it('takes the patch against the MERGE BASE, never the parent HEAD', async () => {
    const calls: Call[] = [];
    const { svc } = service(fakeGit({ diff: 'patch', calls }));
    await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });

    const mergeBase = calls.find((c) => c.args[0] === 'merge-base');
    expect(mergeBase?.args).toEqual(['merge-base', PARENT_HEAD, TASK_HEAD]);
    const diff = calls.find((c) => c.args[0] === 'diff' && c.args.includes('--binary'));
    expect(diff?.cwd).toBe(WT);
    expect(diff?.args).toContain(BASE);
    expect(diff?.args).not.toContain(PARENT_HEAD);
  });

  it('refuses with needs_rebase when the two sides share no commit', async () => {
    const { svc, written } = service(fakeGit({ diff: 'patch', mergeBaseCode: 1 }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });
    expect(res).toMatchObject({ ok: false, reason: 'needs_rebase' });
    expect(written).toEqual([]);
  });

  it('builds the patch in a TEMPORARY index and always cleans it up', async () => {
    const calls: Call[] = [];
    const svc = service(fakeGit({ diff: 'patch', calls }));
    await svc.svc.adopt({ taskId: 'wtask-1', worktreePath: WT });

    // The add that makes new files visible must not touch the worker's index.
    const add = calls.find((c) => c.args[0] === 'add');
    expect(add?.env).toEqual({ GIT_INDEX_FILE: '/tmp/idx/index' });
    expect(calls.find((c) => c.args[0] === 'read-tree')?.env).toEqual({ GIT_INDEX_FILE: '/tmp/idx/index' });
    expect(calls.find((c) => c.args[0] === 'diff' && c.args.includes('--binary'))?.env).toEqual({
      GIT_INDEX_FILE: '/tmp/idx/index',
    });
    // …and the apply runs against the target's REAL index.
    expect(calls.find((c) => c.args[0] === 'apply')?.env).toBeUndefined();
    expect(svc.indexCleanups).toBe(1);
  });

  it('checks the exit code of the intent-to-add instead of diffing a stale index', async () => {
    const svc = service(fakeGit({ diff: 'patch', addCode: 1 }));
    const res = await svc.svc.adopt({ taskId: 'wtask-1', worktreePath: WT });
    expect(res).toMatchObject({ ok: false, reason: 'error' });
    // The temp index is still cleaned up on the failure path.
    expect(svc.indexCleanups).toBe(1);
  });

  it('validates with --check before writing anything, and reports a conflict', async () => {
    const calls: Call[] = [];
    const { svc } = service(fakeGit({ diff: 'patch', checkCode: 1, calls }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });

    expect(res).toMatchObject({ ok: false, reason: 'conflict', files: ['src/a.ts', 'src/b.ts'] });
    // The real apply never ran, so nothing was written to the target.
    expect(calls.filter((c) => c.args[0] === 'apply' && !c.args.includes('--check'))).toHaveLength(0);
    expect(calls.filter((c) => c.args[0] === 'checkout')).toHaveLength(0);
  });

  it('restores the touched paths when the real apply fails after --check passed', async () => {
    const calls: Call[] = [];
    const { svc } = service(fakeGit({ diff: 'patch', applyCode: 1, calls }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });

    expect(res).toMatchObject({ ok: false, reason: 'conflict' });
    // --3way can stop mid-way with markers on disk; the paths must go back.
    const reset = calls.find((c) => c.args[0] === 'reset');
    const checkout = calls.find((c) => c.args[0] === 'checkout');
    const clean = calls.find((c) => c.args[0] === 'clean');
    // `:(literal)` on every path — see the restore-globbing test below.
    expect(reset?.args).toEqual(['reset', '-q', '--', ':(literal)src/a.ts', ':(literal)src/b.ts']);
    expect(checkout?.args).toEqual(['checkout', '--', ':(literal)src/a.ts', ':(literal)src/b.ts']);
    // A file the patch CREATED cannot be checked out — it has to be removed.
    expect(clean?.args).toEqual(['clean', '-qfd', '--', ':(literal)src/a.ts', ':(literal)src/b.ts']);
    expect(reset?.cwd).toBe(REPO);
  });

  it('refuses when the parent repository has uncommitted changes', async () => {
    const { svc, written } = service(fakeGit({ status: ' M src/x.ts\0', diff: 'patch' }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });
    expect(res).toMatchObject({ ok: false, reason: 'dirty-target' });
    expect(written).toEqual([]);
  });

  it('refuses when the task has produced nothing', async () => {
    const { svc } = service(fakeGit({ diff: '' }));
    expect(await svc.adopt({ taskId: 'wtask-1', worktreePath: WT })).toMatchObject({ ok: false, reason: 'empty' });
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
      makeTempIndex: () => ({ indexFile: '/tmp/idx/index', cleanup: vi.fn() }),
    });
    await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });
    expect(removePatch).toHaveBeenCalledWith('/tmp/patch');
  });

  // ── commit: true — the sequential-adoption path ───────────────────────────
  //
  // Without it a brain adopting four tasks in a row dead-ends on task two: the
  // first adopt leaves the target staged-dirty and the dirty-target check
  // refuses everything after it.
  it('commits what it applied and returns the short sha when commit: true', async () => {
    const calls: Call[] = [];
    const { svc } = service(fakeGit({ diff: 'patch', calls }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT, commit: true, title: 'lane one' });

    expect(res).toMatchObject({ ok: true, targetRepo: REPO, commit: 'deadbee' });
    const commit = calls.find((c) => c.args[0] === 'commit');
    // No pathspec: the target was clean, so the index holds the adopted patch
    // and nothing else. A pathspec would commit the working tree instead of the
    // --3way merge git just staged.
    expect(commit?.args).toEqual(['commit', '-m', 'adopt: lane one (wtask-1)']);
    expect(commit?.cwd).toBe(REPO);
  });

  it('restores the applied paths and reports commit-failed when the commit is refused', async () => {
    const calls: Call[] = [];
    const { svc } = service(fakeGit({ diff: 'patch', commitCode: 1, calls }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT, commit: true, title: 'lane one' });

    expect(res).toMatchObject({ ok: false, reason: 'commit-failed', files: ['src/a.ts', 'src/b.ts'] });
    // Leaving the patch staged is the one outcome the caller did not ask for —
    // it is exactly the state that blocks the next adopt.
    expect(calls.find((c) => c.args[0] === 'reset')?.args).toEqual([
      'reset', '-q', '--', ':(literal)src/a.ts', ':(literal)src/b.ts',
    ]);
    expect(calls.find((c) => c.args[0] === 'checkout')?.args).toEqual([
      'checkout', '--', ':(literal)src/a.ts', ':(literal)src/b.ts',
    ]);
    expect(calls.find((c) => c.args[0] === 'clean')?.args).toEqual([
      'clean', '-qfd', '--', ':(literal)src/a.ts', ':(literal)src/b.ts',
    ]);
  });

  it('still leaves the changes staged when commit is omitted', async () => {
    const calls: Call[] = [];
    const { svc } = service(fakeGit({ diff: 'patch', calls }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT });
    expect(res).toMatchObject({ ok: true });
    expect(res).not.toHaveProperty('commit');
    expect(calls.some((c) => c.args[0] === 'commit')).toBe(false);
  });

  // ── The commit takes the whole index, so the index is re-checked ─────────
  //
  // The clean check and the commit are a dozen git calls apart. A human staging
  // a file in that window would have their work committed under a message that
  // says it is one task's adoption — and nobody would look, because the adopt
  // reported ok.
  it('refuses to commit when a path outside the adopted set was staged after the clean check', async () => {
    const calls: Call[] = [];
    const { svc } = service(
      fakeGit({ diff: 'patch', statusBeforeCommit: 'M  src/a.ts\0A  NOTES.md\0', calls }),
    );
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT, commit: true, title: 'lane one' });

    expect(res).toMatchObject({ ok: false, reason: 'commit-failed' });
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('NOTES.md');
    expect(calls.some((c) => c.args[0] === 'commit')).toBe(false);
    // The human's file is not in the restore either — only the adopted paths.
    const reset = calls.find((c) => c.args[0] === 'reset');
    expect(reset?.args).toEqual(['reset', '-q', '--', ':(literal)src/a.ts', ':(literal)src/b.ts']);
  });

  it('commits when the only staged paths are the adopted ones', async () => {
    const calls: Call[] = [];
    const { svc } = service(fakeGit({ diff: 'patch', statusBeforeCommit: 'M  src/a.ts\0A  src/b.ts\0', calls }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT, commit: true, title: 'lane one' });
    expect(res).toMatchObject({ ok: true, commit: 'deadbee' });
    expect(calls.filter((c) => c.args[0] === 'status')).toHaveLength(2);
  });

  it('treats a failed re-read as a refusal rather than committing blind', async () => {
    const calls: Call[] = [];
    const { svc } = service(fakeGit({ diff: 'patch', statusCode: 128, calls }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT, commit: true });
    expect(res).toMatchObject({ ok: false, reason: 'commit-failed' });
    expect(calls.some((c) => c.args[0] === 'commit')).toBe(false);
  });

  // ── Restore is pathspec-shaped, so paths must be marked literal ───────────
  it('never lets a path with glob characters widen the restore', async () => {
    const calls: Call[] = [];
    const { svc } = service(fakeGit({ diff: 'patch', names: 'src/a*.ts\0', commitCode: 1, calls }));
    await svc.adopt({ taskId: 'wtask-1', worktreePath: WT, commit: true });
    // Without `:(literal)` this would reset, check out and CLEAN every path
    // matching `src/a*.ts` — a wider blast radius than the patch had.
    expect(calls.find((c) => c.args[0] === 'clean')?.args).toEqual([
      'clean',
      '-qfd',
      '--',
      ':(literal)src/a*.ts',
    ]);
  });

  // ── A commit that happened must never be reported as one that did not ────
  it('omits commit and warns when the sha cannot be read back', async () => {
    const { svc } = service(fakeGit({ diff: 'patch', shortCode: 1 }));
    const res = await svc.adopt({ taskId: 'wtask-1', worktreePath: WT, commit: true });
    expect(res).toMatchObject({ ok: true });
    // '' read as "nothing was committed" to every caller that checks
    // truthiness — the opposite of what happened.
    expect(res).not.toHaveProperty('commit');
    if (!res.ok) throw new Error('unreachable');
    expect(res.warning).toContain('would not name it');
  });

  // Two adopts landing at once would both see a clean tree, and the second
  // would apply on top of the first's output — with no conflict to report.
  it('serializes adopts against the same target repository', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const inner = fakeGit({ diff: 'patch' });
    const git: AdoptGit = async (args, cwd, env) => {
      if (args[0] === 'status') {
        const mine = first ? 'a' : 'b';
        first = false;
        order.push(`status:${mine}`);
        if (mine === 'a') await gate;
        order.push(`done:${mine}`);
      }
      return inner(args, cwd, env);
    };
    const { svc } = service(git);
    const a = svc.adopt({ taskId: 'wtask-1', worktreePath: WT });
    const b = svc.adopt({ taskId: 'wtask-2', worktreePath: WT });
    await new Promise((r) => setTimeout(r, 0));
    // The second adopt has not even reached its clean check yet.
    expect(order).toEqual(['status:a']);
    release?.();
    await Promise.all([a, b]);
    expect(order).toEqual(['status:a', 'done:a', 'status:b', 'done:b']);
  });

  it('keeps the lock usable after an adopt rejects', async () => {
    let calls = 0;
    const inner = fakeGit({ diff: 'patch' });
    const git: AdoptGit = async (args, cwd, env) => {
      if (args[0] === 'status' && calls++ === 0) throw new Error('boom');
      return inner(args, cwd, env);
    };
    const { svc } = service(git);
    await expect(svc.adopt({ taskId: 'wtask-1', worktreePath: WT })).rejects.toThrow('boom');
    // A poisoned chain would leave every later adopt rejecting with 'boom'.
    expect(await svc.adopt({ taskId: 'wtask-2', worktreePath: WT })).toMatchObject({ ok: true });
  });
});

describe('adoptCommitMessage', () => {
  it('names the task, and falls back to the id when there is no title', () => {
    expect(adoptCommitMessage('wtask-1', 'lane one')).toBe('adopt: lane one (wtask-1)');
    expect(adoptCommitMessage('wtask-1')).toBe('adopt: wtask-1 (wtask-1)');
    expect(adoptCommitMessage('wtask-1', '   ')).toBe('adopt: wtask-1 (wtask-1)');
  });

  it('keeps the subject to one bounded line', () => {
    expect(adoptCommitMessage('wtask-1', 'first\nsecond')).toBe('adopt: first (wtask-1)');
    const long = adoptCommitMessage('wtask-1', 'x'.repeat(ADOPT_SUBJECT_MAX + 40));
    expect(long.length).toBe(`adopt:  (wtask-1)`.length + ADOPT_SUBJECT_MAX);
    expect(long.endsWith('\u2026 (wtask-1)')).toBe(true);
  });

  // The projection row is the daemon's, but an LLM wrote the text in it when
  // the task was fanned out — so the title is untrusted text arriving by a
  // trusted route.
  it('strips control characters an LLM-written title may carry', () => {
    expect(adoptCommitMessage('wtask-1', 'lane\u001b[31mone\r')).toBe('adopt: lane [31mone (wtask-1)');
    expect(adoptCommitMessage('wtask-1', 'a\tb')).toBe('adopt: a b (wtask-1)');
    expect(adoptCommitMessage('wtask-1', '\u0000\u0007')).toBe('adopt: wtask-1 (wtask-1)');
  });

  it('bounds by code point, so a cut never leaves half a surrogate pair', () => {
    // Each emoji is TWO UTF-16 units: a length-based slice at ADOPT_SUBJECT_MAX
    // would land inside one and emit a lone surrogate.
    const subject = adoptCommitMessage('wtask-1', '\u{1f642}'.repeat(ADOPT_SUBJECT_MAX + 10));
    const title = subject.slice('adopt: '.length, -' (wtask-1)'.length);
    expect(Array.from(title)).toHaveLength(ADOPT_SUBJECT_MAX);
    expect(title.endsWith('\u2026')).toBe(true);
    // No lone surrogate survives once the well-formed pairs are removed.
    expect(/[\uD800-\uDFFF]/.test(title.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false);
  });
});

describe('parsePorcelainZ', () => {
  it('reads NUL-framed records, so a path with a newline is one entry', () => {
    expect(parsePorcelainZ(' M src/a\nb.ts\0?? src/c.ts\0')).toEqual([
      { status: ' M', path: 'src/a\nb.ts' },
      { status: '??', path: 'src/c.ts' },
    ]);
  });

  it('consumes a rename origin record with the rename that owns it', () => {
    expect(parsePorcelainZ('R  new.ts\0old.ts\0 M other.ts\0')).toEqual([
      { status: 'R ', path: 'new.ts' },
      { status: ' M', path: 'other.ts' },
    ]);
  });

  it('reads a non-ASCII path verbatim (-z suppresses git quoting)', () => {
    expect(parsePorcelainZ(' M src/é.ts\0')).toEqual([{ status: ' M', path: 'src/é.ts' }]);
  });

  it('is empty for a clean tree', () => {
    expect(parsePorcelainZ('')).toEqual([]);
  });
});
