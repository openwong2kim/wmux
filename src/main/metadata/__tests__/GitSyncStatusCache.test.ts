import { describe, it, expect, vi } from 'vitest';
import { GitSyncStatusCache, parsePorcelainV2 } from '../GitSyncStatusCache';

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

describe('GitSyncStatusCache', () => {
  const CLEAN = '# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0\n';

  it('caches within the 15 s TTL and refetches after it', async () => {
    let now = 0;
    const exec = vi.fn().mockResolvedValue({ stdout: CLEAN });
    const cache = new GitSyncStatusCache(() => now, exec);

    expect(await cache.get('D:\\repo')).toEqual({ dirty: 0, ahead: 1, behind: 0, hasUpstream: true });
    expect(exec).toHaveBeenCalledTimes(1);

    now = 10_000;
    await cache.get('D:\\repo');
    expect(exec).toHaveBeenCalledTimes(1); // still cached

    now = 20_000;
    await cache.get('D:\\repo');
    expect(exec).toHaveBeenCalledTimes(2); // TTL expired
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
