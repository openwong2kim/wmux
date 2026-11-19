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

import {
  ChromeLauncher, ChromePageSessionError, OPENED_OPEN_PER_OPENER, OPENED_OPEN_PER_WORKSPACE, OPENED_PER_MINUTE,
  OPENED_PER_OPENER_PER_MINUTE, OPENED_PER_WORKSPACE_PER_MINUTE, type ChromeOpenedSurface,
} from '../ChromeLauncher';
import { surfaceOpeners } from '../SurfaceOpeners';
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
/** Attaches per target so far: Chrome gives every attach its own session id. */
const attaches = new Map<string, number>();

class FakeBrowserWs {
  static OPEN = 1;
  static instances: FakeBrowserWs[] = [];
  static failConnect = false;
  /** Runs inside setDiscoverTargets, before its reply: Chrome's replay of the targets that exist. */
  static onDiscover: ((ws: FakeBrowserWs) => void) | null = null;
  /** When set, setAutoAttach's page announcements wait here until the test runs them (Chrome may name a tab's page after it answers). */
  static heldPages: Array<() => void> | null = null;
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
        const n = (attaches.get(tab) ?? 0) + 1;
        attaches.set(tab, n);
        const sessionId = n === 1 ? `sess-${tab}` : `sess-${tab}-${n}`;
        sessions.set(sessionId, tab);
        return { sessionId };
      }
      case 'Target.setDiscoverTargets':
        FakeBrowserWs.onDiscover?.(this);
        return {};
      case 'Target.setAutoAttach': {
        const tab = frame.sessionId ? sessions.get(frame.sessionId) : undefined;
        const page = tab ? tabs.get(tab) : undefined;
        if (tab && page) {
          if (FakeBrowserWs.heldPages) FakeBrowserWs.heldPages.push(() => this.announcePage(tab, page));
          else this.announcePage(tab, page);
        }
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
/** PUT /json/new calls so far: a freshly spawned Chrome lists only its
 *  startup tab until wmux opens one. */
let opened = 0;
const STARTUP_TAB = { id: 'startup', url: 'chrome://newtab/', title: 'New Tab', type: 'page' };

function listed(): unknown[] {
  if (spawnMock.mock.calls.length > 0 && opened === 0) return [STARTUP_TAB];
  return listedPages.map((id) => ({ id, url: `https://${id}.test/`, title: id.toUpperCase(), type: 'page' }));
}

function fetchOk(body: unknown) {
  return { ok: true, text: async () => JSON.stringify(body) };
}

function serveChrome(): void {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const s = String(url);
    if (s.includes('/json/version')) return fetchOk({ Browser: 'Chrome/151', webSocketDebuggerUrl: WS_URL });
    if (init?.method === 'PUT') {
      opened++;
      return fetchOk({ id: nextCreatedPage, url: 'https://opened.test/' });
    }
    if (s.includes('/json/list')) return fetchOk(listed());
    return fetchOk({});
  });
}

function spawnWritesPortFile(child: FakeChild, port: number): void {
  spawnMock.mockImplementationOnce((_bin: string, args: string[]) => {
    const dir = (args.find((a) => a.startsWith('--user-data-dir=')) ?? '')
      .slice('--user-data-dir='.length)
      .replace(/\\/g, '/');
    // The path the fake Chrome answers with (WS_URL): it wrote this file.
    state.portFiles[dir] = `${port}\n/devtools/browser/watcher-uuid\n`;
    return child;
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  spawnMock.mockReset();
  state.portFiles = {};
  tabs.clear();
  sessions.clear();
  attaches.clear();
  listedPages = [];
  nextCreatedPage = 'page-1';
  opened = 0;
  FakeBrowserWs.instances = [];
  FakeBrowserWs.failConnect = false;
  FakeBrowserWs.onDiscover = null;
  FakeBrowserWs.heldPages = null;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeBrowserWs);
  // These fakes are a Chrome on a DevTools port, whatever the default transport is.
  vi.stubEnv('WMUX_CHROME_TRANSPORT', 'port');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
      if (init?.method === 'PUT') {
        opened++;
        return fetchOk({ id: nextCreatedPage, url: 'https://opened.test/' });
      }
      if (s.includes('/json/list')) return fetchOk(listed());
      return fetchOk({});
    });

    const launcher = new ChromeLauncher('/tmp/watch-6', { profileName: 'p1' });
    const opening = launcher.openTab('https://a.test/', 'ws-1');
    await vi.waitFor(() => expect(failWatcherVersion).not.toBeNull(), { timeout: 5_000 });

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
    state.portFiles['/tmp/watch-5'] = '22001\n/devtools/browser/watcher-uuid\n';
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

