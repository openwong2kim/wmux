import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import { surfaceOpeners } from '../../../browser-session/SurfaceOpeners';
import type { BrowserBackendStore } from '../../../browser-session/BrowserBackendStore';

/**
 * Who opened a browser surface, and what main does with that.
 *
 * Two agent panes in one workspace hold two MCP connections. On the builtin
 * backend `browser.open` REUSES the workspace's first browser surface, so
 * agent B's open navigated agent A's pane and handed B agent A's surfaceId —
 * after which every call of B's that named no surface landed there too. Main
 * now records the opening connection and reuses a surface only when the caller
 * opened it, or when nobody claims it.
 */

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => null) },
  shell: { openExternal: vi.fn() },
}));
const { validateUrlMock } = vi.hoisted(() => ({ validateUrlMock: vi.fn() }));
vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: validateUrlMock,
}));

const OPENER_A = 'opener-aaaa';
const OPENER_B = 'opener-bbbb';

/** One builtin surface per entry, in the renderer's pane-tree order. */
function rendererWith(order: string[]) {
  const tab = (surfaceId: string) => ({
    surfaceId,
    paneId: `pane-${surfaceId}`,
    url: 'https://example.test/',
    title: 'Browser',
    selected: false,
  });
  let created = 0;
  sendToRendererMock.mockImplementation(async (_getWindow: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'browser.tabs' && params.action === 'list') {
      return { ok: true, action: 'list', tabs: order.map(tab) };
    }
    if (method === 'browser.tabs' && params.action === 'new') {
      const surfaceId = `surf-new-${++created}`;
      order.push(surfaceId);
      return { ok: true, action: 'new', tab: tab(surfaceId) };
    }
    if (method === 'browser.close') return { ok: true };
    if (method === 'browser.open') {
      // The renderer's own rule: reuse the FIRST browser surface, else create.
      const reused = order[0];
      if (reused) return { ok: true, surfaceId: reused, url: params.url ?? 'https://example.test/', reused: true };
      const surfaceId = `surf-new-${++created}`;
      order.push(surfaceId);
      return { ok: true, surfaceId, url: params.url ?? 'https://example.test/' };
    }
    return {};
  });
}

/** A chrome-family client: dedicated instances and the live attach share this
 *  handler path, so one fake covers both (live keeps surfaceId ≡ targetId). */
function fakeChromeRegistry() {
  const tabs = new Map<string, { targetId: string; url: string; workspaceId?: string }>();
  let next = 0;
  const client = {
    endpoint: vi.fn(async () => ({ cdpPort: 18901 })),
    cdpInfoTargets: vi.fn(async (workspaceId?: string) =>
      [...tabs.entries()]
        .filter(([, t]) => workspaceId === undefined || t.workspaceId === workspaceId)
        .map(([surfaceId, t]) => ({ surfaceId, targetId: t.targetId, workspaceId: t.workspaceId, url: t.url, title: '' })),
    ),
    openTab: vi.fn(async (url: string, workspaceId?: string) => {
      const surfaceId = `chrome-${++next}`;
      tabs.set(surfaceId, { targetId: `tgt-${next}`, url, workspaceId });
      return { surfaceId, targetId: `tgt-${next}`, url };
    }),
    listTargets: vi.fn(async () =>
      [...tabs.entries()].map(([surfaceId, t]) => ({ surfaceId, targetId: t.targetId, workspaceId: t.workspaceId, url: t.url, title: '' })),
    ),
    closeSurface: vi.fn(async (surfaceId: string) => tabs.delete(surfaceId)),
    hasSurface: vi.fn((surfaceId: string) => tabs.has(surfaceId)),
    dispose: vi.fn(),
  };
  return { client, registry: { forWorkspace: vi.fn(() => client), forProfile: vi.fn(() => client), ownerOfSurface: vi.fn(() => null), disposeAll: vi.fn() } };
}

