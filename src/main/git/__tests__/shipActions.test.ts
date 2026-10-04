import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { ShipActions, parseStatusV2, parseSymrefHead, type ShipStatus } from '../shipActions';
import { checkWrite, parseExpect, shipInputOf } from '../../ipc/handlers/gitShip.handler';
import { parseBranchDates, parseGitdirFile } from '../../ipc/handlers/worktree.handler';

type Call = { cmd: string; args: string[]; env: NodeJS.ProcessEnv };
const HEAD = 'a'.repeat(40);
const EXPECT = { branch: 'feat/x', head: HEAD };

function make(answer: (cmd: string, args: string[]) => string | Error, exists: (p: string) => boolean = () => false) {
  const calls: Call[] = [];
  const run = vi.fn(async (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: opts.env });
    const r = answer(cmd, args);
    if (r instanceof Error) throw r;
    return { stdout: r };
  });
  const prOf = vi.fn(async () => ({ number: 3, state: 'open' as const, checks: null, url: 'https://github.com/o/r/pull/3' }));
  const forgetPr = vi.fn();
  return { svc: new ShipActions(run as never, prOf, forgetPr, () => 1_000, exists), calls, prOf, forgetPr };
}

/** A fake git that answers the pin checks with `head` on `branch`. */
const onBranch = (rest: (args: string[]) => string | Error = () => '', head = HEAD, branch = 'feat/x') => (_c: string, args: string[]) => {
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${head}\n`;
  if (args[0] === 'symbolic-ref' && args[1] === '-q') return `${branch}\n`;
  return rest(args);
};

const STATUS = [
  `# branch.oid ${HEAD}`,
  '# branch.head feat/x',
  '# branch.upstream origin/feat/x',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
  '2 R. N... 100644 100644 100644 aaa bbb R100 src/b.ts\tsrc/old.ts',
  'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/c.ts',
  '? notes.txt',
  '! ignored.log',
].join('\n');

describe('parseStatusV2', () => {
  it('reads branch, HEAD, upstream, ahead/behind, and counts changes and conflicts apart', () => {
    expect(parseStatusV2(STATUS)).toEqual({
      branch: 'feat/x', head: HEAD, detached: false, upstream: 'origin/feat/x', ahead: 2, behind: 1, dirty: 3, conflicts: 1,
    });
  });

  it('a detached HEAD with no upstream, and an empty repo', () => {
    expect(parseStatusV2('# branch.oid abc\n# branch.head (detached)\n')).toMatchObject({ branch: null, detached: true, upstream: null });
    expect(parseStatusV2('# branch.oid (initial)\n# branch.head main\n').head).toBe('');
  });

  it('parseSymrefHead reads the remote HEAD', () => {
    expect(parseSymrefHead(`ref: refs/heads/trunk\tHEAD\n${HEAD}\tHEAD\n`)).toBe('trunk');
    expect(parseSymrefHead('')).toBeNull();
  });
});

describe('ShipActions.status', () => {
  it('joins git status, merge / cherry-pick in progress, the default branch, the subject and the PR', async () => {
    const { svc, prOf } = make((_c, args) => {
      if (args[0] === 'status') return STATUS;
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return '.git/MERGE_HEAD\n.git/CHERRY_PICK_HEAD\n';
      if (args[0] === 'symbolic-ref') return 'origin/main\n';
      if (args[0] === 'log') return 'feat: add x\n';
      return '';
    }, (p) => p.endsWith('MERGE_HEAD'));
    const res = await svc.status('/repo');
    expect(res.ok && res.status).toMatchObject({
      branch: 'feat/x', head: HEAD, conflicts: 1, inProgress: true, defaultBranch: 'main', headSubject: 'feat: add x',
      pr: { state: 'open', url: 'https://github.com/o/r/pull/3' },
    });
    expect(prOf).toHaveBeenCalledWith('/repo', 'feat/x');
  });

  it('without origin/HEAD asks the remote once (cached), and says unknown when it cannot', async () => {
    let symref: string | Error = `ref: refs/heads/trunk\tHEAD\n`;
    const { svc, calls } = make((_c, args) => {
      if (args[0] === 'status') return STATUS.split('\n').slice(0, 4).join('\n');
      if (args[0] === 'symbolic-ref') return new Error('not a symbolic ref');
      if (args[0] === 'ls-remote') return symref;
      return '';
    });
    expect((await svc.status('/repo') as { status: ShipStatus }).status.defaultBranch).toBe('trunk');
    await svc.status('/repo');
    expect(calls.filter((c) => c.args[0] === 'ls-remote')).toHaveLength(1);
    symref = new Error('unreachable');
    const other = await svc.status('/other');
    expect((other as { status: ShipStatus }).status.defaultBranch).toBeNull();
  });
});

