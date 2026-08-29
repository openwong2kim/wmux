import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// Stable surface ids on the dedicated 'chrome' backend.
//
// The contract under test: the surfaceId an agent holds is minted by wmux and
// outlives Chrome swapping the CDP target behind the tab, a dead Chrome, and
// an app restart. Same fakes as ChromeLauncher.test.ts (child_process, global
// fetch, DevToolsActivePort); the surface store is a small in-memory double so
// these stay unit tests with no disk in the loop.

const { spawnMock, state } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  state: { portFiles: {} as Record<string, string> },
}));
vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    existsSync: () => true,
    mkdirSync: () => undefined,
    readFileSync: vi.fn((p: unknown) => {
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
import type { ChromeSurfaceRecord, ChromeSurfaceStore } from '../ChromeSurfaceStore';

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = vi.fn();
  return child;
}

/** In-memory stand-in with the ChromeSurfaceStore surface the launcher uses. */
function makeFakeStore(seed: Record<string, ChromeSurfaceRecord[]> = {}) {
  const profiles = new Map<string, ChromeSurfaceRecord[]>(Object.entries(seed));
  return {
    profiles,
    listForProfile: vi.fn((p: string) => (profiles.get(p) ?? []).map((r) => ({ ...r }))),
    save: vi.fn((p: string, records: readonly ChromeSurfaceRecord[]) => {
      profiles.set(p, records.map((r) => ({ ...r })));
    }),
    saveNow: vi.fn(async (p: string, records: readonly ChromeSurfaceRecord[]) => {
      profiles.set(p, records.map((r) => ({ ...r })));
    }),
    dropProfile: vi.fn(async (p: string) => {
      profiles.delete(p);
    }),
    flushSync: vi.fn(),
  };
}

type FakeStore = ReturnType<typeof makeFakeStore>;
const asStore = (s: FakeStore) => s as unknown as ChromeSurfaceStore;

let fetchMock: ReturnType<typeof vi.fn>;
let nextPort = 21001;

function fetchOk(body: unknown) {
  return { ok: true, text: async () => JSON.stringify(body) };
}

function spawnWritesPortFile(child: FakeChild): number {
  const port = nextPort++;
  spawnMock.mockImplementationOnce((_bin: string, args: string[]) => {
    const dir = (args.find((a) => a.startsWith('--user-data-dir=')) ?? '')
      .slice('--user-data-dir='.length)
      .replace(/\\/g, '/');
    state.portFiles[dir] = `${port}\n/devtools/browser/uuid-${port}\n`;
    return child;
  });
  return port;
}

/** fetch double whose /json/list contents the test controls. */
function serveTabs(getList: () => Array<{ id: string; url: string; title: string; type: string }>) {
  let created = 0;
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') return fetchOk({ id: `tgt-${++created}`, url: 'x' });
    if (String(url).includes('/json/list')) return fetchOk(getList());
    return fetchOk({});
  });
}

function pageTarget(id: string): { id: string; url: string; title: string; type: string } {
  return { id, url: `https://${id}.test/`, title: id.toUpperCase(), type: 'page' };
}

