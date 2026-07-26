import { describe, expect, it, vi } from 'vitest';
import { prepareGitCommand, resolveGitToplevel, type GitResult } from '../git';
import type { PaneCommandTarget } from '../paneCommand';

describe('resolveGitToplevel', () => {
  it.each([
    [{ stdout: ' C:\\repo\\worktree\n ', stderr: '', code: 0 }, 'C:\\repo\\worktree'],
    [{ stdout: '   ', stderr: '', code: 0 }, null],
    [{ stdout: '/repo', stderr: 'not a repository', code: 1 }, null],
  ] satisfies Array<[GitResult, string | null]>)(
    'normalizes the git result %#',
    async (result, expected) => {
      const run = vi.fn(async () => result);
      await expect(resolveGitToplevel('C:\\repo\\subdir', run)).resolves.toBe(expected);
      expect(run).toHaveBeenCalledWith(
        ['rev-parse', '--show-toplevel'],
        'C:\\repo\\subdir',
      );
    },
  );

  it('preserves the live WSL target used to resolve the checkout', async () => {
    const target: PaneCommandTarget = {
      sessionId: 'pty-1',
      location: {
        domain: 'wsl',
        cwd: '/home/me/repo/subdir',
        shell: 'wsl.exe',
        distro: 'Ubuntu',
      },
      activeContext: { sessionId: 'pty-1', active: true, distro: 'Ubuntu' },
    };
    const run = vi.fn(async () => ({ stdout: '/home/me/repo\n', stderr: '', code: 0 }));

    await expect(resolveGitToplevel(target, run)).resolves.toBe('/home/me/repo');
    expect(run).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], target);
  });

  it('prepares string inputs as host commands', () => {
    expect(prepareGitCommand(
      ['rev-parse', '--show-toplevel'],
      'C:\\repo\\subdir',
    )).toMatchObject({
      ok: true,
      file: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd: 'C:\\repo\\subdir',
    });
  });
});
