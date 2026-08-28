import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// ChromeLauncher (Phase 2 'chrome' backend): spawn lifecycle + tab registry.
// child_process, global fetch, and the profile dir's DevToolsActivePort are
// faked. Launches use --remote-debugging-port=0, so the resolved port comes
// from the (faked) DevToolsActivePort file each spawn "writes".

const { spawnMock, state } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  // DevToolsActivePort content per user-data-dir (path-prefix keyed).
  state: { portFiles: {} as Record<string, string> },
}));
vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    existsSync: () => true, // a binary always "exists"
    // Label seeding must not touch the real filesystem in these tests
    // (covered by ChromeLauncher.label.test.ts against a real tmpdir).
    mkdirSync: () => undefined,
    readFileSync: vi.fn((p: unknown) => {
      // join() emits platform separators; keys are stored with forward
      // slashes — normalize before prefix-matching (Windows CI).
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('DevToolsActivePort')) {
        for (const [dir, content] of Object.entries(state.portFiles)) {
          if (s.startsWith(dir)) return content;
        }
      }
      throw new Error('ENOENT (unit test)');
    }),
    writeFileSync: () => undefined,
  };
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
let nextPort = 17001;

function fetchOk(body: unknown) {
  return { ok: true, text: async () => JSON.stringify(body) };
}

/** Queue one spawn that "writes" a fresh DevToolsActivePort for its dir. */
function spawnWritesPortFile(child: FakeChild): number {
  const port = nextPort++;
  spawnMock.mockImplementationOnce((_bin: string, args: string[]) => {
    const dir = (args.find((a) => a.startsWith('--user-data-dir=')) ?? '')
      .slice('--user-data-dir='.length)
      .replace(/\\/g, '/'); // registry dirs go through join() → platform separators
    state.portFiles[dir] = `${port}\n/devtools/browser/uuid-${port}\n`;
    return child;
  });
  return port;
}

beforeEach(() => {
  spawnMock.mockReset();
  state.portFiles = {};
  nextPort = 17001;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChromeLauncher', () => {
  it('launches once with port 0 and resolves the port from DevToolsActivePort', async () => {
    const child = makeChild();
    const port = spawnWritesPortFile(child);
    fetchMock.mockResolvedValue(fetchOk({ Browser: 'Chrome/151' }));

    const launcher = new ChromeLauncher('/tmp/profile');
    const [a, b] = await Promise.all([launcher.ensureRunning(), launcher.ensureRunning()]);

    expect(a).toBe(b);
    expect(a).toBe(port);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--user-data-dir=/tmp/profile');
    // Port 0 is what makes Chrome write DevToolsActivePort at all — a fixed
    // port produces no file (measured on Chrome 151, #1064 dogfood).
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).toContain('--remote-allow-origins=*');
  });

  it('a stale DevToolsActivePort (dead previous instance) is neither adopted nor mistaken for the fresh write', async () => {
    state.portFiles['/tmp/profile'] = '15000\n/devtools/browser/stale-uuid\n';
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes(':15000/')) throw new Error('stale endpoint dead');
      return fetchOk({});
    });
    const child = makeChild();
    const port = spawnWritesPortFile(child);

    const launcher = new ChromeLauncher('/tmp/profile');
    await expect(launcher.ensureRunning()).resolves.toBe(port);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('relaunches on the next demand after the child dies', async () => {
    const first = makeChild();
    const second = makeChild();
    const firstPort = spawnWritesPortFile(first);
    spawnWritesPortFile(second);
    let firstDead = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (firstDead && String(url).includes(`:${firstPort}/`)) throw new Error('dead');
      return fetchOk({});
    });

    const launcher = new ChromeLauncher('/tmp/profile');
    await launcher.ensureRunning();
    first.emit('exit');
    firstDead = true;

    await launcher.ensureRunning();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('openTab records the owner and listTargets filters by workspace and prunes dead tabs', async () => {
    spawnWritesPortFile(makeChild());
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
    spawnWritesPortFile(child);
    fetchMock.mockResolvedValue(fetchOk({}));

    const launcher = new ChromeLauncher('/tmp/profile');
    await launcher.ensureRunning();
    launcher.dispose();

    expect(child.kill).toHaveBeenCalled();
    await expect(launcher.ensureRunning()).rejects.toThrow('disposed');
  });

  it('an env-pinned port launches with that fixed port (no DevToolsActivePort involved)', async () => {
    process.env.WMUX_CHROME_TEST_PIN = '19555';
    try {
      let spawned = false;
      // Pre-spawn adoption probe on the pin must fail (no zombie), the
      // post-spawn readiness poll must succeed.
      fetchMock.mockImplementation(async () => {
        if (!spawned) throw new Error('nothing on the pin yet');
        return fetchOk({});
      });
      spawnMock.mockImplementation(() => {
        spawned = true;
        return makeChild();
      });

      const launcher = new ChromeLauncher('/tmp/profile', { portEnvVar: 'WMUX_CHROME_TEST_PIN' });
      await expect(launcher.ensureRunning()).resolves.toBe(19555);
      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).toContain('--remote-debugging-port=19555');
    } finally {
      delete process.env.WMUX_CHROME_TEST_PIN;
    }
  });

  it('an env-pinned zombie is adopted by probing the pin directly (pinned launches write no file)', async () => {
    process.env.WMUX_CHROME_TEST_PIN = '19556';
    try {
      fetchMock.mockResolvedValue(fetchOk({ Browser: 'Chrome/151' }));
      const launcher = new ChromeLauncher('/tmp/profile', { portEnvVar: 'WMUX_CHROME_TEST_PIN' });
      await expect(launcher.ensureRunning()).resolves.toBe(19556);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.WMUX_CHROME_TEST_PIN;
    }
  });
});

// Registry: one launcher per profile, workspace-binding resolution (Phase 2.5).
import { join } from 'node:path';
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
    // join() so the expectation follows the platform separator (Windows CI).
    expect(dirOf(a)).toBe(join('/tmp/profiles', 'youtube-a'));
    expect(dirOf(b)).toBe(join('/tmp/profiles', 'youtube-b'));
    expect(dirOf(d1)).toBe('/tmp/default-prof');
  });

  it('ownerOfTarget finds the launcher that opened a tab; disposeAll kills all children', async () => {
    const childA = makeChild();
    const childB = makeChild();
    spawnWritesPortFile(childA);
    spawnWritesPortFile(childB);
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

// Crash-path adoption: a previous session's Chrome still holds the profile
// dir — reuse its recorded endpoint instead of dying on the SingletonLock.
describe('ChromeLauncher zombie adoption', () => {
  it('adopts an existing instance when DevToolsActivePort answers, without spawning', async () => {
    state.portFiles['/tmp/adopt-prof'] = '18933\n/devtools/browser/x\n';
    fetchMock.mockResolvedValue(fetchOk({ Browser: 'Chrome/151' }));

    const launcher = new ChromeLauncher('/tmp/adopt-prof');
    const port = await launcher.ensureRunning();

    expect(port).toBe(18933);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