describe('ShipActions writes', () => {
  it('commit stages everything and commits with the message as one argv, pinned to branch + HEAD', async () => {
    const { svc, calls } = make(onBranch());
    expect(await svc.commit('/repo', '  fix: a "quoted"; rm -rf x  ', EXPECT)).toEqual({ ok: true });
    const writes = calls.filter((c) => c.args[0] === 'add' || c.args[0] === 'commit').map((c) => c.args);
    expect(writes).toEqual([['add', '-A'], ['commit', '-m', 'fix: a "quoted"; rm -rf x']]);
    expect(await svc.commit('/repo', '   ', EXPECT)).toEqual({ ok: false, error: 'a commit message is required' });
  });

  it('refuses to write when the branch or HEAD moved since the dialog opened', async () => {
    const switched = make(onBranch(() => '', HEAD, 'other'));
    const r1 = await switched.svc.commit('/repo', 'msg', EXPECT);
    expect(r1).toEqual({ ok: false, error: 'the branch changed since this was opened; check again' });
    expect(switched.calls.some((c) => c.args[0] === 'add')).toBe(false);
    const moved = make(onBranch(() => '', 'b'.repeat(40)));
    expect((await moved.svc.push('/repo', EXPECT)).ok).toBe(false);
    expect(moved.calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('push names the remote and an explicit refspec from the upstream config, and never prompts', async () => {
    const { svc, calls } = make(onBranch((args) => {
      if (args[0] === 'config' && args[2] === 'branch.feat/x.remote') return 'origin\n';
      if (args[0] === 'config' && args[2] === 'branch.feat/x.merge') return 'refs/heads/feat/x\n';
      return '';
    }));
    expect(await svc.push('/repo', EXPECT)).toEqual({ ok: true });
    const push = calls.find((c) => c.args[0] === 'push')!;
    expect(push.args).toEqual(['push', 'origin', `${HEAD}:refs/heads/feat/x`]);
    expect(push.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('push refuses a branch with no remote upstream', async () => {
    const { svc, calls } = make(onBranch());
    expect(await svc.push('/repo', EXPECT)).toEqual({ ok: false, error: 'the branch has no upstream branch on a remote' });
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('createPr runs gh pr create --fill for the pinned branch with the title, answers the URL and drops the cached PR', async () => {
    process.env.GH_REPO = 'other/repo';
    try {
      const { svc, calls, forgetPr } = make(onBranch(() => 'Creating pull request…\nhttps://github.com/o/r/pull/9\n'));
      const res = await svc.createPr('/repo', ' feat: add x ', EXPECT);
      expect(res).toEqual({ ok: true, url: 'https://github.com/o/r/pull/9' });
      const gh = calls.find((c) => c.args[0] === 'pr')!;
      expect(gh.args).toEqual(['pr', 'create', '--fill', '--head', 'feat/x', '--title', 'feat: add x']);
      expect(gh.env).not.toHaveProperty('GH_REPO');
      expect(gh.env.GH_PROMPT_DISABLED).toBe('1');
      expect(forgetPr).toHaveBeenCalledWith('/repo', 'feat/x');
    } finally {
      delete process.env.GH_REPO;
    }
  });

  it('a failing command answers its stderr', async () => {
    const { svc } = make(onBranch((args) => {
      if (args[0] === 'config') return args[2].endsWith('.remote') ? 'origin' : 'refs/heads/feat/x';
      if (args[0] === 'push') return Object.assign(new Error('x'), { stderr: 'rejected: non-fast-forward\n' });
      return '';
    }));
    expect(await svc.push('/repo', EXPECT)).toEqual({ ok: false, error: 'rejected: non-fast-forward' });
  });
});

describe('push against a real repo with push.default=matching', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

  it('publishes only the current branch, exactly at its HEAD', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wmux-ship-'));
    dirs.push(root);
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    g(root, 'init', '-q', '--bare', '-b', 'main', origin);
    g(root, 'clone', '-q', origin, work);
    g(work, 'config', 'user.email', 'ship@example.invalid');
    g(work, 'config', 'user.name', 'ship');
    g(work, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(work, 'a.txt'), 'a');
    g(work, 'add', '-A');
    g(work, 'commit', '-qm', 'init');
    g(work, 'push', '-q', '-u', 'origin', 'main');
    g(work, 'switch', '-qc', 'feat/x');
    g(work, 'push', '-q', '-u', 'origin', 'feat/x');
    // main gets a local commit that must NOT be published.
    g(work, 'switch', '-q', 'main');
    writeFileSync(path.join(work, 'm.txt'), 'm');
    g(work, 'add', '-A');
    g(work, 'commit', '-qm', 'local main');
    g(work, 'switch', '-q', 'feat/x');
    writeFileSync(path.join(work, 'x.txt'), 'x');
    g(work, 'add', '-A');
    g(work, 'commit', '-qm', 'feat');
    g(work, 'config', 'push.default', 'matching');
    const originMainBefore = g(origin, 'rev-parse', 'main');
    const head = g(work, 'rev-parse', 'HEAD');

    const res = await new ShipActions().push(work, { branch: 'feat/x', head });
    expect(res).toEqual({ ok: true });
    expect(g(origin, 'rev-parse', 'feat/x')).toBe(head);
    expect(g(origin, 'rev-parse', 'main')).toBe(originMainBefore);
  }, 30_000);
});

describe('checkWrite (the handler guard)', () => {
  const status = (over: Partial<ShipStatus> = {}): ShipStatus => ({
    ...parseStatusV2(STATUS), conflicts: 0, inProgress: false, defaultBranch: 'main', headSubject: '', pr: null, ...over,
  });
  const deps = (st: ShipStatus, merge = false) => ({ status: async () => ({ ok: true as const, status: st }), mergeRunning: async () => merge });

  it('refuses when the branch or HEAD moved', async () => {
    const r = await checkWrite('/repo', 'commit', { branch: 'feat/x', head: 'b'.repeat(40) }, deps(status()));
    expect(r).toEqual({ ok: false, error: 'the branch changed since this was opened; check again' });
  });

  it('a merge session running on disk blocks a write', async () => {
    const r = await checkWrite('/repo', 'commit', EXPECT, deps(status(), true));
    expect(r).toEqual({ ok: false, error: 'cannot commit now: merge-active' });
  });

  it('conflicts block a commit; a clean, pinned commit passes', async () => {
    expect(await checkWrite('/repo', 'commit', EXPECT, deps(status({ conflicts: 2 })))).toEqual({ ok: false, error: 'cannot commit now: conflicts' });
    expect((await checkWrite('/repo', 'commit', EXPECT, deps(status()))).ok).toBe(true);
  });

  it('parseExpect accepts a branch and a full commit id only', () => {
    expect(parseExpect(EXPECT)).toEqual(EXPECT);
    expect(parseExpect({ branch: 'feat/x', head: 'abc' })).toBeNull();
    expect(parseExpect({ branch: 'a b', head: HEAD })).toBeNull();
    expect(parseExpect(null)).toBeNull();
  });
});

describe('shipInputOf', () => {
  it('maps a status to the state machine input', () => {
    const st = { ...parseStatusV2(STATUS), inProgress: false, defaultBranch: 'feat/x', headSubject: '', pr: null };
    expect(shipInputOf(st)).toMatchObject({
      dirty: 3, conflicts: 1, ahead: 2, behind: 1, hasUpstream: true, onDefaultBranch: true, defaultBranchKnown: true, mergeActive: false,
    });
    expect(shipInputOf({ ...st, defaultBranch: null }, true)).toMatchObject({ defaultBranchKnown: false, mergeActive: true });
  });
});

describe('worktree list helpers', () => {
  it('parseBranchDates reads branch → last commit time (ms)', () => {
    const m = parseBranchDates('main\t1700000000\nfeat/x\t1700000100\nbroken\n');
    expect([...m]).toEqual([['main', 1_700_000_000_000], ['feat/x', 1_700_000_100_000]]);
  });

  it('parseGitdirFile resolves a linked worktree admin dir', () => {
    expect(parseGitdirFile('gitdir: /repo/.git/worktrees/feat\n', '/wt/feat')).toBe(path.resolve('/repo/.git/worktrees/feat'));
    expect(parseGitdirFile('gitdir: ../repo/.git/worktrees/feat\n', '/wt/feat')).toBe(path.resolve('/wt/feat', '../repo/.git/worktrees/feat'));
    expect(parseGitdirFile('nope', '/wt')).toBeNull();
  });
});
