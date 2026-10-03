import { describe, it, expect, vi } from 'vitest';
import { GitSyncStatusCache, parsePorcelainV2, parseShortstat } from '../GitSyncStatusCache';

describe('parsePorcelainV2', () => {
  it('parses ahead/behind and counts every dirty entry kind', () => {
    const stdout = [
      '# branch.oid 74951c8e0000000000000000000000000000dead',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 abc def src/a.ts',
      '1 M. N... 100644 100644 100644 abc def src/b.ts',
      '2 R. N... 100644 100644 100644 abc def R100 new.ts\told.ts',
      'u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts',
      '? untracked.ts',
      '! ignored.ts',
      '',
    ].join('\n');
    expect(parsePorcelainV2(stdout)).toEqual({ dirty: 5, ahead: 2, behind: 1, hasUpstream: true });
  });

  it('counts submodule pointer changes (what --ignore-submodules=dirty still reports)', () => {
    const stdout = [
      '# branch.oid deadbeef',
      '# branch.head main',
      // checked out at a different commit than recorded, unstaged and staged
      '1 .M SC.. 160000 160000 160000 abc abc libs/one',
      '1 M. S... 160000 160000 160000 abc def libs/two',
      '',
    ].join('\n');
    expect(parsePorcelainV2(stdout)).toEqual({ dirty: 2, ahead: 0, behind: 0, hasUpstream: false });
  });

  it('no upstream → hasUpstream false, ahead/behind zero', () => {
    const stdout = [
      '# branch.oid deadbeef',
      '# branch.head feature',
      '? new.ts',
      '',
    ].join('\n');
    expect(parsePorcelainV2(stdout)).toEqual({ dirty: 1, ahead: 0, behind: 0, hasUpstream: false });
  });

  it('clean synced checkout → all zeros', () => {
    const stdout = [
      '# branch.oid deadbeef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      '',
    ].join('\n');
    expect(parsePorcelainV2(stdout)).toEqual({ dirty: 0, ahead: 0, behind: 0, hasUpstream: true });
  });

  it('empty output (detached HEAD, clean) parses to zeros without upstream', () => {
    expect(parsePorcelainV2('')).toEqual({ dirty: 0, ahead: 0, behind: 0, hasUpstream: false });
  });
});

describe('parseShortstat', () => {
  it('reads insertions and deletions', () => {
    expect(parseShortstat(' 3 files changed, 84 insertions(+), 31 deletions(-)\n')).toEqual({ added: 84, removed: 31 });
  });

  it('reads a one-sided change and singular forms', () => {
    expect(parseShortstat(' 1 file changed, 1 insertion(+)\n')).toEqual({ added: 1, removed: 0 });
    expect(parseShortstat(' 1 file changed, 2 deletions(-)\n')).toEqual({ added: 0, removed: 2 });
  });
});

describe('GitSyncStatusCache', () => {
  it('adds the diff line counts for a dirty tree', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: '# branch.head main\n1 .M N... 100644 100644 100644 a b src.txt\n' })
      .mockResolvedValueOnce({ stdout: ' 1 file changed, 84 insertions(+), 31 deletions(-)\n' });
    const cache = new GitSyncStatusCache(() => 0, exec);
    const status = await cache.get('/repo');
    expect(status).toMatchObject({ dirty: 1, added: 84, removed: 31 });
    expect(exec.mock.calls[1][1]).toEqual(['--no-optional-locks', 'diff', 'HEAD', '--shortstat', '--ignore-submodules=dirty']);
    // The summary is parsed in English whatever the user's locale.
    expect(exec.mock.calls[1][2].env.LC_ALL).toBe('C');
  });

  const CLEAN = '# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0\n';

  it('caches within the 15 s TTL and refetches after it', async () => {
    let now = 0;
    const exec = vi.fn().mockResolvedValue({ stdout: CLEAN });
    const cache = new GitSyncStatusCache(() => now, exec);

    expect(await cache.get('D:\\repo')).toEqual({ dirty: 0, ahead: 1, behind: 0, hasUpstream: true, added: 0, removed: 0 });
    expect(exec).toHaveBeenCalledTimes(1);

    now = 10_000;
    await cache.get('D:\\repo');
    expect(exec).toHaveBeenCalledTimes(1); // still cached

    now = 20_000;
    await cache.get('D:\\repo');
    expect(exec).toHaveBeenCalledTimes(2); // TTL expired
  });

  it('skips submodule work trees so status stays fast in repos with many submodules', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: CLEAN });
    const cache = new GitSyncStatusCache(() => 0, exec);
    await cache.get('D:\\repo');
    expect(exec.mock.calls[0][1]).toContain('--ignore-submodules=dirty');
  });

  it('normalizes the cwd key (separators/trailing slash collapse onto one entry)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: CLEAN });
    const cache = new GitSyncStatusCache(() => 0, exec);
    await cache.get('D:\\repo');
    await cache.get('D:/repo/');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callers onto one git subprocess', async () => {
    let resolve!: (v: { stdout: string }) => void;
    const exec = vi.fn().mockReturnValue(new Promise<{ stdout: string }>((r) => { resolve = r; }));
    const cache = new GitSyncStatusCache(() => 0, exec);
    const p1 = cache.get('D:\\repo');
    const p2 = cache.get('D:\\repo');
    resolve({ stdout: CLEAN });
    const [a, b] = await Promise.all([p1, p2]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('failures resolve null quietly and are cached for the TTL window', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('not a git repository'));
    const cache = new GitSyncStatusCache(() => 0, exec);
    expect(await cache.get('D:\\notrepo')).toBeNull();
    expect(await cache.get('D:\\notrepo')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a refetch before the TTL', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: CLEAN });
    const cache = new GitSyncStatusCache(() => 0, exec);
    await cache.get('D:\\repo');
    cache.invalidate('D:/repo/');
    await cache.get('D:\\repo');
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
