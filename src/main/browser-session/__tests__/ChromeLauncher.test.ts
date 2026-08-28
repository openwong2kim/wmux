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
