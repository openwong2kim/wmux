import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// ChromeLauncher (Phase 2 'chrome' backend): spawn lifecycle + tab registry.
// child_process and global fetch are faked; PortAllocator runs real bind
// probes, which is fine (ephemeral, released between tests).

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, existsSync: () => true }; // a binary always "exists"
});

import { ChromeLauncher } from '../ChromeLauncher';

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = vi.fn();
  return child;
}

let fetchMock: ReturnType<typeof vi.fn>;

function fetchOk(body: unknown) {
  return { ok: true, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  spawnMock.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChromeLauncher', () => {
  it('launches once for concurrent demands and resolves the CDP port after readiness', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    fetchMock.mockResolvedValue(fetchOk({ Browser: 'Chrome/151' }));

    const launcher = new ChromeLauncher('/tmp/profile');
    const [a, b] = await Promise.all([launcher.ensureRunning(), launcher.ensureRunning()]);

    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(18900);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args.some((f) => f.startsWith('--remote-debugging-port='))).toBe(true);
    expect(args).toContain('--remote-allow-origins=*');
  });

  it('relaunches on the next demand after the child dies', async () => {
    const first = makeChild();
    const second = makeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    fetchMock.mockResolvedValue(fetchOk({}));

    const launcher = new ChromeLauncher('/tmp/profile');
    await launcher.ensureRunning();
    first.emit('exit');

    await launcher.ensureRunning();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('openTab records the owner and listTargets filters by workspace and prunes dead tabs', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).includes('/json/version')) return fetchOk({});
      if (init?.method === 'PUT') {
        return fetchOk({ id: String(url).includes('a.test') ? 'tgt-a' : 'tgt-b', url: 'x' });
      }
      if (String(url).includes('/json/list')) {
        // tgt-b already closed in Chrome — must be pruned.
        return fetchOk([{ id: 'tgt-a', url: 'https://a.test/', title: 'A', type: 'page' }]);
      }
      return fetchOk({});
    });

    const launcher = new ChromeLauncher('/tmp/profile');
    await launcher.openTab('https://a.test/', 'ws-1');
    await launcher.openTab('https://b.test/', 'ws-2');

    const ws1 = await launcher.listTargets('ws-1');
    expect(ws1).toEqual([{ targetId: 'tgt-a', workspaceId: 'ws-1', url: 'https://a.test/', title: 'A' }]);
    const ws2 = await launcher.listTargets('ws-2');
    expect(ws2).toEqual([]); // tgt-b pruned as dead
  });

  it('dispose kills the child and later demands fail', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    fetchMock.mockResolvedValue(fetchOk({}));

    const launcher = new ChromeLauncher('/tmp/profile');
    await launcher.ensureRunning();
    launcher.dispose();

    expect(child.kill).toHaveBeenCalled();
    await expect(launcher.ensureRunning()).rejects.toThrow('disposed');
  });
});

// Registry: one launcher per profile, workspace-binding resolution (Phase 2.5).
import { ChromeLauncherRegistry } from '../ChromeLauncher';

describe('ChromeLauncherRegistry', () => {
  function makeStore(bindings: Record<string, string>) {
    return { profileFor: (ws?: string) => (ws && bindings[ws]) || 'default' };
  }

  it('bound workspaces get distinct launchers with distinct dirs; unbound share default', () => {
    const registry = new ChromeLauncherRegistry({
      defaultDir: '/tmp/default-prof',
      profilesDir: '/tmp/profiles',
      store: makeStore({ 'ws-a': 'youtube-a', 'ws-b': 'youtube-b' }),
    });
    const a = registry.forWorkspace('ws-a');
    const b = registry.forWorkspace('ws-b');
    const d1 = registry.forWorkspace('ws-unbound');
    const d2 = registry.forWorkspace(undefined);

    expect(a).not.toBe(b);
    expect(d1).toBe(d2);
    expect(registry.forWorkspace('ws-a')).toBe(a); // cached
    const dirOf = (l: unknown) => (l as { userDataDir: string }).userDataDir;
    expect(dirOf(a)).toBe('/tmp/profiles/youtube-a');
    expect(dirOf(b)).toBe('/tmp/profiles/youtube-b');
    expect(dirOf(d1)).toBe('/tmp/default-prof');
  });

  it('ownerOfTarget finds the launcher that opened a tab; disposeAll kills all children', async () => {
    const childA = makeChild();
    const childB = makeChild();
    spawnMock.mockReturnValueOnce(childA).mockReturnValueOnce(childB);
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return fetchOk({ id: String(url).includes('a.test') ? 'tgt-a' : 'tgt-b', url: 'x' });
      return fetchOk({});
    });

    const registry = new ChromeLauncherRegistry({
      defaultDir: '/tmp/default-prof',
      profilesDir: '/tmp/profiles',
      store: makeStore({ 'ws-a': 'pa', 'ws-b': 'pb' }),
    });
    const a = registry.forWorkspace('ws-a');
    const b = registry.forWorkspace('ws-b');
    await a.openTab('https://a.test/', 'ws-a');
    await b.openTab('https://b.test/', 'ws-b');

    expect(registry.ownerOfTarget('tgt-a')).toBe(a);
    expect(registry.ownerOfTarget('tgt-b')).toBe(b);
    expect(registry.ownerOfTarget('tgt-x')).toBeUndefined();

    registry.disposeAll();
    expect(childA.kill).toHaveBeenCalled();
    expect(childB.kill).toHaveBeenCalled();
  });
});
