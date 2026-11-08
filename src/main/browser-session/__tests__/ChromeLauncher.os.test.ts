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
// AutoUpdater is imported for INSTALL_PREPARE_CAP_MS only; it reads the app
// version at module load.
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, autoUpdater: {}, ipcMain: {}, net: {}, shell: {} }));
vi.mock('node:fs', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    existsSync: () => true, // a binary always "exists"
    // Label seeding must not touch the real filesystem in these tests
    // (covered by ChromeLauncher.label.os.test.ts against a real tmpdir).
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
    // Without this switch the debugging port alone makes every page report
    // `navigator.webdriver === true` (measured on Chrome 152).
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    // Without it Chrome drops cookies that carry no expiry on every restart.
    expect(args).toContain('--restore-last-session');
  });

  describe('a Chrome that is slow to start', () => {
    /** Queue one spawn that "writes" its DevToolsActivePort only after `ms` (a cold first start), or never. */
    function spawnSlow(child: FakeChild, ms: number | null): void {
      spawnMock.mockImplementationOnce((_bin: string, args: string[]) => {
        const dir = (args.find((a) => a.startsWith('--user-data-dir=')) ?? '').slice('--user-data-dir='.length).replace(/\\/g, '/');
        if (ms !== null) setTimeout(() => { state.portFiles[dir] = `17555\n/devtools/browser/uuid-17555\n`; }, ms);
        return child;
      });
    }
    const settle = async <T,>(p: Promise<T>) => {
      let out: { ok: true; v: T } | { ok: false; e: unknown } | null = null;
      p.then((v) => { out = { ok: true, v }; }, (e) => { out = { ok: false, e }; });
      return () => out as { ok: true; v: T } | { ok: false; e: unknown } | null;
    };

    beforeEach(() => {
      fetchMock.mockResolvedValue(fetchOk({}));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('a first start that reads its install from a cold disk for 14 s is waited on, not killed at 10 s', async () => {
      const child = makeChild();
      spawnSlow(child, 14_000);
      const result = await settle(new ChromeLauncher('/tmp/cold-profile').ensureRunning());
      await vi.advanceTimersByTimeAsync(12_000);
      expect(result()).toBeNull();
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(result()).toEqual({ ok: true, v: 17555 });
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('one still running but never listening is given up on, and killed, past the ceiling', async () => {
      const child = makeChild();
      spawnSlow(child, null);
      const result = await settle(new ChromeLauncher('/tmp/stuck-profile').ensureRunning());
      await vi.advanceTimersByTimeAsync(29_000);
      expect(result()).toBeNull();
      await vi.advanceTimersByTimeAsync(2_000);
      const out = result();
      expect(out?.ok).toBe(false);
      expect(String((out as { e: unknown }).e)).toContain('CDP endpoint did not become ready in time');
      expect(child.kill).toHaveBeenCalled();
    });

    it('one that exits while starting fails at once, ceiling or not', async () => {
      const child = makeChild();
      spawnSlow(child, null);
      const result = await settle(new ChromeLauncher('/tmp/exiting-profile').ensureRunning());
      await vi.advanceTimersByTimeAsync(12_000);
      child.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(500);
      const out = result();
      expect(out?.ok).toBe(false);
      expect(String((out as { e: unknown }).e)).toContain('exited during startup');
    });
  });

  it('a real launch closes the tabs session restore brought back, keeping one blank tab', async () => {
    const restored = [
      { id: 'old-1', url: 'https://a.test/', title: 'A', type: 'page' },
      { id: 'old-2', url: 'https://b.test/', title: 'B', type: 'page' },
    ];
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return fetchOk({ id: 'blank', url: 'about:blank' });
      return fetchOk(String(url).endsWith('/json/list') ? restored : {});
    });
    spawnWritesPortFile(makeChild());

    const launcher = new ChromeLauncher('/tmp/restored-prof');
    await launcher.ensureRunning();

    const calls = fetchMock.mock.calls.map(([u, init]) => `${(init as { method?: string } | undefined)?.method ?? 'GET'} ${new URL(String(u)).pathname}`);
    // The blank tab comes first: closing a window's last tab would quit Chrome.
    const blank = calls.indexOf('PUT /json/new');
    expect(blank).toBeGreaterThan(-1);
    expect(calls.slice(blank)).toEqual(expect.arrayContaining(['GET /json/close/old-1', 'GET /json/close/old-2']));
    expect(calls.indexOf('GET /json/close/old-1')).toBeGreaterThan(blank);
  });

  it('keeps one restored tab when no blank tab could be opened, so Chrome is not quit', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return { ok: false, status: 500, text: async () => '' };
      return fetchOk(
        String(url).endsWith('/json/list')
          ? [
              { id: 'old-1', url: 'https://a.test/', title: 'A', type: 'page' },
              { id: 'old-2', url: 'https://b.test/', title: 'B', type: 'page' },
            ]
          : {},
      );
    });
    spawnWritesPortFile(makeChild());

    await new ChromeLauncher('/tmp/restored-prof-3').ensureRunning();

    const closed = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/json/close/'));
    expect(closed).toHaveLength(1);
  });

  it('a caller arriving while restored tabs are being closed waits for the launch', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return fetchOk({ id: 'mine', url: 'https://x.test/' });
      return fetchOk(
        String(url).endsWith('/json/list')
          ? [
              { id: 'ntp', url: 'chrome://newtab/', title: 'New Tab', type: 'page' },
              { id: 'old-1', url: 'https://a.test/', title: 'A', type: 'page' },
            ]
          : {},
      );
    });
    spawnWritesPortFile(makeChild());
    const launcher = new ChromeLauncher('/tmp/restored-prof-4');
    const launching = launcher.ensureRunning();
    // The port is published before the cleanup is done.
    await vi.waitFor(() => expect(launcher.currentPort()).not.toBeNull(), { timeout: 5_000 });
    await launcher.openTab('https://x.test/', 'ws-1');
    await launching;

    const calls = fetchMock.mock.calls.map(([u, init]) => `${(init as { method?: string } | undefined)?.method ?? 'GET'} ${new URL(String(u)).pathname}`);
    expect(calls.indexOf('GET /json/close/old-1')).toBeGreaterThan(-1);
    expect(calls.indexOf('GET /json/close/old-1')).toBeLessThan(calls.indexOf('PUT /json/new'));
  });

  it('a startup tab is left alone, and no blank tab is added beside it', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      fetchOk(
        String(url).endsWith('/json/list')
          ? [
              { id: 'ntp', url: 'chrome://newtab/', title: 'New Tab', type: 'page' },
              { id: 'old-1', url: 'https://a.test/', title: 'A', type: 'page' },
            ]
          : {},
      ),
    );
    spawnWritesPortFile(makeChild());

    await new ChromeLauncher('/tmp/restored-prof-2').ensureRunning();

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.endsWith('/json/close/old-1'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/json/close/ntp'))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === 'PUT')).toBe(false);
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
    await launcher.dispose();

    expect(child.kill).toHaveBeenCalled();
    await expect(launcher.ensureRunning()).rejects.toThrow('disposed');
  });

  it('a graceful dispose closes the pages first, so the session Chrome saves restores none', async () => {
    let listed = [{ id: 'ntp', url: 'chrome://newtab/', title: 'New Tab', type: 'page' }];
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      if (init?.method === 'PUT') {
        listed = [...listed, { id: 'agent-1', url: 'https://a.test/', title: 'A', type: 'page' }];
        return fetchOk({ id: 'agent-1', url: 'https://a.test/' });
      }
      if (u.includes('/json/close/')) {
        const id = u.split('/json/close/')[1];
        listed = listed.filter((t) => t.id !== id);
        return fetchOk('Target is closing');
      }
      return fetchOk(u.endsWith('/json/list') ? listed : {});
    });
    const child = makeChild();
    spawnWritesPortFile(child);
    const launcher = new ChromeLauncher('/tmp/profile-pre-close');
    await launcher.openTab('https://a.test/', 'ws-1');

    await launcher.dispose();

    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/json/close/agent-1'))).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/json/close/ntp'))).toBe(false);
    expect(listed.map((t) => t.id)).toEqual(['ntp']);
    expect(child.kill).toHaveBeenCalled(); // no browser socket in this fake: the signal fallback
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
import { ChromeLauncherRegistry, QUIT_GRACE_MS } from '../ChromeLauncher';
import { INSTALL_PREPARE_CAP_MS } from '../../updater/AutoUpdater';