describe('ChromeLauncher tabs its own tabs open (target=_blank, window.open)', () => {
  /** A page Chrome created, announced as discovery announces it. */
  function created(ws: FakeBrowserWs, targetId: string, openerId?: string): void {
    ws.event('Target.targetCreated', { targetInfo: { targetId, type: 'page', url: '', title: '', ...(openerId && { openerId }) } });
  }

  async function running(dir: string, store = makeFakeStore()) {
    spawnWritesPortFile(makeChild(), 22001);
    serveChrome();
    tabs.set('tab-1', 'page-1');
    listedPages = ['page-1'];
    const launcher = new ChromeLauncher(dir, { profileName: 'p1', surfaceStore: asStore(store) });
    const heard: ChromeOpenedSurface[] = [];
    launcher.onSurfaceOpened((opened) => heard.push(opened));
    const opener = await launcher.openTab('https://a.test/', 'ws-1');
    return { launcher, opener, heard, store, ws: FakeBrowserWs.instances[0] };
  }

  it('adopts a page its tab opened, in the opener\'s workspace, anchors it, and says so', async () => {
    const { launcher, opener, heard, store, ws } = await running('/tmp/pop-1');

    created(ws, 'page-2', 'page-1');
    expect(heard).toEqual([{ openerSurfaceId: opener.surfaceId, surfaceId: expect.stringMatching(/^chrome-/), workspaceId: 'ws-1', url: '' }]);
    const popup = heard[0].surfaceId;
    expect(launcher.recordFor(popup)).toMatchObject({ targetId: 'page-2', workspaceId: 'ws-1' });

    // Its tab attaches next and becomes its anchor.
    tabs.set('tab-2', 'page-2');
    ws.event('Target.targetCreated', { targetInfo: { targetId: 'tab-2', type: 'tab' } });
    await tick();
    expect(launcher.recordFor(popup)?.tabTargetId).toBe('tab-2');

    listedPages = ['page-1', 'page-2'];
    expect((await launcher.listTargets('ws-1')).map((t) => t.surfaceId)).toEqual([opener.surfaceId, popup]);
    await tick();
    expect(store.profiles.get('p1')?.map((r) => r.surfaceId)).toContain(popup);

    // Its own popups follow it, into the same workspace.
    created(ws, 'page-3', 'page-2');
    expect(heard[1]).toMatchObject({ openerSurfaceId: popup, workspaceId: 'ws-1' });
  });

  it('leaves a page no tab of its own opened to nobody', async () => {
    const { launcher, heard, ws } = await running('/tmp/pop-2');
    created(ws, 'page-7', 'page-of-the-user');
    created(ws, 'page-8');
    expect(heard).toEqual([]);
    listedPages = ['page-1', 'page-7', 'page-8'];
    expect((await launcher.listTargets()).map((t) => t.targetId)).toEqual(['page-1']);
  });

  it('a popup stays in its opener\'s workspace, and an opener with none gives a popup with none', async () => {
    const { launcher, heard, ws } = await running('/tmp/pop-3');
    nextCreatedPage = 'page-2';
    tabs.set('tab-2', 'page-2');
    const other = await launcher.openTab('https://b.test/', 'ws-2');
    nextCreatedPage = 'page-3';
    tabs.set('tab-3', 'page-3');
    const none = await launcher.openTab('https://c.test/');

    created(ws, 'page-4', 'page-2');
    created(ws, 'page-5', 'page-3');
    expect(heard).toEqual([
      { openerSurfaceId: other.surfaceId, surfaceId: expect.any(String), workspaceId: 'ws-2', url: '' },
      { openerSurfaceId: none.surfaceId, surfaceId: expect.any(String), url: '' },
    ]);
    listedPages = ['page-1', 'page-2', 'page-3', 'page-4', 'page-5'];
    const ws1 = (await launcher.listTargets('ws-1')).map((t) => t.targetId);
    expect(ws1).not.toContain('page-4');
    expect((await launcher.listTargets('ws-2')).filter((t) => t.workspaceId === 'ws-2').map((t) => t.targetId)).toEqual(['page-2', 'page-4']);
  });

  it('never adopts the pages discovery replays when the watcher starts, only pages made after it', async () => {
    // Chrome outlived wmux with the record's tab and a popup of it open.
    state.portFiles['/tmp/pop-4'] = '22001\n/devtools/browser/watcher-uuid\n';
    serveChrome();
    tabs.set('tab-1', 'page-1');
    listedPages = ['page-1', 'page-old'];
    const now = Date.now();
    const store = makeFakeStore({
      p1: [{ surfaceId: 'chrome-opener', targetId: 'page-1', tabTargetId: 'tab-1', workspaceId: 'ws-1', url: 'https://a.test/', createdAt: now, lastSeenAt: now }],
    });
    FakeBrowserWs.onDiscover = (ws) => created(ws, 'page-old', 'page-1');
    const launcher = new ChromeLauncher('/tmp/pop-4', { profileName: 'p1', surfaceStore: asStore(store) });
    const heard: ChromeOpenedSurface[] = [];
    launcher.onSurfaceOpened((opened) => heard.push(opened));
    await launcher.ensureRunning();
    expect(FakeBrowserWs.instances).toHaveLength(1);
    expect(launcher.recordFor('chrome-opener')?.targetId).toBe('page-1');
    expect(heard).toEqual([]);

    created(FakeBrowserWs.instances[0], 'page-new', 'page-1');
    expect(heard.map((o) => o.openerSurfaceId)).toEqual(['chrome-opener']);
  });

  it('a popup is the connection\'s that owns its opener, and nobody\'s when that one is', async () => {
    surfaceOpeners.clear();
    const { heard, opener, ws, launcher } = await running('/tmp/pop-6');
    surfaceOpeners.note(opener.surfaceId, 'key-a', 'pty-a');
    created(ws, 'page-2', 'page-1');
    expect(surfaceOpeners.verdict(heard[0].surfaceId, { openerKey: 'key-a' })).toBe('mine');
    expect(surfaceOpeners.verdict(heard[0].surfaceId, { openerKey: 'key-b' })).toBe('other');

    nextCreatedPage = 'page-3';
    tabs.set('tab-3', 'page-3');
    await launcher.openTab('https://b.test/', 'ws-1');
    created(ws, 'page-4', 'page-3');
    expect(surfaceOpeners.verdict(heard[1].surfaceId, { openerKey: 'key-b' })).toBeUndefined();
    surfaceOpeners.clear();
  });

  it('closing the opener leaves its popup; the popup goes when its own tab does, or when closed', async () => {
    const { launcher, heard, opener, ws } = await running('/tmp/pop-7');
    tabs.set('tab-2', 'page-2');
    created(ws, 'page-2', 'page-1');
    ws.event('Target.targetCreated', { targetInfo: { targetId: 'tab-2', type: 'tab' } });
    tabs.set('tab-3', 'page-3');
    created(ws, 'page-3', 'page-1');
    ws.event('Target.targetCreated', { targetInfo: { targetId: 'tab-3', type: 'tab' } });
    await tick();
    const [first, second] = heard.map((o) => o.surfaceId);

    ws.event('Target.targetDestroyed', { targetId: 'tab-1' });
    expect(launcher.hasSurface(opener.surfaceId)).toBe(false);
    expect(launcher.hasSurface(first)).toBe(true);
    expect(launcher.hasSurface(second)).toBe(true);

    ws.event('Target.targetDestroyed', { targetId: 'tab-2' });
    expect(launcher.hasSurface(first)).toBe(false);

    expect(await launcher.closeSurface(second)).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/json/close/page-3'))).toBe(true);
    expect(launcher.hasSurface(second)).toBe(false);
  });

  /** Date.now under the test's control, and console.warn captured, for the limit cases. */
  type WarnSpy = { mock: { calls: unknown[][] } };
  async function limited(run: (clock: { advance(ms: number): void }, warn: WarnSpy) => Promise<void>): Promise<void> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await run({ advance: (ms) => { now += ms; } }, warn);
    } finally {
      clock.mockRestore();
      warn.mockRestore();
    }
  }
  let nextPopup = 100;
  /** `n` pages opened by `opener`, as fast as Chrome can make them. */
  const burst = (ws: FakeBrowserWs, opener: string, n: number) => { for (let i = 0; i < n; i++) created(ws, `page-${nextPopup++}`, opener); };
  /** Another tab wmux opens, as page-<n> in tab-<n>. */
  async function openAnother(launcher: ChromeLauncher, n: number, workspaceId: string): Promise<string> {
    nextCreatedPage = `page-${n}`;
    tabs.set(`tab-${n}`, `page-${n}`);
    return (await launcher.openTab('https://b.test/', workspaceId)).surfaceId;
  }
  const limitLogs = (warn: WarnSpy) => warn.mock.calls.filter(([m]) => String(m).includes('are not adopted past'));

  it('adopts at most a minute\'s worth from one tab, one workspace and one profile, logging each run of refusals once', async () => {
    await limited(async (clock, warn) => {
      const { launcher, heard, ws } = await running('/tmp/pop-8');
      burst(ws, 'page-1', OPENED_PER_OPENER_PER_MINUTE + 2);
      expect(heard).toHaveLength(OPENED_PER_OPENER_PER_MINUTE);
      expect(limitLogs(warn)).toHaveLength(1);

      // Another tab of the same workspace adopts up to the workspace's limit.
      await openAnother(launcher, 2, 'ws-1');
      burst(ws, 'page-2', OPENED_PER_OPENER_PER_MINUTE);
      await openAnother(launcher, 3, 'ws-1');
      burst(ws, 'page-3', 1);
      expect(heard).toHaveLength(OPENED_PER_WORKSPACE_PER_MINUTE);

      // Other workspaces on the profile adopt, up to the profile's limit.
      let n = 4;
      for (let w = 2; heard.length < OPENED_PER_MINUTE; w++) {
        for (let k = 0; k < OPENED_PER_WORKSPACE_PER_MINUTE / OPENED_PER_OPENER_PER_MINUTE; k++, n++) {
          await openAnother(launcher, n, `ws-${w}`);
          burst(ws, `page-${n}`, OPENED_PER_OPENER_PER_MINUTE);
        }
      }
      expect(heard).toHaveLength(OPENED_PER_MINUTE);
      await openAnother(launcher, n, 'ws-new');
      burst(ws, `page-${n}`, 1);
      expect(heard).toHaveLength(OPENED_PER_MINUTE);

      // A minute later the first tab adopts again.
      clock.advance(60_000);
      burst(ws, 'page-1', 1);
      expect(heard).toHaveLength(OPENED_PER_MINUTE + 1);
    });
  });

  it('adopts no more than a tab, or a workspace, may hold open; closing one makes room', async () => {
    await limited(async (clock, warn) => {
      const { launcher, heard, ws } = await running('/tmp/pop-9');
      // One tab, a minute's worth at a time, up to what it may hold open.
      while (heard.length < OPENED_OPEN_PER_OPENER) {
        burst(ws, 'page-1', Math.min(OPENED_PER_OPENER_PER_MINUTE, OPENED_OPEN_PER_OPENER - heard.length));
        clock.advance(60_000);
      }
      burst(ws, 'page-1', 1);
      expect(heard).toHaveLength(OPENED_OPEN_PER_OPENER);
      expect(limitLogs(warn).at(-1)?.[0]).toContain('open tabs from one tab');
      expect(await launcher.closeSurface(heard[0].surfaceId)).toBe(true);
      burst(ws, 'page-1', 1);
      expect(heard).toHaveLength(OPENED_OPEN_PER_OPENER + 1);

      // The workspace's other tabs, up to what the workspace may hold open.
      let n = 2;
      while (heard.length - 1 < OPENED_OPEN_PER_WORKSPACE) {
        await openAnother(launcher, n, 'ws-1');
        burst(ws, `page-${n++}`, Math.min(OPENED_PER_OPENER_PER_MINUTE, OPENED_OPEN_PER_WORKSPACE - (heard.length - 1)));
        clock.advance(60_000);
      }
      await openAnother(launcher, n, 'ws-1');
      burst(ws, `page-${n}`, 1);
      expect(heard).toHaveLength(OPENED_OPEN_PER_WORKSPACE + 1);
      expect(limitLogs(warn).at(-1)?.[0]).toContain('open tabs in one workspace');
    });
  });

  it('starts the limits over when Chrome is gone and comes back', async () => {
    await limited(async () => {
      const child = makeChild();
      spawnWritesPortFile(child, 22001);
      serveChrome();
      tabs.set('tab-1', 'page-1');
      listedPages = ['page-1'];
      const launcher = new ChromeLauncher('/tmp/pop-10', { profileName: 'p1', surfaceStore: asStore(makeFakeStore()) });
      const heard: ChromeOpenedSurface[] = [];
      launcher.onSurfaceOpened((opened) => heard.push(opened));
      await launcher.openTab('https://a.test/', 'ws-1');
      burst(FakeBrowserWs.instances[0], 'page-1', OPENED_PER_OPENER_PER_MINUTE);
      await openAnother(launcher, 2, 'ws-1');
      burst(FakeBrowserWs.instances[0], 'page-2', OPENED_PER_OPENER_PER_MINUTE + 1);
      expect(heard).toHaveLength(OPENED_PER_WORKSPACE_PER_MINUTE);

      child.emit('exit');
      spawnWritesPortFile(makeChild(), 22001);
      await openAnother(launcher, 3, 'ws-1');
      burst(FakeBrowserWs.instances.at(-1) as FakeBrowserWs, 'page-3', 1);
      expect(heard).toHaveLength(OPENED_PER_WORKSPACE_PER_MINUTE + 1);
    });
  });

  it('never adopts a prerendered page', async () => {
    const { heard, ws } = await running('/tmp/pop-11');
    ws.event('Target.targetCreated', { targetInfo: { targetId: 'page-pre', type: 'page', subtype: 'prerender', url: '', openerId: 'page-1' } });
    expect(heard).toEqual([]);
  });

  it('forgets the connection a popup belonged to once Chrome closes it', async () => {
    surfaceOpeners.clear();
    const { opener, heard, ws } = await running('/tmp/pop-12');
    surfaceOpeners.note(opener.surfaceId, 'key-a');
    tabs.set('tab-2', 'page-2');
    created(ws, 'page-2', 'page-1');
    ws.event('Target.targetCreated', { targetInfo: { targetId: 'tab-2', type: 'tab' } });
    await tick();
    expect(surfaceOpeners.get(heard[0].surfaceId)).toBe('key-a');
    ws.event('Target.targetDestroyed', { targetId: 'tab-2' });
    expect(surfaceOpeners.get(heard[0].surfaceId)).toBeUndefined();
    surfaceOpeners.clear();
  });

  it('a page Chrome swaps into an adopted tab stays that tab\'s surface, not a second one', async () => {
    const { launcher, heard, ws } = await running('/tmp/pop-13');
    tabs.set('tab-2', 'page-2');
    created(ws, 'page-2', 'page-1');
    ws.event('Target.targetCreated', { targetInfo: { targetId: 'tab-2', type: 'tab' } });
    await tick();
    const popup = heard[0].surfaceId;
    expect(launcher.recordFor(popup)?.tabTargetId).toBe('tab-2');

    // The replacement page is announced with the same opener before its tab is known.
    created(ws, 'page-5', 'page-1');
    expect(heard).toHaveLength(2);
    tabs.set('tab-2', 'page-5');
    ws.event('Target.detachedFromTarget', { sessionId: 'page-sess-page-2', targetId: 'page-2' }, 'sess-tab-2');
    ws.announcePage('tab-2', 'page-5');

    expect(launcher.recordFor(popup)?.targetId).toBe('page-5');
    expect(launcher.hasSurface(heard[1].surfaceId)).toBe(false);
    listedPages = ['page-1', 'page-5'];
    expect((await launcher.listTargets('ws-1')).filter((t) => t.targetId === 'page-5').map((t) => t.surfaceId)).toEqual([popup]);
  });

  it('stops telling a listener once it unsubscribes', async () => {
    const { launcher, ws } = await running('/tmp/pop-5');
    const late: ChromeOpenedSurface[] = [];
    const off = launcher.onSurfaceOpened((opened) => late.push(opened));
    off();
    created(ws, 'page-2', 'page-1');
    expect(late).toEqual([]);
  });
});

