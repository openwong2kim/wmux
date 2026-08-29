import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// Deterministic targetId tracking on the dedicated 'chrome' backend.
//
// Chrome replaces the page target behind a tab on its own (the first-run sync
// flow does exactly this). The tab target's id survives that swap, so the
// launcher attaches to every tab over the browser CDP socket and re-binds the
// surface record the moment the successor page announces itself. The fake here
// models the browser end of that socket: a tab -> page topology the test
// controls, plus the auto-attach announcement Chrome makes.

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

const WS_URL = 'ws://127.0.0.1:22001/devtools/browser/watcher-uuid';

interface Frame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

type Listener = (ev: { data?: string }) => void;

/** tab targetId -> the page target currently inside it. */
const tabs = new Map<string, string>();
/** sessionId -> tab targetId, as the fake browser hands them out. */
const sessions = new Map<string, string>();

class FakeBrowserWs {
  static OPEN = 1;
  static instances: FakeBrowserWs[] = [];
  static failConnect = false;
  readyState = 0;
  sent: Frame[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    FakeBrowserWs.instances.push(this);
    queueMicrotask(() => {
      if (FakeBrowserWs.failConnect) {
        this.emit('error', {});
        return;
      }
      this.readyState = FakeBrowserWs.OPEN;
      this.emit('open', {});
    });
  }

  addEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  emit(type: string, ev: { data?: string }): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    const result = this.handle(frame);
    // The reply lands after any event the command triggered, exactly as
    // Chrome orders auto-attach announcements against setAutoAttach's reply.
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: frame.id, result }) }));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  /** Push an id-less CDP event, optionally scoped to a session. */
  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.emit('message', {
      data: JSON.stringify({ method, params, ...(sessionId !== undefined && { sessionId }) }),
    });
  }

  /** Announce the page now inside a tab, the way auto-attach does. */
  announcePage(tabTargetId: string, pageTargetId: string): void {
    this.event(
      'Target.attachedToTarget',
      {
        sessionId: `page-sess-${pageTargetId}`,
        targetInfo: {
          targetId: pageTargetId,
          type: 'page',
          url: `https://${pageTargetId}.test/`,
          title: pageTargetId.toUpperCase(),
        },
      },
      `sess-${tabTargetId}`,
    );
  }

  private handle(frame: Frame): unknown {
    switch (frame.method) {
      case 'Target.getTargets':
        return {
          targetInfos: [...tabs.keys()].map((targetId) => ({ targetId, type: 'tab', url: '', title: '' })),
        };
      case 'Target.attachToTarget': {
        const tab = String(frame.params?.targetId ?? '');
        const sessionId = `sess-${tab}`;
        sessions.set(sessionId, tab);
        return { sessionId };
      }
      case 'Target.setAutoAttach': {
        const tab = frame.sessionId ? sessions.get(frame.sessionId) : undefined;
        const page = tab ? tabs.get(tab) : undefined;
        if (tab && page) this.announcePage(tab, page);
        return {};
      }
      default:
        return {};
    }
  }
}

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = vi.fn();
  return child;
}

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
/** page targetIds /json/list should report, test-controlled. */
let listedPages: string[] = [];
/** What the next PUT /json/new answers with. */
let nextCreatedPage = 'page-1';

function fetchOk(body: unknown) {
  return { ok: true, text: async () => JSON.stringify(body) };
}

function serveChrome(): void {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const s = String(url);
    if (s.includes('/json/version')) return fetchOk({ Browser: 'Chrome/151', webSocketDebuggerUrl: WS_URL });
    if (init?.method === 'PUT') return fetchOk({ id: nextCreatedPage, url: 'https://opened.test/' });
    if (s.includes('/json/list')) {
      return fetchOk(
        listedPages.map((id) => ({ id, url: `https://${id}.test/`, title: id.toUpperCase(), type: 'page' })),
      );
    }
    return fetchOk({});
  });
}

function spawnWritesPortFile(child: FakeChild, port: number): void {
  spawnMock.mockImplementationOnce((_bin: string, args: string[]) => {
    const dir = (args.find((a) => a.startsWith('--user-data-dir=')) ?? '')
      .slice('--user-data-dir='.length)
      .replace(/\\/g, '/');
    state.portFiles[dir] = `${port}\n/devtools/browser/uuid-${port}\n`;
    return child;
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  spawnMock.mockReset();
  state.portFiles = {};
  tabs.clear();
  sessions.clear();
  listedPages = [];
  nextCreatedPage = 'page-1';
  FakeBrowserWs.instances = [];
  FakeBrowserWs.failConnect = false;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeBrowserWs);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WMUX_CHROME_TARGET_WATCHER;
});

