import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createServer, type Server } from 'node:net';

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

  it('a tab missing from /json/list is withheld from listTargets but not forgotten', async () => {
    spawnWritesPortFile(makeChild());
    // tgt-b vanishes from /json/list for one round, then comes back — exactly
    // what Chrome does when it swaps the target behind a tab.
    let bVisible = false;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).includes('/json/version')) return fetchOk({});
      if (init?.method === 'PUT') {
        return fetchOk({ id: String(url).includes('a.test') ? 'tgt-a' : 'tgt-b', url: 'x' });
      }
      if (String(url).includes('/json/list')) {
        const list = [{ id: 'tgt-a', url: 'https://a.test/', title: 'A', type: 'page' }];
        if (bVisible) list.push({ id: 'tgt-b', url: 'https://b.test/', title: 'B', type: 'page' });
        return fetchOk(list);
      }
      return fetchOk({});
    });

    const launcher = new ChromeLauncher('/tmp/profile');
    const a = await launcher.openTab('https://a.test/', 'ws-1');
    const b = await launcher.openTab('https://b.test/', 'ws-2');
    // The surfaceId agents hold is minted by wmux, never Chrome's target id.
    expect(a.surfaceId).toMatch(/^chrome-/);
    expect(a.surfaceId).not.toBe(a.targetId);

    const ws1 = await launcher.listTargets('ws-1');
    expect(ws1).toEqual([
      { surfaceId: a.surfaceId, targetId: 'tgt-a', workspaceId: 'ws-1', url: 'https://a.test/', title: 'A' },
    ]);
    // Withheld while missing...
    expect(await launcher.listTargets('ws-2')).toEqual([]);
    // ...but the record survived: the surfaceId is still owned, and the tab
    // reappears (re-bound) once Chrome lists the target again.
    expect(launcher.hasSurface(b.surfaceId)).toBe(true);
    bVisible = true;
    expect(await launcher.listTargets('ws-2')).toEqual([
      { surfaceId: b.surfaceId, targetId: 'tgt-b', workspaceId: 'ws-2', url: 'https://b.test/', title: 'B' },
    ]);
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

  it('ownerOfSurface finds the launcher that opened a tab; disposeAll kills all children', async () => {
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
    const openedA = await a.openTab('https://a.test/', 'ws-a');
    const openedB = await b.openTab('https://b.test/', 'ws-b');

    // Ownership resolves by the stable surfaceId, and reports the owning
    // workspace so browser.close can refuse a cross-workspace close.
    expect(registry.ownerOfSurface(openedA.surfaceId)).toEqual({ workspaceId: 'ws-a', client: a });
    expect(registry.ownerOfSurface(openedB.surfaceId)).toEqual({ workspaceId: 'ws-b', client: b });
    expect(registry.ownerOfSurface('chrome-nope')).toBeNull();
    // A raw CDP target id is not a surface handle.
    expect(registry.ownerOfSurface('tgt-a')).toBeNull();

    registry.disposeAll();
    expect(childA.kill).toHaveBeenCalled();
    expect(childB.kill).toHaveBeenCalled();
  });

  it('statusForWorkspace on the live profile probes actual listening, not just a parseable file', async () => {
    const prev = process.env.WMUX_LIVE_CHROME_DIR;
    process.env.WMUX_LIVE_CHROME_DIR = '/fake/live-user-data';
    const registry = new ChromeLauncherRegistry({
      defaultDir: '/tmp/default-prof',
      profilesDir: '/tmp/profiles',
      store: makeStore({ 'ws-live': 'live' }),
    });
    // A real listener gives us a genuinely live port we can also kill on demand.
    const server: Server = createServer();
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      // No DevToolsActivePort at all → not reachable; liveAttach still flags the
      // attach case (running:false means chrome://inspect, not "call start").
      state.portFiles = {};
      expect(await registry.statusForWorkspace('ws-live')).toEqual({
        profile: 'live',
        running: false,
        cdpPort: null,
        liveAttach: true,
      });
      // Parseable file whose port is actually LISTENING → reachable.
      state.portFiles = { '/fake/live-user-data': `${port}\n/devtools/browser/abc-123\n` };
      expect(await registry.statusForWorkspace('ws-live')).toEqual({
        profile: 'live',
        running: true,
        cdpPort: null,
        liveAttach: true,
      });
      // THE REGRESSION: same parseable file, but the port is now DEAD (a
      // force-killed Chrome's stale DevToolsActivePort). Parsing still succeeds
      // yet nothing listens — must report NOT running, never a false "reachable".
      await new Promise<void>((res) => server.close(() => res()));
      expect(await registry.statusForWorkspace('ws-live')).toEqual({
        profile: 'live',
        running: false,
        cdpPort: null,
        liveAttach: true,
      });
    } finally {
      if (server.listening) await new Promise<void>((res) => server.close(() => res()));
      if (prev === undefined) delete process.env.WMUX_LIVE_CHROME_DIR;
      else process.env.WMUX_LIVE_CHROME_DIR = prev;
    }
  });

  it('statusForWorkspace on a down dedicated profile omits liveAttach and reports no port', async () => {
    const registry = new ChromeLauncherRegistry({
      defaultDir: '/tmp/default-prof',
      profilesDir: '/tmp/profiles',
      store: makeStore({}),
    });
    // Unbound → default (dedicated) profile, never launched → running:false and
    // NO liveAttach field (the field is live-only, so callers can branch on it).
    const status = await registry.statusForWorkspace('ws-x');
    expect(status).toEqual({ profile: 'default', running: false, cdpPort: null });
    expect('liveAttach' in status).toBe(false);
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
