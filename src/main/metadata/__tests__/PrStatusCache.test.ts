import { describe, it, expect, vi } from 'vitest';
import { PrStatusCache, mapGhPrView } from '../PrStatusCache';

describe('mapGhPrView', () => {
  it('marks a conflicting PR, and only that one', () => {
    const base = { number: 7, state: 'OPEN', isDraft: false, url: 'u', statusCheckRollup: [] };
    expect(mapGhPrView({ ...base, mergeable: 'CONFLICTING' })?.conflicting).toBe(true);
    expect(mapGhPrView({ ...base, mergeable: 'MERGEABLE' })).not.toHaveProperty('conflicting');
    expect(mapGhPrView({ ...base, mergeable: 'UNKNOWN' })).not.toHaveProperty('conflicting');
  });

  it('carries the head commit only when it looks like one', () => {
    const base = { number: 7, state: 'OPEN', isDraft: false, url: 'u', statusCheckRollup: [] };
    expect(mapGhPrView({ ...base, headRefOid: '8f560cbee476d5849458403f7d9685ac8d197e74' })?.headSha).toBe('8f560cbee476d5849458403f7d9685ac8d197e74');
    expect(mapGhPrView({ ...base, headRefOid: 'not a sha; rm' })).not.toHaveProperty('headSha');
  });

    it('maps an open PR with passing checks', () => {
    expect(mapGhPrView({
      number: 42,
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/o/r/pull/42',
      statusCheckRollup: [
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'NEUTRAL' },
      ],
    })).toEqual({ number: 42, state: 'open', checks: 'passing', url: 'https://github.com/o/r/pull/42' });
  });

  it('draft beats open; merged/closed beat draft', () => {
    expect(mapGhPrView({ number: 1, state: 'OPEN', isDraft: true, url: 'u' })?.state).toBe('draft');
    expect(mapGhPrView({ number: 1, state: 'MERGED', isDraft: true, url: 'u' })?.state).toBe('merged');
    expect(mapGhPrView({ number: 1, state: 'CLOSED', isDraft: false, url: 'u' })?.state).toBe('closed');
  });

  it('any failure wins over pending', () => {
    expect(mapGhPrView({
      number: 2, state: 'OPEN', url: 'u',
      statusCheckRollup: [
        { status: 'IN_PROGRESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    })?.checks).toBe('failing');
  });

  it('in-progress checks map to pending', () => {
    expect(mapGhPrView({
      number: 3, state: 'OPEN', url: 'u',
      statusCheckRollup: [{ status: 'QUEUED' }],
    })?.checks).toBe('pending');
  });

  it('StatusContext-variant entries (state, no conclusion) are honored', () => {
    expect(mapGhPrView({
      number: 4, state: 'OPEN', url: 'u',
      statusCheckRollup: [{ state: 'FAILURE' }],
    })?.checks).toBe('failing');
  });

  it('empty rollup means checks null', () => {
    expect(mapGhPrView({ number: 5, state: 'OPEN', url: 'u', statusCheckRollup: [] })?.checks).toBeNull();
  });

  it('rejects payloads missing number/url', () => {
    expect(mapGhPrView({ state: 'OPEN', url: 'u' })).toBeNull();
    expect(mapGhPrView({ number: 6, state: 'OPEN' })).toBeNull();
  });
});

describe('PrStatusCache', () => {
  const PR_JSON = JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, url: 'https://x/pull/7', statusCheckRollup: [] });

  it('caches within the TTL and refetches after it', async () => {
    let now = 0;
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => now, exec);

    const first = await cache.get('D:\\repo', 'main');
    expect(first?.number).toBe(7);
    expect(exec).toHaveBeenCalledTimes(1);

    now = 4 * 60 * 1000;
    await cache.get('D:\\repo', 'main');
    expect(exec).toHaveBeenCalledTimes(1); // still cached

    now = 6 * 60 * 1000;
    await cache.get('D:\\repo', 'main');
    expect(exec).toHaveBeenCalledTimes(2); // TTL expired
  });

  it('keys the cache by cwd+branch', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => 0, exec);
    await cache.get('D:\\a', 'main');
    await cache.get('D:\\b', 'main');
    await cache.get('D:\\a', 'feat');
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('coalesces concurrent callers onto one gh subprocess', async () => {
    let resolve!: (v: { stdout: string }) => void;
    const exec = vi.fn().mockReturnValue(new Promise<{ stdout: string }>((r) => { resolve = r; }));
    const cache = new PrStatusCache(() => 0, exec);
    const p1 = cache.get('D:\\repo', 'main');
    const p2 = cache.get('D:\\repo', 'main');
    resolve({ stdout: PR_JSON });
    const [a, b] = await Promise.all([p1, p2]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(a?.number).toBe(7);
    expect(b?.number).toBe(7);
  });

  it('"no PR" failures resolve null quietly and are cached', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('no pull requests found'), { code: 1 }));
    const cache = new PrStatusCache(() => 0, exec);
    expect(await cache.get('D:\\repo', 'main')).toBeNull();
    expect(await cache.get('D:\\repo', 'main')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('gh missing (ENOENT) stays silent for the TTL, then probes again', async () => {
    let now = 0;
    const exec = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
      .mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => now, exec);
    expect(await cache.get('D:\\a', 'main')).toBeNull();
    now = 5 * 60 * 1000 - 1;
    expect(await cache.get('D:\\b', 'other')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1); // not probed within the TTL
    now = 5 * 60 * 1000;
    expect((await cache.get('D:\\b', 'other'))?.number).toBe(7); // gh installed meanwhile
    expect(exec).toHaveBeenCalledTimes(2);
  });

  // getExecEnv() reads the platform at import and caches its env, so each case
  // re-imports PrStatusCache with a mocked platform.
  async function spawnedPath(platform: { isMac: boolean; isLinux: boolean }, path: string | undefined): Promise<string> {
    const savedPath = process.env.PATH;
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    vi.resetModules();
    vi.doMock('../../../shared/platform', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../shared/platform')>()),
      ...platform,
    }));
    try {
      const { PrStatusCache: Fresh } = await import('../PrStatusCache');
      const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
      await new Fresh(() => 0, exec).get('/repo', 'main');
      return exec.mock.calls[0][2].env.PATH as string;
    } finally {
      vi.doUnmock('../../../shared/platform');
      vi.resetModules();
      process.env.PATH = savedPath;
    }
  }

  it('macOS: a launchd PATH reaches gh with the Homebrew dirs added', async () => {
    const path = await spawnedPath({ isMac: true, isLinux: false }, '/usr/bin:/bin:/usr/sbin:/sbin');
    expect(path).toContain('/opt/homebrew/bin');
    expect(path).toContain('/usr/local/bin');
  });

  it('Linux: keeps the original PATH first, without Homebrew dirs', async () => {
    const path = await spawnedPath({ isMac: false, isLinux: true }, '/custom/bin:/usr/bin:/bin');
    expect(path.startsWith('/custom/bin:/usr/bin:/bin')).toBe(true);
    expect(path).not.toContain('/opt/homebrew/bin');
  });

  it('Linux: an unset PATH still lets gh resolve from /usr/bin and /bin', async () => {
    const path = await spawnedPath({ isMac: false, isLinux: true }, undefined);
    expect(path.startsWith('/usr/bin:/bin')).toBe(true);
  });

  it('invalidate() forces a refetch before the TTL', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => 0, exec);
    await cache.get('D:\\repo', 'main');
    cache.invalidate('D:\\repo', 'main');
    await cache.get('D:\\repo', 'main');
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