function registerChrome(registry: unknown): RpcRouter {
  const router = new RpcRouter();
  const cdp = {
    getTarget: vi.fn(() => null),
    listTargets: vi.fn(() => []),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    acquireRpcLease: vi.fn(() => 'lease-1'),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  registerBrowserRpc(
    router,
    () => null as unknown as BrowserWindow,
    cdp as never,
    { get: () => 'chrome', set: () => undefined } as unknown as BrowserBackendStore,
    undefined,
    undefined,
    registry as never,
  );
  return router;
}

function register(): RpcRouter {
  const router = new RpcRouter();
  const cdp = {
    getTarget: vi.fn(() => null),
    listTargets: vi.fn(() => []),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    acquireRpcLease: vi.fn(() => 'lease-1'),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  registerBrowserRpc(
    router,
    () => null as unknown as BrowserWindow,
    cdp as never,
    { get: () => 'builtin', set: () => undefined } as unknown as BrowserBackendStore,
  );
  return router;
}

async function dispatch(router: RpcRouter, method: string, params: Record<string, unknown> = {}) {
  const response = await router.dispatch({ id: '1', method, params } as never);
  return response.ok ? (response as { result?: unknown }).result : { error: String((response as { error?: unknown }).error) };
}

/** Which renderer methods this call reached, in order. */
const rendererCalls = () =>
  sendToRendererMock.mock.calls.map(
    (call) => `${call[1]}${call[2]?.action ? `:${call[2].action}` : ''}`,
  );

beforeEach(() => {
  sendToRendererMock.mockReset();
  validateUrlMock.mockResolvedValue({ valid: true });
  surfaceOpeners.clear();
});

describe('builtin browser.open reuse, by opener', () => {
  it('gives B its own surface instead of reusing the one A opened', async () => {
    const router = register();
    rendererWith([]);

    const first = (await dispatch(router, 'browser.open', {
      workspaceId: 'ws-1',
      openerKey: OPENER_A,
    })) as { surfaceId: string };
    expect(first.surfaceId).toBe('surf-new-1');

    sendToRendererMock.mockClear();
    const second = (await dispatch(router, 'browser.open', {
      workspaceId: 'ws-1',
      url: 'https://b.test/',
      openerKey: OPENER_B,
    })) as { surfaceId: string };

    // A NEW surface, created through the always-new path — and A's surface was
    // never navigated, which is what the old reuse did to it.
    expect(second.surfaceId).toBe('surf-new-2');
    expect(second.surfaceId).not.toBe(first.surfaceId);
    expect(rendererCalls()).toEqual(['browser.tabs:list', 'browser.tabs:new']);
    expect(surfaceOpeners.get(first.surfaceId)).toBe(OPENER_A);
    expect(surfaceOpeners.get(second.surfaceId)).toBe(OPENER_B);
  });

  it('reuses — and adopts — a surface nobody claims', async () => {
    const router = register();
    rendererWith(['surf-restored']);

    const opened = (await dispatch(router, 'browser.open', {
      workspaceId: 'ws-1',
      openerKey: OPENER_B,
    })) as { surfaceId: string };

    expect(opened.surfaceId).toBe('surf-restored');
    expect(rendererCalls()).toEqual(['browser.tabs:list', 'browser.open']);
    // Adoption: the next caller sees it as B's, so B's unsaid calls stay here.
    expect(surfaceOpeners.get('surf-restored')).toBe(OPENER_B);
  });

  it('reuses a surface this connection already opened', async () => {
    const router = register();
    rendererWith(['surf-mine']);
    surfaceOpeners.note('surf-mine', OPENER_B);

    const opened = (await dispatch(router, 'browser.open', {
      workspaceId: 'ws-1',
      openerKey: OPENER_B,
    })) as { surfaceId: string };

    expect(opened.surfaceId).toBe('surf-mine');
    expect(rendererCalls()).toEqual(['browser.tabs:list', 'browser.open']);
  });

  it('leaves a caller with no opener key on the legacy path', async () => {
    // The CLI, the pane button, a person's `wmux browser open`: no key, no
    // ownership question, and not even the list probe.
    const router = register();
    rendererWith(['surf-a']);
    surfaceOpeners.note('surf-a', OPENER_A);

    const opened = (await dispatch(router, 'browser.open', { workspaceId: 'ws-1' })) as {
      surfaceId: string;
    };

    expect(opened.surfaceId).toBe('surf-a');
    expect(rendererCalls()).toEqual(['browser.open']);
  });

  it('reports a failure rather than falling back onto the other agent\'s surface', async () => {
    const router = register();
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'browser.tabs' && params.action === 'list') {
        return { ok: true, action: 'list', tabs: [{ surfaceId: 'surf-a', paneId: 'p', url: '', title: '', selected: false }] };
      }
      if (method === 'browser.tabs' && params.action === 'new') {
        return { ok: false, error: { code: 'BROWSER_TAB_CREATE_FAILED', message: 'pane cap reached' } };
      }
      return { ok: true, surfaceId: 'surf-a', url: '', reused: true };
    });
    surfaceOpeners.note('surf-a', OPENER_A);

    const result = (await dispatch(router, 'browser.open', {
      workspaceId: 'ws-1',
      openerKey: OPENER_B,
    })) as { error?: string; surfaceId?: string };

    expect(result.surfaceId).toBeUndefined();
    expect(result.error).toContain('could not create a browser surface');
    // The pane that belongs to the other connection was left alone.
    expect(rendererCalls()).toEqual(['browser.tabs:list', 'browser.tabs:new']);
  });
});