describe('ChromeLauncher page sessions (the phone preview)', () => {
  async function running(dir: string) {
    spawnWritesPortFile(makeChild(), 22001);
    serveChrome();
    tabs.set('tab-1', 'page-1');
    listedPages = ['page-1'];
    const launcher = new ChromeLauncher(dir, { profileName: 'p1', surfaceStore: asStore(makeFakeStore()) });
    const opened = await launcher.openTab('https://a.test/', 'ws-1');
    return { launcher, surfaceId: opened.surfaceId, ws: FakeBrowserWs.instances[0] };
  }

  it('attaches the page over the watcher socket and sends on that session', async () => {
    const { launcher, surfaceId, ws } = await running('/tmp/page-1');
    const session = await launcher.pageSession(surfaceId);
    await session.send('Page.getLayoutMetrics');
    // One socket: the watcher's, no second connection.
    expect(FakeBrowserWs.instances).toHaveLength(1);
    expect(ws.sent.find((f) => f.method === 'Target.attachToTarget' && f.params?.targetId === 'page-1'))
      .toMatchObject({ params: { targetId: 'page-1', flatten: true } });
    expect(ws.sent.at(-1)).toMatchObject({ method: 'Page.getLayoutMetrics', sessionId: 'sess-page-1' });
    // Reused while it lives.
    await launcher.pageSession(surfaceId);
    expect(ws.sent.filter((f) => f.method === 'Target.attachToTarget' && f.params?.targetId === 'page-1')).toHaveLength(1);
  });

  it('hears events on its own session only, until unsubscribed', async () => {
    const { launcher, surfaceId, ws } = await running('/tmp/page-6');
    const session = await launcher.pageSession(surfaceId);
    const heard: unknown[] = [];
    const off = session.on?.('Page.windowOpen', (params) => heard.push(params.url));
    ws.event('Page.windowOpen', { url: 'https://other.test/' }, 'sess-someone-else');
    ws.event('Page.windowOpen', { url: 'https://mine.test/' }, 'sess-page-1');
    off?.();
    ws.event('Page.windowOpen', { url: 'https://late.test/' }, 'sess-page-1');
    expect(heard).toEqual(['https://mine.test/']);
  });

  it('a session Chrome detached is gone, and the next one attaches afresh', async () => {
    const { launcher, surfaceId, ws } = await running('/tmp/page-2');
    const session = await launcher.pageSession(surfaceId);
    ws.event('Target.detachedFromTarget', { sessionId: 'sess-page-1' });
    const err = await session.send('Runtime.evaluate').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChromePageSessionError);
    expect((err as ChromePageSessionError).reason).toBe('gone');
    await launcher.pageSession(surfaceId);
    expect(ws.sent.filter((f) => f.method === 'Target.attachToTarget' && f.params?.targetId === 'page-1')).toHaveLength(2);
  });

  it('a dropped watcher connection ends its page sessions, even when the socket re-dials in place', async () => {
    const { launcher, surfaceId } = await running('/tmp/page-5');
    const session = await launcher.pageSession(surfaceId);
    FakeBrowserWs.instances[0].close();
    await expect(session.send('Runtime.evaluate')).rejects.toMatchObject({ reason: 'gone' });
  });

  it('never launches Chrome, and needs the watcher socket', async () => {
    const idle = new ChromeLauncher('/tmp/page-3', { profileName: 'p1' });
    await expect(idle.pageSession('chrome-x')).rejects.toMatchObject({ reason: 'unavailable' });
    expect(spawnMock).not.toHaveBeenCalled();

    expect(idle.canPageSession()).toBe(true);
    process.env.WMUX_CHROME_TARGET_WATCHER = '0';
    const { launcher, surfaceId } = await running('/tmp/page-4');
    expect(launcher.canPageSession()).toBe(false);
    await expect(launcher.pageSession(surfaceId)).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(launcher.pageSession('chrome-unknown')).rejects.toMatchObject({ reason: 'gone' });
  });
});

