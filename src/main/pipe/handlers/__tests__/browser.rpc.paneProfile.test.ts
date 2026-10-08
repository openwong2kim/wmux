import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import { surfaceOpeners } from '../../../browser-session/SurfaceOpeners';
import { ChromeProfileStore, LIVE_CHROME_PROFILE } from '../../../browser-session/ChromeProfileStore';
import type { BrowserBackendStore } from '../../../browser-session/BrowserBackendStore';
import { getWorkspaceMirror, __resetWorkspaceMirrorForTest } from '../../../workspace/WorkspaceMirror';
import { PANE_PROFILE_UNRESOLVED_CODE } from '../../../../shared/chromePaneBinding';

/**
 * Per-pane Chrome profiles at the RPC boundary.
 *
 * A pane bound to its own profile drives its own Chrome; every other pane in
 * the workspace keeps the workspace's. The pane is found from the envelope's
 * callerPtyId — only when the workspace has pane bindings at all — and a call
 * from a pane that cannot be identified is refused rather than run as the
 * wrong account. The bindings come from a REAL store; the launchers are fakes.
 */

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => null) },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: vi.fn(async () => ({ valid: true })),
}));

function makeLauncher(profile: string) {
  const tabs = new Map<string, { targetId: string; url: string; workspaceId?: string }>();
  let next = 0;
  const visible = (workspaceId?: string) =>
    [...tabs.entries()]
      .filter(([, t]) => workspaceId === undefined || t.workspaceId === workspaceId)
      .map(([surfaceId, t]) => ({ surfaceId, targetId: t.targetId, workspaceId: t.workspaceId, url: t.url, title: '' }));
  return {
    tabs,
    endpoint: vi.fn(async () => ({ cdpPort: 19000 })),
    cdpInfoTargets: vi.fn(async (workspaceId?: string) => visible(workspaceId)),
    openTab: vi.fn(async (url: string, workspaceId?: string) => {
      const surfaceId = `${profile}-sfc-${++next}`;
      tabs.set(surfaceId, { targetId: `${profile}-tgt-${next}`, url, workspaceId });
      return { surfaceId, targetId: `${profile}-tgt-${next}`, url };
    }),
    listTargets: vi.fn(async (workspaceId?: string) => visible(workspaceId)),
    closeSurface: vi.fn(async (surfaceId: string) => tabs.delete(surfaceId)),
    hasSurface: vi.fn((surfaceId: string) => tabs.has(surfaceId)),
    dispose: vi.fn(),
  };
}

/** Live Chrome where every tab is the user's: any write the policy sees is refused. */
function makeLive() {
  return {
    ...makeLauncher(LIVE_CHROME_PROFILE),
    writeScope: {
      ownerOf: vi.fn(() => 'user' as const),
      beginBorrow: vi.fn(),
      settleBorrow: vi.fn(),
      returnBorrow: vi.fn(),
      clearBorrows: vi.fn(),
      agentWindowFor: vi.fn(),
    },
  };
}

/** The registry's resolution surface over a real store; launchers per profile. */
function makeRegistry(store: ChromeProfileStore) {
  const live = makeLive();
  const launchers = new Map<string, ReturnType<typeof makeLauncher>>();
  const forProfile = vi.fn((profile: string) => {
    if (profile === LIVE_CHROME_PROFILE) return live;
    let launcher = launchers.get(profile);
    if (!launcher) {
      launcher = makeLauncher(profile);
      launchers.set(profile, launcher);
    }
    return launcher;
  });
  return {
    live,
    launchers,
    forProfile,
    profileFor: vi.fn((ws?: string, paneId?: string) => store.profileFor(ws, paneId)),
    hasPaneBindings: vi.fn((ws?: string) => store.hasPaneBindings(ws)),
    isPaneBound: vi.fn((profile: string) => store.isPaneBound(profile)),
    ownerOfSurface: vi.fn((surfaceId: string) => {
      for (const [profile, client] of launchers) {
        const tab = client.tabs.get(surfaceId);
        if (tab) return { ...(tab.workspaceId !== undefined && { workspaceId: tab.workspaceId }), profile, client };
      }
      return null;
    }),
    statusForProfile: vi.fn(async (profile: string) => ({ profile, running: false, cdpPort: null })),
    disposeAll: vi.fn(),
  };
}