describe('opener reporting', () => {
  it('marks list rows with a verdict, never with anyone\'s key', async () => {
    const router = register();
    rendererWith(['surf-a', 'surf-b']);
    surfaceOpeners.note('surf-a', OPENER_A);

    const asOwner = (await dispatch(router, 'browser.tabs', {
      action: 'list',
      workspaceId: 'ws-1',
      openerKey: OPENER_A,
    })) as { tabs: Array<{ surfaceId: string; opener?: string }> };
    const asOther = (await dispatch(router, 'browser.tabs', {
      action: 'list',
      workspaceId: 'ws-1',
      openerKey: OPENER_B,
    })) as { tabs: Array<{ surfaceId: string; opener?: string }> };

    expect(asOwner.tabs[0].opener).toBe('mine');
    expect(asOther.tabs[0].opener).toBe('other');
    // Unclaimed stays unclaimed: absent, never guessed.
    expect(asOwner.tabs[1].opener).toBeUndefined();
    // The identity itself never leaves main — a caller cannot learn, or
    // replay, another connection's key.
    expect(JSON.stringify(asOther)).not.toContain(OPENER_A);
  });

  it('records the opener of a tab browser_tabs new created', async () => {
    const router = register();
    rendererWith([]);

    const created = (await dispatch(router, 'browser.tabs', {
      action: 'new',
      workspaceId: 'ws-1',
      openerKey: OPENER_B,
    })) as { tab: { surfaceId: string; opener?: string } };

    expect(created.tab.opener).toBe('mine');
    expect(surfaceOpeners.get(created.tab.surfaceId)).toBe(OPENER_B);
  });

  it('reports an opener VERDICT on cdp.info targets so page selection can use it', async () => {
    const router = new RpcRouter();
    const cdp = {
      getTarget: vi.fn(() => null),
      listTargets: vi.fn(() => [
        { surfaceId: 'surf-a', targetId: 'tgt-a', workspaceId: 'ws-1', webContentsId: 1, wsUrl: '' },
        { surfaceId: 'surf-restored', targetId: 'tgt-r', workspaceId: 'ws-1', webContentsId: 2, wsUrl: '' },
      ]),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      setCaptureAttach: vi.fn(),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };
    registerBrowserRpc(
      router,
      () => null as unknown as BrowserWindow,
      cdp as never,
      { get: () => 'builtin', set: () => undefined } as unknown as BrowserBackendStore,
    );
    surfaceOpeners.note('surf-a', OPENER_A);

    const info = (await dispatch(router, 'browser.cdp.info', {
      workspaceId: 'ws-1',
      openerKey: OPENER_A,
    })) as { targets: Array<{ surfaceId: string; opener?: string }> };
    const asOther = (await dispatch(router, 'browser.cdp.info', {
      workspaceId: 'ws-1',
      openerKey: OPENER_B,
    })) as { targets: Array<{ surfaceId: string; opener?: string }> };

    expect(info.targets[0]).toMatchObject({ surfaceId: 'surf-a', opener: 'mine' });
    expect(info.targets[1].opener).toBeUndefined();
    expect(asOther.targets[0].opener).toBe('other');
    expect(JSON.stringify(asOther)).not.toContain(OPENER_A);
  });

  it('forgets the opener of a closed surface', async () => {
    const router = register();
    rendererWith(['surf-a']);
    surfaceOpeners.note('surf-a', OPENER_A);

    await dispatch(router, 'browser.close', { workspaceId: 'ws-1', surfaceId: 'surf-a' });

    expect(surfaceOpeners.get('surf-a')).toBeUndefined();
  });
});