describe('ChromeLauncher stream sessions (the phone browser stream)', () => {
  async function running(dir: string) {
    spawnWritesPortFile(makeChild(), 22001);
    serveChrome();
    tabs.set('tab-1', 'page-1');
    listedPages = ['page-1'];
    const launcher = new ChromeLauncher(dir, { profileName: 'p1', surfaceStore: asStore(makeFakeStore()) });
    const opened = await launcher.openTab('https://a.test/', 'ws-1');
    return { launcher, surfaceId: opened.surfaceId, ws: FakeBrowserWs.instances[0] };
  }

  it('attaches its own session, never the cached page session, and hears only its own events', async () => {
    const { launcher, surfaceId, ws } = await running('/tmp/stream-1');
    const page = await launcher.pageSession(surfaceId);
    const stream = await launcher.streamSession(surfaceId);
    await page.send('Page.getLayoutMetrics');
    await stream.send('Page.startScreencast', { format: 'jpeg' });
    const sessionOf = (method: string) => ws.sent.find((f) => f.method === method)?.sessionId;
    expect(sessionOf('Page.getLayoutMetrics')).toBe('sess-page-1');
    expect(sessionOf('Page.startScreencast')).toBe('sess-page-1-2');
    const heard: unknown[] = [];
    stream.on('Page.screencastFrame', (params) => heard.push(params.n));
    ws.event('Page.screencastFrame', { n: 1 }, 'sess-page-1');
    ws.event('Page.screencastFrame', { n: 2 }, 'sess-page-1-2');
    expect(heard).toEqual([2]);
    // A second stream session is another attach.
    await launcher.streamSession(surfaceId);
    expect(ws.sent.filter((f) => f.method === 'Target.attachToTarget' && f.params?.targetId === 'page-1')).toHaveLength(3);
  });

  it('ends once Chrome detaches it: handlers removed, listeners told, sends gone; the page session lives on', async () => {
    const { launcher, surfaceId, ws } = await running('/tmp/stream-2');
    const page = await launcher.pageSession(surfaceId);
    const stream = await launcher.streamSession(surfaceId);
    const heard: unknown[] = [];
    let closed = 0;
    stream.on('Page.screencastFrame', (params) => heard.push(params.n));
    stream.onClosed(() => { closed++; });
    ws.event('Target.detachedFromTarget', { sessionId: 'sess-page-1-2' });
    expect(stream.closed).toBe(true);
    expect(closed).toBe(1);
    ws.event('Page.screencastFrame', { n: 3 }, 'sess-page-1-2');
    expect(heard).toEqual([]);
    await expect(stream.send('Page.screencastFrameAck', { sessionId: 1 })).rejects.toMatchObject({ reason: 'gone' });
    await expect(page.send('Page.getLayoutMetrics')).resolves.toBeDefined();
    // A listener added after the end still hears it, once.
    stream.onClosed(() => { closed++; });
    await tick();
    expect(closed).toBe(2);
  });

  it('detach() sends Target.detachFromTarget and ends it; a dropped watcher connection ends it too', async () => {
    const { launcher, surfaceId, ws } = await running('/tmp/stream-3');
    const a = await launcher.streamSession(surfaceId);
    let aClosed = false;
    a.onClosed(() => { aClosed = true; });
    await a.detach();
    expect(aClosed).toBe(true);
    expect(ws.sent.at(-1)).toMatchObject({ method: 'Target.detachFromTarget', params: { sessionId: 'sess-page-1' } });
    const b = await launcher.streamSession(surfaceId);
    let bClosed = false;
    b.onClosed(() => { bClosed = true; });
    ws.close();
    expect(bClosed).toBe(true);
    await expect(b.send('Page.enable')).rejects.toMatchObject({ reason: 'gone' });
  });

  it('never launches Chrome; an unknown surface is gone', async () => {
    const idle = new ChromeLauncher('/tmp/stream-4', { profileName: 'p1' });
    await expect(idle.streamSession('chrome-x')).rejects.toMatchObject({ reason: 'unavailable' });
    expect(spawnMock).not.toHaveBeenCalled();
    const { launcher } = await running('/tmp/stream-5');
    await expect(launcher.streamSession('chrome-unknown')).rejects.toMatchObject({ reason: 'gone' });
  });
});