describe('ChromeLauncher tab-target watcher', () => {
  it('anchors an opened tab and re-binds it when Chrome swaps the page behind it', async () => {
    spawnWritesPortFile(makeChild(), 22001);
    serveChrome();
    tabs.set('tab-1', 'page-1');
    listedPages = ['page-1'];

    const store = makeFakeStore();
    const launcher = new ChromeLauncher('/tmp/watch-1', { profileName: 'p1', surfaceStore: asStore(store) });
    const opened = await launcher.openTab('https://a.test/', 'ws-1');

    // The tab target - not the page target - is what the record anchors to.
    expect(launcher.recordFor(opened.surfaceId)?.tabTargetId).toBe('tab-1');
    expect(opened.targetId).toBe('page-1');

    // Chrome swaps the page inside the SAME tab (first-run sync flow).
    const ws = FakeBrowserWs.instances[0];
    tabs.set('tab-1', 'page-2');
    ws.event('Target.detachedFromTarget', { sessionId: 'page-sess-page-1', targetId: 'page-1' }, 'sess-tab-1');
    ws.announcePage('tab-1', 'page-2');

    // Re-bound on the event itself, before any /json/list round.
    expect(launcher.recordFor(opened.surfaceId)?.targetId).toBe('page-2');
    expect(launcher.recordFor(opened.surfaceId)?.missingSince).toBeUndefined();

    listedPages = ['page-2'];
    expect(await launcher.listTargets('ws-1')).toEqual([
      {
        surfaceId: opened.surfaceId,
        targetId: 'page-2',
        workspaceId: 'ws-1',
        url: 'https://page-2.test/',
        title: 'PAGE-2',
      },
    ]);
  });

  it('a destroyed tab target retires the record immediately (confirmed death)', async () => {
    spawnWritesPortFile(makeChild(), 22001);
    serveChrome();
    tabs.set('tab-1', 'page-1');
    listedPages = ['page-1'];

    const store = makeFakeStore();
    const launcher = new ChromeLauncher('/tmp/watch-2', { profileName: 'p1', surfaceStore: asStore(store) });
    const opened = await launcher.openTab('https://a.test/', 'ws-1');
    expect(launcher.hasSurface(opened.surfaceId)).toBe(true);

    const ws = FakeBrowserWs.instances[0];
    // A destroyed PAGE proves nothing - the tab may be swapping.
    ws.event('Target.targetDestroyed', { targetId: 'page-1' });
    expect(launcher.hasSurface(opened.surfaceId)).toBe(true);

    // A destroyed anchor TAB is the end of the surface, no orphan grace.
    ws.event('Target.targetDestroyed', { targetId: 'tab-1' });
    expect(launcher.hasSurface(opened.surfaceId)).toBe(false);
    await tick();
    expect(store.profiles.get('p1')).toEqual([]);
  });

  it('a watcher socket that will not open costs nothing - openTab and listTargets still work', async () => {
    spawnWritesPortFile(makeChild(), 22001);
    serveChrome();
    FakeBrowserWs.failConnect = true;
    tabs.set('tab-1', 'page-1');
    listedPages = ['page-1'];

    const launcher = new ChromeLauncher('/tmp/watch-3', { profileName: 'p1' });
    const opened = await launcher.openTab('https://a.test/', 'ws-1');

    expect(opened.surfaceId).toMatch(/^chrome-/);
    expect(launcher.recordFor(opened.surfaceId)?.tabTargetId).toBeUndefined();
    expect((await launcher.listTargets('ws-1')).map((t) => t.targetId)).toEqual(['page-1']);
    // The failure is latched: a second open does not re-dial.
    const before = FakeBrowserWs.instances.length;
    nextCreatedPage = 'page-2';
    listedPages = ['page-1', 'page-2'];
    await launcher.openTab('https://b.test/', 'ws-1');
    expect(FakeBrowserWs.instances).toHaveLength(before);
  });

  it('WMUX_CHROME_TARGET_WATCHER=0 never opens the socket at all', async () => {
    process.env.WMUX_CHROME_TARGET_WATCHER = '0';
    spawnWritesPortFile(makeChild(), 22001);
    serveChrome();
    tabs.set('tab-1', 'page-1');
    listedPages = ['page-1'];

    const launcher = new ChromeLauncher('/tmp/watch-4', { profileName: 'p1' });
    const opened = await launcher.openTab('https://a.test/', 'ws-1');

    expect(FakeBrowserWs.instances).toHaveLength(0);
    expect(launcher.recordFor(opened.surfaceId)?.tabTargetId).toBeUndefined();
    expect((await launcher.listTargets('ws-1')).map((t) => t.targetId)).toEqual(['page-1']);
  });

  it('Chrome dying mid-startup does not latch the watcher off for the next Chrome', async () => {
    // The startup's own /json/version rejects BECAUSE the browser died, not
    // because this browser refuses to be watched. Latching on that verdict
    // used to leave every later Chrome unwatched until it, too, died.
    const child = makeChild();
    spawnWritesPortFile(child, 22001);
    tabs.set('tab-1', 'page-1');
    listedPages = ['page-1'];

    let versionCalls = 0;
    let failWatcherVersion: (() => void) | null = null;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const s = String(url);
      if (s.includes('/json/version')) {
        versionCalls++;
        // #1 is the readiness poll; #2 is the watcher's, held open until the
        // test has killed Chrome underneath it.
        if (versionCalls === 2) {
          return new Promise((_resolve, reject) => {
            failWatcherVersion = () => reject(new Error('chrome died'));
          });
        }
        return fetchOk({ Browser: 'Chrome/151', webSocketDebuggerUrl: WS_URL });
      }
      if (init?.method === 'PUT') return fetchOk({ id: nextCreatedPage, url: 'https://opened.test/' });
      if (s.includes('/json/list')) {
        return fetchOk(
          listedPages.map((id) => ({ id, url: `https://${id}.test/`, title: id.toUpperCase(), type: 'page' })),
        );
      }
      return fetchOk({});
    });

    const launcher = new ChromeLauncher('/tmp/watch-6', { profileName: 'p1' });
    const opening = launcher.openTab('https://a.test/', 'ws-1');
    await tick();
    expect(failWatcherVersion).not.toBeNull();

    child.emit('exit'); // onChildGone lands while the startup is still in flight
    (failWatcherVersion as unknown as () => void)();
    await opening;
    expect(FakeBrowserWs.instances).toHaveLength(0);

    // The next demand adopts the still-recorded endpoint and re-arms.
    nextCreatedPage = 'page-2';
    tabs.set('tab-2', 'page-2');
    listedPages = ['page-1', 'page-2'];
    const second = await launcher.openTab('https://b.test/', 'ws-1');

    expect(FakeBrowserWs.instances).toHaveLength(1);
    expect(launcher.recordFor(second.surfaceId)?.tabTargetId).toBe('tab-2');
  });

  it('adoption revives an anchored record whose own targetId died with the swap', async () => {
    // Chrome outlived wmux AND swapped the page inside the tracked tab, so
    // revival rule (2) (targetId still listed) cannot help - only the tab
    // anchor can. No spawn: DevToolsActivePort answers.
    state.portFiles['/tmp/watch-5'] = '22001\n/devtools/browser/x\n';
    serveChrome();
    tabs.set('tab-1', 'page-new');
    listedPages = ['page-new'];
    const now = Date.now();
    const store = makeFakeStore({
      p1: [
        {
          surfaceId: 'chrome-anchored',
          targetId: 'page-old',
          tabTargetId: 'tab-1',
          workspaceId: 'ws-1',
          url: 'https://a.test/',
          createdAt: now,
          lastSeenAt: now,
        },
        {
          surfaceId: 'chrome-unanchored',
          targetId: 'page-gone',
          workspaceId: 'ws-1',
          url: 'https://b.test/',
          createdAt: now,
          lastSeenAt: now,
        },
      ],
    });

    const launcher = new ChromeLauncher('/tmp/watch-5', { profileName: 'p1', surfaceStore: asStore(store) });
    await launcher.ensureRunning();
    expect(spawnMock).not.toHaveBeenCalled();

    expect(launcher.recordFor('chrome-anchored')?.targetId).toBe('page-new');
    expect(await launcher.listTargets('ws-1')).toEqual([
      {
        surfaceId: 'chrome-anchored',
        targetId: 'page-new',
        workspaceId: 'ws-1',
        url: 'https://page-new.test/',
        title: 'PAGE-NEW',
      },
    ]);
    // No anchor and a dead targetId: still never revived by URL match.
    expect(launcher.recordFor('chrome-unanchored')?.targetId).toBeNull();
  });
});
