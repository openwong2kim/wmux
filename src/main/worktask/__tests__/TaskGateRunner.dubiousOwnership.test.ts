// #2231 — the gate's read of the base ref, on a worktree whose gitdir another
// user owns: the card says why and names the command, not "cannot be read".
import { describe, expect, it, vi } from 'vitest';

vi.mock('../workerGit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workerGit')>();
  return {
    ...real,
    runWorkerGitRead: vi.fn(async () => ({
      stdout: '',
      stderr: "fatal: detected dubious ownership in repository at 'C:/Users/me/.wmux/worktrees/r/t-1'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/Users/me/.wmux/worktrees/r/t-1\n",
      code: 128,
    })),
  };
});

import path from 'node:path';
import { TaskGateRunner } from '../TaskGateRunner';
import { getWmuxHomeDir } from '../../../shared/constants';

describe('the gate on a worktree git will not open', () => {
  it('is unavailable with the ownership reason and the exact command', async () => {
    const runner = new TaskGateRunner({
      ledger: { update: vi.fn() } as never,
      readPackageScripts: () => ({ lint: 'eslint .', test: 'vitest run' }),
      depsState: () => 'ok' as const,
      now: () => 1,
    });
    const r = await runner.resolveSteps('/tmp/wt', '/repo', 'origin/main');
    expect(r).toHaveProperty('unavailable');
    const why = (r as { unavailable: string }).unavailable;
    // The ownership refusal leads: it is the whole reason.
    expect(why).toMatch(/^git refuses to use \/tmp\/wt because another user owns it/);
    expect(why).toContain('`git config --global --add safe.directory C:/Users/me/.wmux/worktrees/r/t-1`');
    // Not a wmux task folder: no hint for all of them.
    expect(why).not.toContain('/*');
  });

  it('a wmux task folder also gets the one entry that covers every task folder', async () => {
    const runner = new TaskGateRunner({
      ledger: { update: vi.fn() } as never,
      readPackageScripts: () => ({ lint: 'eslint .', test: 'vitest run' }),
      depsState: () => 'ok' as const,
      now: () => 1,
    });
    const root = path.join(getWmuxHomeDir(), 'worktrees');
    const r = await runner.resolveSteps(path.join(root, 'abc123', 'task-1'), '/repo', 'origin/main');
    const why = (r as { unavailable: string }).unavailable;
    expect(why).toContain(`\`git config --global --add safe.directory "${root.replace(/\\/g, '/')}/*"\``);
  });
});