describe('ChromeLauncher outside tabs (the phone preview only)', () => {
  type Internals = { byTargetId: Map<string, string>; byTabTargetId: Map<string, string>; surfaces: Map<string, unknown>; pageToTab: Map<string, string> };
  const internals = (launcher: ChromeLauncher) => launcher as unknown as Internals;

  /** A spawned Chrome with no tab wmux opened, and the watcher not started yet. */
  async function spawned(dir: string, store = makeFakeStore()) {
    spawnWritesPortFile(makeChild(), 22001);
    serveChrome();
    const launcher = new ChromeLauncher(dir, { profileName: 'p1', surfaceStore: asStore(store) });
    await launcher.ensureRunning();
    // From here /json/list reports the test's pages, not the startup tab.
    opened = 1;
    return { launcher, store };
  }

  it('lists a tab another client opened, starting the tab watcher itself and never Chrome', async () => {
    const idle = new ChromeLauncher('/tmp/out-0', { profileName: 'p1' });
    expect(await idle.outsideTabs()).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();

    const { launcher } = await spawned('/tmp/out-1');
    expect(FakeBrowserWs.instances).toHaveLength(0);
    tabs.set('tab-out', 'page-out');
    listedPages = ['page-out'];
    const rows = await launcher.outsideTabs();
    expect(FakeBrowserWs.instances).toHaveLength(1);
    expect(rows).toEqual([{ surfaceId: expect.stringMatching(/^chrome-x-/), targetId: 'page-out', url: 'https://page-out.test/', title: 'PAGE-OUT' }]);
    expect(launcher.hasOutside(rows[0].surfaceId)).toBe(true);
    // One id per tab, for as long as the tab lives.
    expect((await launcher.outsideTabs())[0].surfaceId).toBe(rows[0].surfaceId);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('waits for Chrome to name the page behind a tab it just attached, when that comes after the attach', async () => {
    const { launcher } = await spawned('/tmp/out-11');
    tabs.set('tab-out', 'page-out');
    listedPages = ['page-out'];
    const held: Array<() => void> = [];
    FakeBrowserWs.heldPages = held;
    const listing = launcher.outsideTabs();
    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 5_000 });
    for (const announce of held) announce();
    expect((await listing).map((row) => row.targetId)).toEqual(['page-out']);
  });

  it.each([['on', '1'], ['off', undefined]])('never reaches an agent lane, with the target grant %s', async (_label, grant) => {
    if (grant) vi.stubEnv('WMUX_CDP_TARGET_GRANT', grant);
    const { launcher, store } = await spawned('/tmp/out-2');
    tabs.set('tab-1', 'page-1');
    tabs.set('tab-2', 'page-2');
    listedPages = ['page-1'];
    nextCreatedPage = 'page-1';
    const own = await launcher.openTab('https://a.test/', 'ws-1');
    listedPages = ['page-1', 'page-2'];
    const [outside, ...more] = await launcher.outsideTabs();
    expect(more).toEqual([]);
    expect(outside.targetId).toBe('page-2');

    for (const list of [
      await launcher.listTargets('ws-1'), await launcher.listTargets(), await launcher.listTargets('ws-2'),
      await launcher.cdpInfoTargets('ws-1'), await launcher.cdpInfoTargets(),
    ]) {
      expect(list.every((t) => t.targetId === 'page-1' && t.surfaceId === own.surfaceId)).toBe(true);
    }
    expect(launcher.recordFor(outside.surfaceId)).toBeUndefined();
    expect(launcher.hasSurface(outside.surfaceId)).toBe(false);
    await expect(launcher.pageSession(outside.surfaceId)).rejects.toMatchObject({ reason: 'gone' });
    // The pipe's grant registry reads byTargetId: no entry, no grant.
    expect([...internals(launcher).byTargetId.keys()]).toEqual(['page-1']);
    expect([...internals(launcher).byTabTargetId.keys()]).toEqual(['tab-1']);
    expect(internals(launcher).surfaces.size).toBe(1);
    const saved = JSON.stringify([...store.save.mock.calls, ...store.saveNow.mock.calls]);
    expect(saved).not.toContain('page-2');
    expect(saved).not.toContain(outside.surfaceId);
  });

  it('a tab openTab is creating is not outside, though Chrome lists it before its record exists', async () => {
    const { launcher } = await spawned('/tmp/out-3');
    let answer: (() => void) | null = null;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const s = String(url);
      if (s.includes('/json/version')) return fetchOk({ Browser: 'Chrome/151', webSocketDebuggerUrl: WS_URL });
      if (init?.method === 'PUT') return new Promise((resolve) => { answer = () => resolve(fetchOk({ id: 'page-1', url: 'https://a.test/' })); });
      if (s.includes('/json/list')) return fetchOk(listed());
      return fetchOk({});
    });
    tabs.set('tab-1', 'page-1');
    listedPages = ['page-1'];
    const opening = launcher.openTab('https://a.test/', 'ws-1');
    await vi.waitFor(() => expect(answer).not.toBeNull(), { timeout: 5_000 });
    expect(internals(launcher).pageToTab.get('page-1')).toBe('tab-1');
    let settled = false;
    const listing = launcher.outsideTabs().then((rows) => { settled = true; return rows; });
    await tick();
    await tick();
    expect(settled).toBe(false);
    (answer as unknown as () => void)();
    await opening;
    expect(await listing).toEqual([]);
  });

  it('lists nothing before the persisted records are bound to the running Chrome', async () => {
    state.portFiles['/tmp/out-4'] = '22001\n/devtools/browser/watcher-uuid\n';
    tabs.set('tab-1', 'page-new');
    listedPages = ['page-new'];
    let lists = 0;
    let release: (() => void) | null = null;
    fetchMock.mockImplementation(async (url: string) => {
      const s = String(url);
      if (s.includes('/json/version')) return fetchOk({ Browser: 'Chrome/151', webSocketDebuggerUrl: WS_URL });
      if (s.includes('/json/list')) {
        // The first read is the adoption's revival; it waits for the test.
        if (++lists === 1) return new Promise((resolve) => { release = () => resolve(fetchOk(listed())); });
        return fetchOk(listed());
      }
      return fetchOk({});
    });
    const now = Date.now();
    const store = makeFakeStore({
      p1: [{ surfaceId: 'chrome-anchored', targetId: 'page-old', tabTargetId: 'tab-1', workspaceId: 'ws-1', url: 'https://a.test/', createdAt: now, lastSeenAt: now }],
    });
    const launcher = new ChromeLauncher('/tmp/out-4', { profileName: 'p1', surfaceStore: asStore(store) });
    const running = launcher.ensureRunning();
    await vi.waitFor(() => expect(release).not.toBeNull(), { timeout: 5_000 });
    expect(launcher.isRunning()).toBe(true);
    expect(await launcher.outsideTabs()).toEqual([]);
    (release as unknown as () => void)();
    await running;
    expect(spawnMock).not.toHaveBeenCalled();
    // Bound now: the tab is the anchored record's, not an outside one.
    expect(await launcher.outsideTabs()).toEqual([]);
    expect(launcher.recordFor('chrome-anchored')?.targetId).toBe('page-new');
  });

  it('keeps its id when Chrome swaps the page inside the tab, and its session follows the new page', async () => {
    const { launcher } = await spawned('/tmp/out-5');
    tabs.set('tab-2', 'page-2');
    listedPages = ['page-2'];
    const [first] = await launcher.outsideTabs();
    const ws = FakeBrowserWs.instances[0];
    const before = await launcher.outsidePageSession(first.surfaceId);
    await before.send('Page.getLayoutMetrics');
    expect(ws.sent.at(-1)).toMatchObject({ method: 'Page.getLayoutMetrics', sessionId: 'sess-page-2' });

    tabs.set('tab-2', 'page-3');
    ws.announcePage('tab-2', 'page-3');
    listedPages = ['page-3'];
    const [after] = await launcher.outsideTabs();
    expect(after).toMatchObject({ surfaceId: first.surfaceId, targetId: 'page-3' });
    await expect(before.send('Page.getLayoutMetrics')).rejects.toMatchObject({ reason: 'gone' });
    const next = await launcher.outsidePageSession(first.surfaceId);
    await next.send('Page.getLayoutMetrics');
    expect(ws.sent.at(-1)).toMatchObject({ method: 'Page.getLayoutMetrics', sessionId: 'sess-page-3' });
  });

  it('releaseOutside detaches its page and stream sessions, and nothing more goes out on them', async () => {
    const { launcher } = await spawned('/tmp/out-6');
    tabs.set('tab-2', 'page-2');
    listedPages = ['page-2'];
    const [row] = await launcher.outsideTabs();
    const ws = FakeBrowserWs.instances[0];
    const page = await launcher.outsidePageSession(row.surfaceId);
    const stream = await launcher.outsideStreamSession(row.surfaceId);
    launcher.releaseOutside();
    await tick();
    const detached = ws.sent.filter((f) => f.method === 'Target.detachFromTarget').map((f) => f.params?.sessionId);
    expect(detached).toEqual(['sess-page-2', 'sess-page-2-2']);
    expect(stream.closed).toBe(true);
    const sent = ws.sent.length;
    await expect(page.send('Runtime.evaluate')).rejects.toMatchObject({ reason: 'gone' });
    await expect(stream.send('Page.startScreencast')).rejects.toMatchObject({ reason: 'gone' });
    expect(ws.sent.length).toBe(sent);
  });

  const outsideIds = (launcher: ChromeLauncher) => (launcher as unknown as { outsideTabsById: Map<string, string> }).outsideTabsById;

  async function withOutsideTab(dir: string) {
    const child = makeChild();
    spawnWritesPortFile(child, 22001);
    serveChrome();
    const launcher = new ChromeLauncher(dir, { profileName: 'p1', surfaceStore: asStore(makeFakeStore()) });
    await launcher.ensureRunning();
    opened = 1;
    tabs.set('tab-2', 'page-2');
    listedPages = ['page-2'];
    const [row] = await launcher.outsideTabs();
    expect(launcher.hasOutside(row.surfaceId)).toBe(true);
    return { launcher, child, id: row.surfaceId };
  }

  it('forgets an id when its tab closes', async () => {
    const { launcher, id } = await withOutsideTab('/tmp/out-7');
    FakeBrowserWs.instances[0].event('Target.targetDestroyed', { targetId: 'tab-2' });
    expect(launcher.hasOutside(id)).toBe(false);
    expect(outsideIds(launcher).size).toBe(0);
  });

  it('forgets every id when the watcher connection drops', async () => {
    const { launcher, id } = await withOutsideTab('/tmp/out-8');
    FakeBrowserWs.instances[0].close();
    expect(launcher.hasOutside(id)).toBe(false);
    expect(outsideIds(launcher).size).toBe(0);
  });

  it('forgets every id when Chrome goes', async () => {
    const gone = await withOutsideTab('/tmp/out-9');
    gone.child.emit('exit');
    expect(gone.launcher.hasOutside(gone.id)).toBe(false);
    expect(outsideIds(gone.launcher).size).toBe(0);
  });

  it('forgets every id on dispose', async () => {
    const disposed = await withOutsideTab('/tmp/out-10');
    await disposed.launcher.dispose({ immediate: true });
    expect(disposed.launcher.hasOutside(disposed.id)).toBe(false);
    expect(outsideIds(disposed.launcher).size).toBe(0);
  });
});
