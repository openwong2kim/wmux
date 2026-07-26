import { describe, it, expect, vi } from 'vitest';
import { PrStatusCache, mapGhPrView } from '../PrStatusCache';

const host = (cwd: string, sessionId = 'pty-host') => ({
  sessionId,
  location: { domain: 'host' as const, cwd, shell: 'pwsh.exe' },
});

describe('mapGhPrView', () => {
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

    const first = await cache.get(host('D:\\repo'), 'main');
    expect(first?.number).toBe(7);
    expect(exec).toHaveBeenCalledTimes(1);

    now = 4 * 60 * 1000;
    await cache.get(host('D:\\repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(1); // still cached

    now = 6 * 60 * 1000;
    await cache.get(host('D:\\repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(2); // TTL expired
  });

  it('keys the cache by domain+distro+cwd+branch', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => 0, exec);
    await cache.get(host('D:\\repo'), 'main');
    await cache.get({
      sessionId: 'pty-u',
      location: { domain: 'wsl', cwd: '/repo', shell: 'wsl.exe', distro: 'Ubuntu' },
      activeContext: { sessionId: 'pty-u', active: true, distro: 'Ubuntu' },
    }, 'main');
    await cache.get({
      sessionId: 'pty-d',
      location: { domain: 'wsl', cwd: '/repo', shell: 'wsl.exe', distro: 'Debian' },
      activeContext: { sessionId: 'pty-d', active: true, distro: 'Debian' },
    }, 'main');
    await cache.get(host('D:\\repo'), 'feat');
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('normalizes the cwd key (separator/trailing-slash/case variance collapse onto one entry)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => 0, exec);
    await cache.get(host('D:\\repo'), 'main');
    await cache.get(host('D:/repo/'), 'main');
    await cache.get(host('d:\\REPO'), 'main');
    // A bare worktree path (the pre-location caller form) must land on the
    // same entry the pane target created — locationIdentity owns the folding.
    await cache.get('D:/Repo//', 'main');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callers onto one gh subprocess', async () => {
    let resolve!: (v: { stdout: string }) => void;
    const exec = vi.fn().mockReturnValue(new Promise<{ stdout: string }>((r) => { resolve = r; }));
    const cache = new PrStatusCache(() => 0, exec);
    const target = host('D:\\repo');
    const p1 = cache.get(target, 'main');
    const p2 = cache.get(target, 'main');
    resolve({ stdout: PR_JSON });
    const [a, b] = await Promise.all([p1, p2]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(a?.number).toBe(7);
    expect(b?.number).toBe(7);
  });

  it('"no PR" failures resolve null quietly and are cached', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('no pull requests found'), { code: 1 }));
    const cache = new PrStatusCache(() => 0, exec);
    expect(await cache.get(host('D:\\repo'), 'main')).toBeNull();
    expect(await cache.get(host('D:\\repo'), 'main')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('gh missing (ENOENT) disables the cache permanently for this process', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const cache = new PrStatusCache(() => 0, exec);
    expect(await cache.get(host('D:\\a'), 'main')).toBeNull();
    expect(await cache.get(host('D:\\b'), 'other')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1); // never probed again
  });

  it('invalidate() forces a refetch before the TTL, across cwd spellings', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => 0, exec);
    await cache.get(host('D:\\repo'), 'main');
    // Deliberately a DIFFERENT spelling of the same directory: an invalidate
    // that only works on the identical object proves nothing about the key.
    cache.invalidate('d:/repo/', 'main');
    await cache.get(host('D:\\repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(2);
    // Branch is still part of the key — a sibling branch keeps its own entry.
    cache.invalidate('d:/repo/', 'other');
    await cache.get(host('D:\\repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('keeps timeout/output caps and passes structured WSL argv', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => 0, exec);
    await cache.get({
      sessionId: 'pty-u',
      location: { domain: 'wsl', cwd: '/repo with spaces', shell: 'wsl.exe', distro: 'Ubuntu' },
      activeContext: { sessionId: 'pty-u', active: true, distro: 'Ubuntu' },
    }, 'main');
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      expect.arrayContaining(['--cd', '/repo with spaces', '--exec', process.platform === 'win32' ? 'gh.exe' : 'gh']),
      expect.objectContaining({ timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }),
    );
  });
});