describe('ChromeLauncherRegistry', () => {
  function makeStore(bindings: Record<string, string>) {
    return {
      profileFor: (ws?: string) => (ws && bindings[ws]) || 'default',
      hasPaneBindings: () => false,
      isPaneBound: () => false,
    };
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
    expect(registry.ownerOfSurface(openedA.surfaceId)).toEqual({ workspaceId: 'ws-a', profile: 'pa', client: a });
    expect(registry.ownerOfSurface(openedB.surfaceId)).toEqual({ workspaceId: 'ws-b', profile: 'pb', client: b });
    expect(registry.ownerOfSurface('chrome-nope')).toBeNull();
    // A raw CDP target id is not a surface handle.
    expect(registry.ownerOfSurface('tgt-a')).toBeNull();

    await registry.disposeAll();
    expect(childA.kill).toHaveBeenCalled();
    expect(childB.kill).toHaveBeenCalled();
  });

  it('a profile asked for while the registry quits gets a launcher that never starts Chrome', async () => {
    const surfaceStore = { listForProfile: vi.fn(() => []), save: vi.fn(), saveNow: vi.fn(async () => undefined), dropProfile: vi.fn(async () => undefined), flushSync: vi.fn() };
    const registry = new ChromeLauncherRegistry({
      defaultDir: '/tmp/default-prof',
      profilesDir: '/tmp/profiles',
      store: makeStore({}),
      surfaceStore: surfaceStore as never,
    });
    const stopping = registry.disposeAll();
    const late = registry.forProfile('late');
    await expect(late.endpoint()).rejects.toThrow('disposed');
    await stopping;
    expect(spawnMock).not.toHaveBeenCalled();
    expect(registry.peekLauncher('late')).toBeUndefined();
    // Its teardown leaves the profile's persisted records (an adopted Chrome
    // may still hold their tabs) untouched.
    expect(surfaceStore.save).not.toHaveBeenCalled();
    expect(surfaceStore.saveNow).not.toHaveBeenCalled();
  });

  it('a demand already awaiting its liveness check when the app quits starts no new Chrome', async () => {
    const child = makeChild();
    const port = spawnWritesPortFile(child);
    let failLiveness: (() => void) | null = null;
    let launched = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (launched && !failLiveness && String(url).includes(`:${port}/json/version`)) {
        return new Promise((_resolve, reject) => {
          failLiveness = () => reject(new Error('gone'));
        });
      }
      return fetchOk({});
    });
    const registry = new ChromeLauncherRegistry({
      defaultDir: '/tmp/default-prof',
      profilesDir: '/tmp/profiles',
      store: makeStore({}),
    });
    const launcher = registry.forProfile('racing');
    await launcher.endpoint();
    launched = true;
    const pending = launcher.endpoint(); // parked on the liveness fetch
    await vi.waitFor(() => expect(failLiveness).not.toBeNull(), { timeout: 5_000 });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const stopping = registry.disposeAll();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    vi.useRealTimers();
    spawnWritesPortFile(makeChild());
    (failLiveness as unknown as () => void)();
    await expect(pending).rejects.toThrow('disposed');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('an install quit closes the registry until it is called off', async () => {
    const registry = new ChromeLauncherRegistry({
      defaultDir: '/tmp/default-prof',
      profilesDir: '/tmp/profiles',
      store: makeStore({}),
    });
    void registry.disposeAll({ immediate: true });
    // A lookup during the install quit (e.g. a consent request) stays outside it.
    const late = registry.forProfile('during-install');
    await expect(late.endpoint()).rejects.toThrow('disposed');
    expect(registry.peekLauncher('during-install')).toBeUndefined();
    // The install was called off: profiles launch again.
    registry.reopen();
    const again = registry.forProfile('during-install');
    expect(again).not.toBe(late);
    expect(registry.peekLauncher('during-install')).toBe(again);
  });

  it('disposeAll settles within the quit grace, under the install cap, with a wedged endpoint and children that never exit', async () => {
    const childA = makeChild();
    const childB = makeChild();
    spawnWritesPortFile(childA);
    spawnWritesPortFile(childB);
    fetchMock.mockResolvedValue(fetchOk({}));
    const registry = new ChromeLauncherRegistry({
      defaultDir: '/tmp/default-prof',
      profilesDir: '/tmp/profiles',
      store: makeStore({}),
    });
    await registry.forProfile('wedged-a').endpoint();
    await registry.forProfile('wedged-b').endpoint();
    // Every CDP call hangs from here on, and neither child ever exits.
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const margin = 250;
    // prepareInstallQuit's flushes run only if disposeAll settles before the
    // updater stops waiting on it.
    expect(QUIT_GRACE_MS + margin).toBeLessThan(INSTALL_PREPARE_CAP_MS);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let settled = false;
      const stopping = registry.disposeAll().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS + margin);
      expect(settled).toBe(true);
      await stopping;
    } finally {
      vi.useRealTimers();
    }
    expect(childA.kill).toHaveBeenCalled();
    expect(childB.kill).toHaveBeenCalled();
  });

  it('revealNewest activates the newest tab of a running pane profile and never launches one', async () => {
    const child = makeChild();
    spawnWritesPortFile(child);
    let n = 0;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return fetchOk({ id: `tgt-${++n}`, url: 'https://x.test/' });
      if (String(url).endsWith('/json/list')) {
        // A fresh Chrome lists only its startup tab until wmux opens one.
        if (n === 0) return fetchOk([{ id: 'startup', url: 'chrome://newtab/', title: 'New Tab', type: 'page' }]);
        return fetchOk([
          { id: 'tgt-1', url: 'https://x.test/', title: 'one', type: 'page' },
          { id: 'tgt-2', url: 'https://x.test/', title: 'two', type: 'page' },
          { id: 'tgt-3', url: 'https://x.test/', title: 'unattributed', type: 'page' },
        ]);
      }
      return fetchOk({});
    });
    const registry = new ChromeLauncherRegistry({
      defaultDir: '/tmp/default-prof',
      profilesDir: '/tmp/profiles',
      store: makeStore({}),
    });

    // Nothing was ever launched for this profile: refuse, spawn nothing.
    expect(await registry.revealNewest('pane-prof', 'ws-a')).toMatchObject({ ok: false });
    expect(registry.peekLauncher('pane-prof')).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();

    const launcher = registry.forProfile('pane-prof');
    await launcher.openTab('https://x.test/', 'ws-a');
    await launcher.openTab('https://x.test/', 'ws-a');
    // Newest of all, but no workspace on record: never what a pane's reveal raises.
    await launcher.openTab('https://x.test/');
    expect(await registry.revealNewest('pane-prof', 'ws-a')).toEqual({ ok: true });
    const activated = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/json/activate/'));
    expect(activated).toEqual([expect.stringMatching(/\/json\/activate\/tgt-2$/)]);
    // Another workspace's view of the same profile has nothing to show.
    expect(await registry.revealNewest('pane-prof', 'ws-b')).toMatchObject({ ok: false });
    expect(await registry.revealNewest('live', 'ws-a')).toMatchObject({ ok: false, error: expect.stringContaining('Live Chrome') });
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
  it('a quit landing after ensureRunning resolved still keeps endpoint() from answering', async () => {
    state.portFiles['/tmp/adopt-quit-2'] = '18936\n/devtools/browser/x\n';
    fetchMock.mockResolvedValue(fetchOk({ webSocketDebuggerUrl: 'ws://127.0.0.1:18936/devtools/browser/x' }));
    const launcher = new ChromeLauncher('/tmp/adopt-quit-2');
    const inner = launcher.ensureRunning.bind(launcher);
    // Dispose right after ensureRunning's own gate passed, before endpoint() resumes.
    vi.spyOn(launcher, 'ensureRunning').mockImplementation(async () => {
      const port = await inner();
      void launcher.dispose();
      return port;
    });
    await expect(launcher.endpoint()).rejects.toThrow('disposed');
  });

  it('an adoption still probing when the app quits hands out no endpoint', async () => {
    state.portFiles['/tmp/adopt-quit'] = '18935\n/devtools/browser/x\n';
    let answer: (() => void) | null = null;
    fetchMock.mockImplementation(async (url: string) => {
      if (!answer && String(url).includes(':18935/json/version')) {
        await new Promise<void>((r) => {
          answer = r;
        });
      }
      return fetchOk({});
    });
    const launcher = new ChromeLauncher('/tmp/adopt-quit');
    const pending = launcher.endpoint();
    await vi.waitFor(() => expect(answer).not.toBeNull(), { timeout: 5_000 });
    await launcher.dispose();
    (answer as unknown as () => void)();
    await expect(pending).rejects.toThrow('disposed');
    expect(launcher.currentPort()).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('adopts an existing instance when DevToolsActivePort answers, without spawning', async () => {
    state.portFiles['/tmp/adopt-prof'] = '18933\n/devtools/browser/x\n';
    fetchMock.mockResolvedValue(fetchOk({ Browser: 'Chrome/151', webSocketDebuggerUrl: 'ws://127.0.0.1:18933/devtools/browser/x' }));

    const launcher = new ChromeLauncher('/tmp/adopt-prof');
    const port = await launcher.ensureRunning();

    expect(port).toBe(18933);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not adopt another browser that holds the recorded port by now, and starts its own', async () => {
    // The file says /devtools/browser/mine; the browser answering on that port is another one.
    state.portFiles['/tmp/adopt-foreign'] = '18937\n/devtools/browser/mine\n';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = spawnWritesPortFile(makeChild());
    fetchMock.mockImplementation(async (url: string) => fetchOk(String(url).includes(':18937/')
      ? { Browser: 'Chrome/151', webSocketDebuggerUrl: 'ws://127.0.0.1:18937/devtools/browser/someone-else' }
      : { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/uuid-${port}` }));
    const launcher = new ChromeLauncher('/tmp/adopt-foreign');
    expect(await launcher.ensureRunning()).toBe(port);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not as the browser that recorded it (another browser)'));
    // Nothing was asked of the other browser beyond who it is, once.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(':18937/')).map(([u]) => new URL(String(u)).pathname))
      .toEqual(['/json/version']);
    warn.mockRestore();
    await launcher.dispose({ immediate: true });
  });

  it('does not adopt a server on the recorded port that names no browser endpoint, and starts its own', async () => {
    state.portFiles['/tmp/adopt-notchrome'] = '18938\n/devtools/browser/mine\n';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = spawnWritesPortFile(makeChild());
    fetchMock.mockImplementation(async (url: string) => fetchOk(String(url).includes(':18938/')
      ? { hello: 'a dev server' }
      : { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/uuid-${port}` }));
    const launcher = new ChromeLauncher('/tmp/adopt-notchrome');
    expect(await launcher.ensureRunning()).toBe(port);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not as the browser that recorded it (no browser endpoint)'));
    warn.mockRestore();
    await launcher.dispose({ immediate: true });
  });

  it('says why it adopts nothing: a server that answers with an error, or a port file that records no browser', async () => {
    for (const [dir, file, answer, why] of [
      ['/tmp/adopt-404', '18939\n/devtools/browser/mine\n', { ok: false, status: 404, text: async () => 'Not Found' }, 'it answers HTTP 404'],
      ['/tmp/adopt-noline', '18940\n', fetchOk({ webSocketDebuggerUrl: 'ws://127.0.0.1:18940/devtools/browser/mine' }), 'the port file records no browser'],
    ] as const) {
      spawnMock.mockReset();
      state.portFiles[dir] = file;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const port = spawnWritesPortFile(makeChild());
      const recordedPort = file.split('\n')[0];
      fetchMock.mockImplementation(async (url: string) => (String(url).includes(`:${recordedPort}/`)
        ? answer
        : fetchOk({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/uuid-${port}` })));
      const launcher = new ChromeLauncher(dir);
      expect(await launcher.ensureRunning()).toBe(port);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`(${why})`));
      warn.mockRestore();
      await launcher.dispose({ immediate: true });
    }
  });

  it('never closes the tabs of an adopted instance: they are the ones its records re-bind to', async () => {
    state.portFiles['/tmp/adopt-prof-2'] = '18934\n/devtools/browser/x\n';
    fetchMock.mockImplementation(async (url: string) =>
      fetchOk(String(url).endsWith('/json/list')
        ? [{ id: 'live-1', url: 'https://a.test/', title: 'A', type: 'page' }]
        : { webSocketDebuggerUrl: 'ws://127.0.0.1:18934/devtools/browser/x' }),
    );

    await new ChromeLauncher('/tmp/adopt-prof-2').ensureRunning();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/json/close/'))).toBe(false);
  });
});