function register(registry: ReturnType<typeof makeRegistry>): RpcRouter {
  const router = new RpcRouter();
  const cdp = {
    getTarget: vi.fn(() => null),
    listTargets: vi.fn(() => []),
    isDiscarded: vi.fn(() => false),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn(() => 'lease-1'),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  registerBrowserRpc(
    router,
    () => null as unknown as BrowserWindow,
    cdp as never,
    { get: () => 'chrome', set: vi.fn(), liveWriteScope: () => 'agent' } as unknown as BrowserBackendStore,
    undefined,
    undefined,
    registry as never,
  );
  return router;
}

async function call(
  router: RpcRouter,
  method: string,
  params: Record<string, unknown>,
  callerPtyId?: string,
  opts?: { operator: true } | { firstParty: true; hostedWorkspace: string },
): Promise<{ result?: unknown; error?: string }> {
  const response = await router.dispatch(
    {
      id: '1',
      method,
      params,
      ...(callerPtyId !== undefined && { callerPtyId }),
    } as never,
    opts,
  );
  if (response.ok) return { result: (response as { result?: unknown }).result };
  return { error: String((response as { error?: unknown }).error ?? '') };
}

/** ws-1 holds pane-a (pty-a, pty-a2: two terminal tabs) and pane-b (pty-b);
 *  ws-2 holds pane-c (pty-c). */
function pushMirror(): void {
  getWorkspaceMirror().setSnapshot({
    ts: Date.now(),
    entries: [
      { id: 'ws-1', name: 'one', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-a2', 'pty-b'] },
      { id: 'ws-2', name: 'two', activePtyId: 'pty-c', ptyIds: ['pty-c'] },
    ],
    fleets: [],
    panePtys: { 'pty-a': 'pane-a', 'pty-a2': 'pane-a', 'pty-b': 'pane-b', 'pty-c': 'pane-c' },
  });
}

let dir: string;
let store: ChromeProfileStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wmux-pane-profile-'));
  store = new ChromeProfileStore(dir);
  await store.create('pa');
  await store.setPaneBinding('pane-a', 'ws-1', 'pa');
  __resetWorkspaceMirrorForTest();
  pushMirror();
  sendToRendererMock.mockReset();
  sendToRendererMock.mockResolvedValue([]);
  surfaceOpeners.clear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  __resetWorkspaceMirrorForTest();
});