describe('chrome backend openers', () => {
  it('records the opener of every tab it creates, and reports it on cdp.info', async () => {
    // Chrome always CREATES — there is no reuse question — so the only thing
    // to get right is that the tab is recorded as the caller's.
    const { registry } = fakeChromeRegistry();
    const router = registerChrome(registry);

    const a = (await dispatch(router, 'browser.open', {
      workspaceId: 'ws-1',
      url: 'https://a.test/',
      openerKey: OPENER_A,
    })) as { surfaceId: string };
    const b = (await dispatch(router, 'browser.tabs', {
      action: 'new',
      workspaceId: 'ws-1',
      url: 'https://b.test/',
      openerKey: OPENER_B,
    })) as { tab: { surfaceId: string; opener?: string } };

    expect(surfaceOpeners.get(a.surfaceId)).toBe(OPENER_A);
    expect(b.tab.opener).toBe('mine');

    const info = (await dispatch(router, 'browser.cdp.info', {
      workspaceId: 'ws-1',
      openerKey: OPENER_A,
    })) as { targets: Array<{ surfaceId: string; opener?: string }> };
    expect(info.targets).toEqual([
      expect.objectContaining({ surfaceId: a.surfaceId, opener: 'mine' }),
      expect.objectContaining({ surfaceId: b.tab.surfaceId, opener: 'other' }),
    ]);

    // Closing retires the ownership with the tab.
    await dispatch(router, 'browser.tabs', { action: 'close', workspaceId: 'ws-1', surfaceId: a.surfaceId });
    expect(surfaceOpeners.get(a.surfaceId)).toBeUndefined();
  });
});

