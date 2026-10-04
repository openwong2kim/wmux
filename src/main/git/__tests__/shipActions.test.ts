import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { ShipActions, parseStatusV2 } from '../shipActions';
import { shipInputOf } from '../../ipc/handlers/gitShip.handler';
import { parseBranchDates } from '../../ipc/handlers/worktree.handler';

type Call = { cmd: string; args: string[]; env: NodeJS.ProcessEnv };

function make(answer: (cmd: string, args: string[]) => string | Error) {
  const calls: Call[] = [];
  const run = vi.fn(async (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: opts.env });
    const r = answer(cmd, args);
    if (r instanceof Error) throw r;
    return { stdout: r };
  });
  const prOf = vi.fn(async () => ({ number: 3, state: 'open' as const, checks: null, url: 'https://github.com/o/r/pull/3' }));
  const forgetPr = vi.fn();
  return { svc: new ShipActions(run as never, prOf, forgetPr), calls, prOf, forgetPr };
}

const STATUS = [
  '# branch.oid 0123456789abcdef',
  '# branch.head feat/x',
  '# branch.upstream origin/feat/x',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
  '2 R. N... 100644 100644 100644 aaa bbb R100 src/b.ts\tsrc/old.ts',
  '? notes.txt',
  '! ignored.log',
].join('\n');

describe('parseStatusV2', () => {
  it('reads branch, upstream, ahead/behind and counts changed and untracked files', () => {
    expect(parseStatusV2(STATUS)).toEqual({ branch: 'feat/x', detached: false, upstream: 'origin/feat/x', ahead: 2, behind: 1, dirty: 3 });
  });

  it('a detached HEAD with no upstream', () => {
    expect(parseStatusV2('# branch.oid abc\n# branch.head (detached)\n')).toEqual({
      branch: null, detached: true, upstream: null, ahead: 0, behind: 0, dirty: 0,
    });
  });
});

describe('ShipActions', () => {
  it('status joins git status, the default branch, the last subject and the PR', async () => {
    const { svc, prOf } = make((_c, args) => {
      if (args[0] === 'status') return STATUS;
      if (args[0] === 'symbolic-ref') return 'origin/main\n';
      if (args[0] === 'log') return 'feat: add x\n';
      return '';
    });
    const res = await svc.status('/repo');
    expect(res).toEqual({
      ok: true,
      status: {
        branch: 'feat/x', detached: false, upstream: 'origin/feat/x', ahead: 2, behind: 1, dirty: 3,
        defaultBranch: 'main', headSubject: 'feat: add x', pr: { state: 'open', url: 'https://github.com/o/r/pull/3' },
      },
    });
    expect(prOf).toHaveBeenCalledWith('/repo', 'feat/x');
  });

  it('commit stages everything, then commits with the message as one argv', async () => {
    const { svc, calls } = make(() => '');
    expect(await svc.commit('/repo', '  fix: a "quoted"; rm -rf x  ')).toEqual({ ok: true });
    expect(calls.map((c) => c.args)).toEqual([['add', '-A'], ['commit', '-m', 'fix: a "quoted"; rm -rf x']]);
    expect(await svc.commit('/repo', '   ')).toEqual({ ok: false, error: 'a commit message is required' });
  });

  it('push uses the existing upstream and never prompts', async () => {
    const { svc, calls } = make(() => '');
    await svc.push('/repo');
    expect(calls[0].args).toEqual(['push']);
    expect(calls[0].env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('createPr runs gh pr create --fill with the title, answers the URL and drops the cached PR', async () => {
    process.env.GH_REPO = 'other/repo';
    try {
      const { svc, calls, forgetPr } = make(() => 'Creating pull request…\nhttps://github.com/o/r/pull/9\n');
      const res = await svc.createPr('/repo', 'feat/x', ' feat: add x ');
      expect(res).toEqual({ ok: true, url: 'https://github.com/o/r/pull/9' });
      expect(calls[0].args).toEqual(['pr', 'create', '--fill', '--title', 'feat: add x']);
      expect(calls[0].env).not.toHaveProperty('GH_REPO');
      expect(calls[0].env.GH_PROMPT_DISABLED).toBe('1');
      expect(forgetPr).toHaveBeenCalledWith('/repo', 'feat/x');
    } finally {
      delete process.env.GH_REPO;
    }
  });

  it('a failing command answers its stderr', async () => {
    const { svc } = make(() => Object.assign(new Error('x'), { stderr: 'rejected: non-fast-forward\n' }));
    expect(await svc.push('/repo')).toEqual({ ok: false, error: 'rejected: non-fast-forward' });
  });
});

describe('shipInputOf', () => {
  it('maps a status to the state machine input', () => {
    const st = { ...parseStatusV2(STATUS), defaultBranch: 'feat/x', headSubject: '', pr: null };
    expect(shipInputOf(st)).toMatchObject({ dirty: 3, ahead: 2, behind: 1, hasUpstream: true, detached: false, onDefaultBranch: true });
  });
});

describe('parseBranchDates', () => {
  it('reads branch → last commit time (ms)', () => {
    const m = parseBranchDates('main\t1700000000\nfeat/x\t1700000100\nbroken\n');
    expect([...m]).toEqual([['main', 1_700_000_000_000], ['feat/x', 1_700_000_100_000]]);
  });
});