describe('which Chrome a call drives', () => {
  it("the bound pane drives its own profile; its neighbour keeps the workspace's", async () => {
    const registry = makeRegistry(store);
    const router = register(registry);

    const a = await call(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'pty-a');
    const b = await call(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'pty-b');
    expect(a.result).toMatchObject({ profile: 'pa', workspaceBackend: 'chrome' });
    expect(b.result).toMatchObject({ profile: 'default' });
    expect(registry.launchers.get('pa')?.endpoint).toHaveBeenCalledTimes(1);
    expect(registry.launchers.get('default')?.endpoint).toHaveBeenCalledTimes(1);
    // Answered from the mirror: no renderer round-trip on the hot path.
    expect(sendToRendererMock).not.toHaveBeenCalled();

    const opened = await call(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' }, 'pty-a');
    expect((opened.result as { surfaceId: string }).surfaceId).toMatch(/^pa-sfc-/);
  });

  it('a pane binding made in another workspace is ignored', async () => {
    // pane-a moved to ws-2; ws-2 has a pane binding of its own, so its calls resolve panes.
    await store.create('pc');
    await store.setPaneBinding('pane-c', 'ws-2', 'pc');
    getWorkspaceMirror().setSnapshot({
      ts: Date.now(),
      entries: [{ id: 'ws-2', name: 'two', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-c'] }],
      fleets: [],
      panePtys: { 'pty-a': 'pane-a', 'pty-c': 'pane-c' },
    });
    const router = register(makeRegistry(store));
    expect((await call(router, 'browser.cdp.info', { workspaceId: 'ws-2' }, 'pty-a')).result).toMatchObject({
      profile: 'default',
    });
    expect((await call(router, 'browser.cdp.info', { workspaceId: 'ws-2' }, 'pty-c')).result).toMatchObject({
      profile: 'pc',
    });
  });

  it(`an unidentified caller in a workspace WITH pane bindings is refused with ${PANE_PROFILE_UNRESOLVED_CODE}`, async () => {
    const registry = makeRegistry(store);
    const router = register(registry);

    const noPty = await call(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' });
    expect(noPty.error).toContain(PANE_PROFILE_UNRESOLVED_CODE);
    // A PTY of another workspace never resolves into this one (round-trip finds nothing).
    const foreign = await call(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'pty-c');
    expect(foreign.error).toContain(PANE_PROFILE_UNRESOLVED_CODE);
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.anything(), 'surface.list', {
      workspaceId: 'ws-1',
      includeStashed: true,
    });
    // Nothing was opened anywhere: failing closed means no launcher at all.
    expect(registry.forProfile).not.toHaveBeenCalled();
  });

  it('the human operator (no PTY) gets the workspace profile; an agent with no PTY stays refused', async () => {
    const registry = makeRegistry(store);
    const router = register(registry);
    const human = await call(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, undefined, { operator: true });
    expect(human.result).toMatchObject({ profile: 'default' });
    expect(sendToRendererMock).not.toHaveBeenCalled();
    const agent = await call(router, 'browser.cdp.info', { workspaceId: 'ws-1' });
    expect(agent.error).toContain(PANE_PROFILE_UNRESOLVED_CODE);
  });

  it('an approved in-process plugin (hosted lane, no PTY) gets the workspace profile too', async () => {
    const router = register(makeRegistry(store));
    const hosted = await call(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, undefined, { firstParty: true, hostedWorkspace: 'ws-1' });
    // Scoped to ws-1 (which HAS pane bindings), yet answered without a pane.
    expect(hosted.result).toMatchObject({ profile: 'default', targetsScoped: true });
  });

  it('a workspace WITHOUT pane bindings never looks up the pane', async () => {
    const registry = makeRegistry(store);
    const router = register(registry);
    __resetWorkspaceMirrorForTest(); // nothing to answer from either

    const r = await call(router, 'browser.cdp.info', { workspaceId: 'ws-2' }, 'pty-c');
    expect(r.result).toMatchObject({ profile: 'default' });
    const status = await call(router, 'browser.session.status', { workspaceId: 'ws-2' });
    expect(status.result).toMatchObject({ backend: 'chrome', profile: 'default' });
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it("session.status reports the pane's profile without creating its launcher", async () => {
    const registry = makeRegistry(store);
    const router = register(registry);
    const status = await call(router, 'browser.session.status', { workspaceId: 'ws-1' }, 'pty-a');
    expect(status.result).toMatchObject({ profile: 'pa' });
    expect(registry.statusForProfile).toHaveBeenCalledWith('pa');
    expect(registry.forProfile).not.toHaveBeenCalled();
  });
});

describe("one pane cannot tear down another pane's Chrome", () => {
  it('browser.close by surfaceId refuses a tab in a different pane profile, same workspace', async () => {
    const registry = makeRegistry(store);
    const router = register(registry);
    const opened = await call(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' }, 'pty-a');
    const surfaceId = (opened.result as { surfaceId: string }).surfaceId;

    // pane-b resolves to 'default'; the tab lives in pane-a's 'pa' Chrome. The
    // cross-launcher fallback used to accept it because the workspace matched.
    const fromB = await call(router, 'browser.close', { surfaceId, workspaceId: 'ws-1' }, 'pty-b');
    expect(fromB.error).toContain("another pane's Chrome profile");
    expect(registry.launchers.get('pa')?.tabs.has(surfaceId)).toBe(true);

    const fromA = await call(router, 'browser.close', { surfaceId, workspaceId: 'ws-1' }, 'pty-a');
    expect(fromA.result).toMatchObject({ ok: true, closed: true, surfaceId });
  });

  it("a pane-bound caller cannot reach into the workspace's Chrome either", async () => {
    const registry = makeRegistry(store);
    const router = register(registry);
    const opened = await call(router, 'browser.open', { url: 'https://b.test/', workspaceId: 'ws-1' }, 'pty-b');
    const surfaceId = (opened.result as { surfaceId: string }).surfaceId;
    expect(surfaceId).toMatch(/^default-sfc-/);

    const fromA = await call(router, 'browser.close', { surfaceId, workspaceId: 'ws-1' }, 'pty-a');
    expect(fromA.error).toContain("another pane's Chrome profile");
    expect(registry.launchers.get('default')?.tabs.has(surfaceId)).toBe(true);
  });

  it("a call with no workspace is told why it cannot close a pane's tab", async () => {
    const registry = makeRegistry(store);
    const router = register(registry);
    const opened = await call(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' }, 'pty-a');
    const surfaceId = (opened.result as { surfaceId: string }).surfaceId;

    const unscoped = await call(router, 'browser.close', { surfaceId });
    expect(unscoped.error).toContain('names no workspace');
    expect(registry.launchers.get('pa')?.tabs.has(surfaceId)).toBe(true);
  });
});

describe('a pane-bound profile inside a live-bound workspace', () => {
  it('the pane writes to its own dedicated tab; the live policy still guards the rest', async () => {
    await store.setBinding('ws-1', LIVE_CHROME_PROFILE);
    const registry = makeRegistry(store);
    const router = register(registry);

    const opened = await call(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' }, 'pty-a');
    const surfaceId = (opened.result as { surfaceId: string }).surfaceId;
    expect(surfaceId).toMatch(/^pa-sfc-/);
    const closed = await call(router, 'browser.close', { surfaceId, workspaceId: 'ws-1' }, 'pty-a');
    expect(closed.result).toMatchObject({ ok: true, closed: true });

    // pane-b is on the workspace's live Chrome, where the tab is the user's.
    const fromB = await call(router, 'browser.close', { surfaceId: 'user-tab', workspaceId: 'ws-1' }, 'pty-b');
    expect(fromB.error).toMatch(/agent_window_scope/);
  });
});

describe('browser.surface.adopt only claims a tab the caller was offered', () => {
  it("refuses another pane's tab and another workspace's tab", async () => {
    await store.create('pc');
    await store.setPaneBinding('pane-c', 'ws-2', 'pc');
    const router = register(makeRegistry(store));
    const a = await call(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' }, 'pty-a');
    const aTab = (a.result as { surfaceId: string }).surfaceId;

    // pane-b's Chrome is the workspace's 'default': pane-a's tab is not in it.
    const fromB = await call(router, 'browser.surface.adopt', { workspaceId: 'ws-1', surfaceId: aTab, openerKey: 'k-b' }, 'pty-b');
    expect(fromB.error).toContain('is not a Chrome tab of this workspace');
    const fromC = await call(router, 'browser.surface.adopt', { workspaceId: 'ws-2', surfaceId: aTab, openerKey: 'k-c' }, 'pty-c');
    expect(fromC.error).toContain('is not a Chrome tab of this workspace');
    expect(surfaceOpeners.get(aTab)).toBeUndefined();

    const fromA = await call(router, 'browser.surface.adopt', { workspaceId: 'ws-1', surfaceId: aTab, openerKey: 'k-a' }, 'pty-a');
    expect(fromA.result).toEqual({ ok: true, owner: 'mine' });
  });
});

describe('R4: a restarted agent keeps its pane tab', () => {
  it('same terminal re-claims its tab under a new opener key; another terminal of the pane does not', async () => {
    const router = register(makeRegistry(store));
    const opened = await call(
      router,
      'browser.open',
      { url: 'https://a.test/', workspaceId: 'ws-1', openerKey: 'key-before-restart' },
      'pty-a',
    );
    const surfaceId = (opened.result as { surfaceId: string }).surfaceId;
    const openerOf = async (openerKey: string, pty: string) => {
      const info = (await call(router, 'browser.cdp.info', { workspaceId: 'ws-1', openerKey }, pty)).result as {
        targets: Array<{ surfaceId: string; opener?: string }>;
      };
      return info.targets.find((t) => t.surfaceId === surfaceId)?.opener;
    };

    expect(await openerOf('key-after-restart', 'pty-a')).toBe('mine');
    expect(await openerOf('key-other-tab', 'pty-a2')).toBe('other');

    const adoptOther = await call(
      router,
      'browser.surface.adopt',
      { workspaceId: 'ws-1', surfaceId, openerKey: 'key-other-tab' },
      'pty-a2',
    );
    expect(adoptOther.result).toEqual({ ok: true, owner: 'other' });
    const adoptSame = await call(
      router,
      'browser.surface.adopt',
      { workspaceId: 'ws-1', surfaceId, openerKey: 'key-after-restart' },
      'pty-a',
    );
    expect(adoptSame.result).toEqual({ ok: true, owner: 'mine' });
    expect(surfaceOpeners.get(surfaceId)).toBe('key-after-restart');
  });

  it('outside a pane-bound profile the terminal alone never claims a tab', async () => {
    const router = register(makeRegistry(store));
    // pane-b is on the shared workspace profile.
    const opened = await call(
      router,
      'browser.open',
      { url: 'https://b.test/', workspaceId: 'ws-1', openerKey: 'key-1' },
      'pty-b',
    );
    const surfaceId = (opened.result as { surfaceId: string }).surfaceId;
    const info = (await call(router, 'browser.cdp.info', { workspaceId: 'ws-1', openerKey: 'key-2' }, 'pty-b'))
      .result as { targets: Array<{ surfaceId: string; opener?: string }> };
    expect(info.targets.find((t) => t.surfaceId === surfaceId)?.opener).toBe('other');
  });
});

describe('single resolution point', () => {
  it('no browser handler reads the workspace binding on its own', () => {
    const source = readFileSync(join(__dirname, '..', 'browser.rpc.ts'), 'utf8');
    // The registry's workspace-only lookups would silently skip the pane.
    expect(source).not.toMatch(/\.forWorkspace\(/);
    expect(source).not.toMatch(/\.statusForWorkspace\(/);
    // forProfile is reached from exactly one place: resolveChromeClient.
    expect(source.match(/\.forProfile\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\brequireChrome\(/);
  });
});