beforeEach(() => {
  spawnMock.mockReset();
  state.portFiles = {};
  nextPort = 21001;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ChromeLauncher stable surface ids', () => {
  it('openTab mints a chrome- prefixed surfaceId distinct from the CDP targetId', async () => {
    spawnWritesPortFile(makeChild());
    serveTabs(() => [pageTarget('tgt-1')]);

    const launcher = new ChromeLauncher('/tmp/sfc-1');
    const a = await launcher.openTab('https://a.test/', 'ws-1');
    const b = await launcher.openTab('https://b.test/', 'ws-1');

    expect(a.surfaceId).toMatch(/^chrome-[0-9a-f-]{36}$/);
    expect(a.surfaceId).not.toBe(a.targetId);
    expect(a.targetId).toBe('tgt-1');
    expect(b.surfaceId).not.toBe(a.surfaceId);
    expect(launcher.hasSurface(a.surfaceId)).toBe(true);
    expect(launcher.hasSurface(a.targetId)).toBe(false);
  });

  it('a one-round /json/list miss withholds the tab but keeps the record, and it re-binds on return', async () => {
    spawnWritesPortFile(makeChild());
    let visible = true;
    serveTabs(() => (visible ? [pageTarget('tgt-1')] : []));

    const launcher = new ChromeLauncher('/tmp/sfc-2');
    const opened = await launcher.openTab('https://a.test/', 'ws-1');
    expect((await launcher.listTargets('ws-1')).map((t) => t.surfaceId)).toEqual([opened.surfaceId]);

    visible = false;
    expect(await launcher.listTargets('ws-1')).toEqual([]);
    expect(launcher.hasSurface(opened.surfaceId)).toBe(true); // NOT forgotten

    visible = true;
    expect(await launcher.listTargets('ws-1')).toEqual([
      {
        surfaceId: opened.surfaceId,
        targetId: 'tgt-1',
        workspaceId: 'ws-1',
        url: 'https://tgt-1.test/',
        title: 'TGT-1',
      },
    ]);
  });

  it('a record missing past the orphan TTL is finally forgotten', async () => {
    vi.useFakeTimers();
    spawnWritesPortFile(makeChild());
    let visible = true;
    serveTabs(() => (visible ? [pageTarget('tgt-1')] : []));

    const launcher = new ChromeLauncher('/tmp/sfc-3');
    const opened = await launcher.openTab('https://a.test/', 'ws-1');
    await launcher.listTargets('ws-1');

    visible = false;
    await launcher.listTargets('ws-1'); // stamps missingSince
    expect(launcher.hasSurface(opened.surfaceId)).toBe(true);

    vi.setSystemTime(Date.now() + 6 * 60 * 1000); // past ORPHAN_TTL_MS (5min)
    await launcher.listTargets('ws-1');
    expect(launcher.hasSurface(opened.surfaceId)).toBe(false);
  });

  it('a dead Chrome unbinds records instead of erasing them', async () => {
    const child = makeChild();
    const port = spawnWritesPortFile(child);
    let alive = true;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (!alive && String(url).includes(`:${port}/`)) throw new Error('dead');
      if (init?.method === 'PUT') return fetchOk({ id: 'tgt-1', url: 'x' });
      if (String(url).includes('/json/list')) return fetchOk([pageTarget('tgt-1')]);
      return fetchOk({});
    });
    const store = makeFakeStore();

    const launcher = new ChromeLauncher('/tmp/sfc-4', { profileName: 'p1', surfaceStore: asStore(store) });
    const opened = await launcher.openTab('https://a.test/', 'ws-1');

    alive = false;
    child.emit('exit');

    // The handle is still owned; it just has no live target behind it.
    expect(launcher.hasSurface(opened.surfaceId)).toBe(true);
    expect(launcher.recordFor(opened.surfaceId)?.targetId).toBeNull();
    expect(store.profiles.get('p1')).toEqual([
      expect.objectContaining({ surfaceId: opened.surfaceId, targetId: null }),
    ]);
  });

  it('adopting a previous session Chrome re-binds the persisted records whose targets are still live', async () => {
    // Chrome outlived wmux: DevToolsActivePort answers, so adoptExisting wins
    // and never spawns. Revival rule (2): targetId still in /json/list.
    state.portFiles['/tmp/sfc-5'] = '18933\n/devtools/browser/x\n';
    serveTabs(() => [pageTarget('tgt-live')]);
    const now = Date.now();
    const store = makeFakeStore({
      p1: [
        { surfaceId: 'chrome-live', targetId: 'tgt-live', workspaceId: 'ws-1', url: 'https://a.test/', createdAt: now, lastSeenAt: now },
        { surfaceId: 'chrome-gone', targetId: 'tgt-gone', workspaceId: 'ws-1', url: 'https://b.test/', createdAt: now, lastSeenAt: now },
      ],
    });

    const launcher = new ChromeLauncher('/tmp/sfc-5', { profileName: 'p1', surfaceStore: asStore(store) });
    await launcher.ensureRunning();
    expect(spawnMock).not.toHaveBeenCalled();

    // Re-bound and immediately usable again after a restart.
    expect(await launcher.listTargets('ws-1')).toEqual([
      {
        surfaceId: 'chrome-live',
        targetId: 'tgt-live',
        workspaceId: 'ws-1',
        url: 'https://tgt-live.test/',
        title: 'TGT-LIVE',
      },
    ]);
    // The unmatched record is kept but unbound — never revived by URL match.
    expect(launcher.recordFor('chrome-gone')?.targetId).toBeNull();
  });

  it('a fresh spawn (adoption failed) drops the profile records — those tabs are gone', async () => {
    let spawned = false;
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      const dir = (args.find((a) => a.startsWith('--user-data-dir=')) ?? '')
        .slice('--user-data-dir='.length)
        .replace(/\\/g, '/');
      state.portFiles[dir] = '21999\n/devtools/browser/fresh\n';
      spawned = true;
      return makeChild();
    });
    fetchMock.mockImplementation(async () => {
      if (!spawned) throw new Error('nothing running yet'); // adoption fails
      return fetchOk({});
    });
    const now = Date.now();
    const store = makeFakeStore({
      p1: [{ surfaceId: 'chrome-old', targetId: 'tgt-old', url: 'https://a.test/', createdAt: now, lastSeenAt: now }],
    });

    const launcher = new ChromeLauncher('/tmp/sfc-6', { profileName: 'p1', surfaceStore: asStore(store) });
    await launcher.ensureRunning();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(launcher.hasSurface('chrome-old')).toBe(false);
    expect(store.dropProfile).toHaveBeenCalledWith('p1');
  });

  it('closeSurface closes by surfaceId (never the raw targetId) and drops the record', async () => {
    spawnWritesPortFile(makeChild());
    const closed: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return fetchOk({ id: 'tgt-1', url: 'x' });
      if (String(url).includes('/json/close/')) {
        closed.push(String(url).split('/json/close/')[1] ?? '');
        return fetchOk('Target is closing');
      }
      if (String(url).includes('/json/list')) return fetchOk([pageTarget('tgt-1')]);
      return fetchOk({});
    });
    const store = makeFakeStore();

    const launcher = new ChromeLauncher('/tmp/sfc-7', { profileName: 'p1', surfaceStore: asStore(store) });
    const opened = await launcher.openTab('https://a.test/', 'ws-1');

    expect(await launcher.closeSurface(opened.targetId)).toBe(false); // not a handle
    expect(await launcher.closeSurface(opened.surfaceId)).toBe(true);
    expect(closed).toEqual(['tgt-1']); // CDP still addressed by targetId
    expect(launcher.hasSurface(opened.surfaceId)).toBe(false);
    expect(store.profiles.get('p1')).toEqual([]);
  });

  it('without a store the launcher still works, purely in memory', async () => {
    spawnWritesPortFile(makeChild());
    serveTabs(() => [pageTarget('tgt-1')]);
    const launcher = new ChromeLauncher('/tmp/sfc-8');
    const opened = await launcher.openTab('https://a.test/', 'ws-1');
    expect((await launcher.listTargets('ws-1')).map((t) => t.surfaceId)).toEqual([opened.surfaceId]);
  });
});