describe('reuse guard details', () => {
  it('reuses MY surface even when it is not the first pane', async () => {
    // The renderer's own open always takes the first surface, so a caller
    // whose tab sits second used to be handed a third pane on every open.
    const router = register();
    rendererWith(['surf-theirs', 'surf-mine']);
    surfaceOpeners.note('surf-theirs', OPENER_A);
    surfaceOpeners.note('surf-mine', OPENER_B);

    const opened = (await dispatch(router, 'browser.open', {
      workspaceId: 'ws-1',
      url: 'https://b.test/',
      openerKey: OPENER_B,
    })) as { surfaceId: string; reused?: boolean };

    expect(opened.surfaceId).toBe('surf-mine');
    expect(opened.reused).toBe(true);
    // Driven directly, because the renderer's open cannot address it.
    expect(rendererCalls()).toEqual(['browser.tabs:list', 'browser.navigate']);
  });

  it('reports a failed navigation of my own pane instead of claiming success', async () => {
    // The pane can be closed between the list and the navigate; answering ok
    // with a url it never loaded would cost the agent a whole flow.
    const router = register();
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'browser.tabs' && params.action === 'list') {
        return {
          ok: true,
          action: 'list',
          tabs: [
            { surfaceId: 'surf-theirs', paneId: 'p1', url: '', title: '', selected: false },
            { surfaceId: 'surf-mine', paneId: 'p2', url: '', title: '', selected: false },
          ],
        };
      }
      if (method === 'browser.navigate') return { error: 'browser.navigate: no browser surface found' };
      return { ok: true };
    });
    surfaceOpeners.note('surf-theirs', OPENER_A);
    surfaceOpeners.note('surf-mine', OPENER_B);

    const result = (await dispatch(router, 'browser.open', {
      workspaceId: 'ws-1',
      url: 'https://b.test/',
      openerKey: OPENER_B,
    })) as { error?: string; surfaceId?: string };

    expect(result.surfaceId).toBeUndefined();
    expect(result.error).toContain('no browser surface found');
  });

  it('fails closed when the tab list cannot be read', async () => {
    // Falling through to a plain open here would navigate whatever pane
    // happens to be first — the exact hijack this guard exists to prevent.
    const router = register();
    let created = 0;
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string) => {
      if (method === 'browser.tabs') {
        if (created++ === 0) throw new Error('RPC timeout: browser.tabs');
        return { ok: true, action: 'new', tab: { surfaceId: 'surf-fresh', paneId: 'p', url: '', title: '', selected: false } };
      }
      return { ok: true, surfaceId: 'surf-first', url: '', reused: true };
    });

    const opened = (await dispatch(router, 'browser.open', {
      workspaceId: 'ws-1',
      openerKey: OPENER_B,
    })) as { surfaceId?: string };

    expect(opened.surfaceId).toBe('surf-fresh');
    expect(rendererCalls()).toEqual(['browser.tabs:list', 'browser.tabs:new']);
  });

  it('never re-stamps ownership onto a surface somebody else already owns', async () => {
    // The list and the open are two round trips; another connection can claim
    // the surface in between. The late stamp must not steal it.
    const router = register();
    rendererWith(['surf-a']);
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string) => {
      if (method === 'browser.tabs') return { ok: true, action: 'list', tabs: [{ surfaceId: 'surf-a', paneId: 'p', url: '', title: '', selected: false }] };
      // Between the list and this reply, A claimed the surface.
      surfaceOpeners.note('surf-a', OPENER_A);
      return { ok: true, surfaceId: 'surf-a', url: '', reused: true };
    });

    await dispatch(router, 'browser.open', { workspaceId: 'ws-1', openerKey: OPENER_B });

    expect(surfaceOpeners.get('surf-a')).toBe(OPENER_A);
  });
});

describe('browser.surface.adopt', () => {
  it('claims an unowned surface, and refuses to transfer an owned one', async () => {
    const router = register();
    rendererWith(['surf-restored']);

    const first = await dispatch(router, 'browser.surface.adopt', {
      workspaceId: 'ws-1',
      surfaceId: 'surf-restored',
      openerKey: OPENER_A,
    });
    const second = await dispatch(router, 'browser.surface.adopt', {
      workspaceId: 'ws-1',
      surfaceId: 'surf-restored',
      openerKey: OPENER_B,
    });

    expect(first).toEqual({ ok: true, owner: 'mine' });
    // First claim wins: an adoption is a claim on something free, never a
    // transfer, so B is told the surface is taken and opens its own.
    expect(second).toEqual({ ok: true, owner: 'other' });
    expect(surfaceOpeners.get('surf-restored')).toBe(OPENER_A);
  });

  it('requires all three arguments', async () => {
    const router = register();
    const result = (await dispatch(router, 'browser.surface.adopt', {
      workspaceId: 'ws-1',
      openerKey: OPENER_A,
    })) as { error?: string };
    expect(result.error).toContain('surfaceId');
  });
});
