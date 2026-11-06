// The builtin lane's in-process frames (frameId on browser.evaluate and
// browser.click.cdp, and browser.frames.tree), through the real handler chain
// with a fake guest debugger. The frame logic itself runs against real Chrome
// in browser-session/__tests__/frameAccess.chrome.runtime.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { FRAMES_READ_DEADLINE_MS, registerBrowserRpc } from '../browser.rpc';
import { METHOD_CAPABILITY } from '../../../mcp/methodCapabilityMap';
import { dispatchAsClaimedCaller } from './claimedCaller';

const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
  debugger: {
    sendCommand: vi.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({})),
    isAttached: vi.fn(() => true),
    attach: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
};

vi.mock('electron', () => ({ webContents: { fromId: vi.fn(() => mockWebContents) } }));
vi.mock('../../../security/navigationPolicy', () => ({ validateResolvedNavigationUrl: vi.fn(async () => ({ valid: true })) }));
vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn(async () => ({ ok: true })) }));
describe('in-process frames on the builtin lane (frameId)', () => {
  function register(enforcementMode: 'shadow' | 'enforce' = 'shadow'): RpcRouter {
    const router = dispatchAsClaimedCaller(new RpcRouter());
    const webviewCdpManager = {
      getTarget: vi.fn(() => ({ surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1' })),
      listTargets: vi.fn(() => []),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      setCaptureAttach: vi.fn(),
      withAutomationLease: vi.fn(async (_surfaceId: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };
    registerBrowserRpc(router, () => null, webviewCdpManager as never, undefined, vi.fn(), () => enforcementMode);
    (router as unknown as { __cdp: typeof webviewCdpManager }).__cdp = webviewCdpManager;
    return router;
  }

  const TREE = {
    frameTree: {
      frame: { id: 'MAIN', loaderId: 'LM', url: 'https://top.test/' },
      childFrames: [{ frame: { id: 'F1', loaderId: 'L1', parentId: 'MAIN', url: 'https://pay.test/card?token=x', name: 'card' } }],
    },
  };

  /** A debugger that answers the frame calls and records every command. */
  function cdpAnswering(answers: Record<string, (params: Record<string, unknown>) => unknown>) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    mockWebContents.debugger.sendCommand.mockImplementation((async (method: string, params: Record<string, unknown> = {}) => {
      calls.push([method, params]);
      const answer = answers[method];
      if (!answer) return {};
      return answer(params);
    }) as never);
    return calls;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebContents.isDestroyed.mockReturnValue(false);
  });

  afterEach(() => {
    mockWebContents.debugger.sendCommand.mockReset();
    mockWebContents.debugger.sendCommand.mockImplementation((async () => ({})) as never);
    delete (mockWebContents as Record<string, unknown>)['executeJavaScript'];
  });

  it('refuses a frame read from an unscoped caller exactly as a top-document one', async () => {
    const router = register('enforce');
    const response = await router.dispatch({
      id: 'scope-enforce-evaluate-frame',
      method: 'browser.evaluate',
      params: { expression: '1 + 1', frameId: 'F1', loaderId: 'L1' },
      clientName: 'approved-plugin',
    }, { externalWire: true });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('BROWSER_SCOPE_REFUSED');
    expect((router as unknown as { __cdp: { getTarget: ReturnType<typeof vi.fn> } }).__cdp.getTarget).not.toHaveBeenCalled();
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('lists child frames with their origin only', async () => {
    cdpAnswering({ 'Page.getFrameTree': () => TREE });
    const res = await register().dispatch({ id: 't', method: 'browser.frames.tree', params: {} });
    expect(res).toMatchObject({ ok: true, result: { frames: [{ frameId: 'F1', loaderId: 'L1', parentId: 'MAIN', depth: 1, origin: 'https://pay.test/…', name: 'card' }] } });
  });

  it('reads a frame in its own isolated world and never falls back to the top document', async () => {
    const executeJavaScript = vi.fn(async () => 'TOP');
    (mockWebContents as Record<string, unknown>)['executeJavaScript'] = executeJavaScript;
    const calls = cdpAnswering({
      'Page.getFrameTree': () => TREE,
      'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
      'Runtime.evaluate': () => ({ result: { value: 'in-frame' } }),
    });
    const router = register();
    const ok = await router.dispatch({ id: 'e1', method: 'browser.evaluate', params: { expression: 'x', frameId: 'F1', loaderId: 'L1' } });
    expect(ok).toMatchObject({ ok: true, result: { value: 'in-frame' } });
    expect(calls).toContainEqual(['Runtime.evaluate', expect.objectContaining({ contextId: 9, expression: 'x' })]);

    cdpAnswering({
      'Page.getFrameTree': () => TREE,
      'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
      'Runtime.evaluate': () => { throw new Error('boom'); },
    });
    const failed = await router.dispatch({ id: 'e2', method: 'browser.evaluate', params: { expression: 'x', frameId: 'F1' } });
    expect(failed.ok).toBe(false);
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it('refuses a frame that navigated, and answers unreachable for one in another process', async () => {
    cdpAnswering({ 'Page.getFrameTree': () => TREE });
    const router = register();
    const moved = await router.dispatch({ id: 'n', method: 'browser.evaluate', params: { expression: 'x', frameId: 'F1', loaderId: 'OLD' } });
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error).toMatch(/FRAME_NAVIGATED/);
    // A document no earlier case read, so no world is cached for it.
    const elsewhere = { frameTree: { ...TREE.frameTree, childFrames: [{ frame: { ...TREE.frameTree.childFrames[0].frame, loaderId: 'L-OOP' } }] } };
    cdpAnswering({
      'Page.getFrameTree': () => elsewhere,
      'Page.createIsolatedWorld': () => { throw new Error('No frame for given id found'); },
    });
    const far = await router.dispatch({ id: 'u', method: 'browser.evaluate', params: { expression: 'x', frameId: 'F1' } });
    expect(far).toMatchObject({ ok: true, result: { unreachable: expect.stringContaining('separate process') } });
  });

  it('never presses in a frame when the point is not on the target', async () => {
    const calls = cdpAnswering({
      'Page.getFrameTree': () => TREE,
      'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-target' } }),
      'DOM.getContentQuads': () => ({ quads: [[10, 10, 50, 10, 50, 30, 10, 30]] }),
      'Page.getLayoutMetrics': () => ({ cssVisualViewport: { pageX: 0, pageY: 0 } }),
      // Something in ANOTHER frame is at the point.
      'DOM.getNodeForLocation': () => ({ backendNodeId: 5, frameId: 'MAIN' }),
    });
    const res = await register().dispatch({
      id: 'c',
      method: 'browser.click.cdp',
      params: { selector: '[data-wmux-ref="3"]', frameId: 'F1', loaderId: 'L1' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Refusing to click what is there instead/);
    expect(calls.some(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mousePressed')).toBe(false);
    expect(calls.some(([m]) => m === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('presses at the checked point when the hit is the target', async () => {
    const calls = cdpAnswering({
      'Page.getFrameTree': () => TREE,
      'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-target' } }),
      'DOM.getContentQuads': () => ({ quads: [[10, 10, 50, 10, 50, 30, 10, 30]] }),
      'Page.getLayoutMetrics': () => ({ cssVisualViewport: { pageX: 0, pageY: 100 } }),
      'DOM.getNodeForLocation': () => ({ backendNodeId: 5, frameId: 'F1' }),
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-hit' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: true } }),
    });
    const res = await register().dispatch({
      id: 'c2',
      method: 'browser.click.cdp',
      params: { selector: '[data-wmux-ref="3"]', frameId: 'F1', loaderId: 'L1' },
    });
    expect(res).toMatchObject({ ok: true, result: { x: 30, y: 20, dispatch: 'mouse' } });
    // Hit-tested in top-document coordinates: the top scroll is added.
    expect(calls).toContainEqual(['DOM.getNodeForLocation', expect.objectContaining({ x: 30, y: 120 })]);
    expect(calls).toContainEqual(['Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 30, y: 20 })]);
  });

  it('refuses an empty loaderId rather than dropping the document check', async () => {
    const calls = cdpAnswering({ 'Page.getFrameTree': () => TREE });
    const router = register();
    for (const method of ['browser.evaluate', 'browser.click.cdp'] as const) {
      const res = await router.dispatch({
        id: `empty-${method}`,
        method,
        params: { expression: 'x', selector: '#a', frameId: 'F1', loaderId: '' },
      });
      expect(res.ok, method).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/loaderId/);
    }
    expect(calls).toEqual([]);
  });

  it('wants a selector with a frame', async () => {
    cdpAnswering({});
    const res = await register().dispatch({ id: 'c3', method: 'browser.click.cdp', params: { frameId: 'F1', x: 1, y: 1 } });
    expect(res.ok).toBe(false);
  });
});

describe('browser.frames.read — every frame listing in one call', () => {
  function register(enforcementMode: 'shadow' | 'enforce' = 'shadow'): RpcRouter {
    const router = dispatchAsClaimedCaller(new RpcRouter());
    const webviewCdpManager = {
      getTarget: vi.fn(() => ({ surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1' })),
      listTargets: vi.fn(() => []),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      setCaptureAttach: vi.fn(),
      withAutomationLease: vi.fn(async (_surfaceId: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };
    registerBrowserRpc(router, () => null, webviewCdpManager as never, undefined, vi.fn(), () => enforcementMode);
    return router;
  }

  // Two frames, each document named by a loaderId no other case uses (worlds are cached per document).
  const TWO = {
    frameTree: {
      frame: { id: 'MAIN', loaderId: 'LM', url: 'https://top.test/' },
      childFrames: [
        { frame: { id: 'R1', loaderId: 'RL1', parentId: 'MAIN', url: 'https://top.test/a' } },
        { frame: { id: 'R2', loaderId: 'RL2', parentId: 'MAIN', url: 'https://pay.test/b' } },
        { frame: { id: 'R3', loaderId: 'RL3', parentId: 'MAIN', url: 'https://pay.test/c' } },
      ],
    },
  };

  /** A guest whose frames answer a listing of `count` buttons numbered from the seed in the expression. */
  function guestListing(count: number) {
    const evaluated: Array<{ contextId: unknown; expression: string }> = [];
    let world = 20;
    mockWebContents.debugger.sendCommand.mockImplementation((async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') return TWO;
      if (method === 'Page.createIsolatedWorld') return { executionContextId: ++world };
      if (method === 'Runtime.evaluate') {
        const expression = String(params['expression']);
        evaluated.push({ contextId: params['contextId'], expression });
        const seed = Number(/const frameSeed = (\d+);/.exec(expression)?.[1]);
        const entries = Array.from({ length: count }, (_, i) => ({ ref: seed + i, role: 'button', name: `B${i}` }));
        return { result: { value: { text: entries.map((e) => `[ref=${e.ref}] button "${e.name}"`).join('\n'), entries } } };
      }
      return {};
    }) as never);
    return evaluated;
  }

  const frames = [{ frameId: 'R1', loaderId: 'RL1' }, { frameId: 'R2', loaderId: 'RL2' }];

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebContents.isDestroyed.mockReturnValue(false);
  });

  it('lists each frame in its own world with the listing main builds, numbering on frame after frame', async () => {
    const executeJavaScript = vi.fn(async () => 'TOP');
    (mockWebContents as Record<string, unknown>)['executeJavaScript'] = executeJavaScript;
    const evaluated = guestListing(3);
    const res = await register().dispatch({
      id: 'r1',
      method: 'browser.frames.read',
      params: { frames: [{ ...frames[0], prior: [{ ref: 4, role: 'button', name: 'B0', kindIndex: 0 }] }, frames[1]], seed: 10, filter: 'interactive' },
    });
    expect(res).toMatchObject({ ok: true, result: { nextRef: 16, frames: [{ value: { entries: expect.any(Array) } }, { value: expect.any(Object) }] } });
    expect(evaluated.map((e) => e.contextId)).toEqual([21, 22]);
    // Main's frame-mode listing: the seed carried from frame to frame, the prior as data, the filter applied.
    expect(evaluated[0].expression).toContain('const frameSeed = 10;');
    expect(evaluated[0].expression).toContain('const framePrior = [{"ref":4,"role":"button","name":"B0","kindIndex":0}];');
    expect(evaluated[1].expression).toContain('const frameSeed = 13;');
    expect(evaluated[0].expression).toContain('const interactiveOnly = true;');
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it('runs no caller code: an expression is refused, at the top or on a frame', async () => {
    const evaluated = guestListing(1);
    const router = register();
    for (const params of [
      { frames, seed: 1, expression: 'document.cookie' },
      { frames: [{ ...frames[0], expression: 'document.cookie' }], seed: 1 },
    ]) {
      const res = await router.dispatch({ id: 'x', method: 'browser.frames.read', params });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/expression/);
    }
    // A prior entry is data with a fixed shape, never text spliced into the listing.
    const smuggled = await router.dispatch({
      id: 'p',
      method: 'browser.frames.read',
      params: { frames: [{ ...frames[0], prior: [{ ref: '1]; fetch("x"); [', role: 'b', name: 'n', kindIndex: 0 }] }], seed: 1 },
    });
    expect(smuggled.ok).toBe(false);
    expect(evaluated).toEqual([]);
  });

  it('refuses more than 20 frames, a missing loaderId and a bad seed before touching the guest', async () => {
    const evaluated = guestListing(1);
    const router = register();
    for (const params of [
      { frames: Array.from({ length: 21 }, (_, i) => ({ frameId: `F${i}`, loaderId: `L${i}` })), seed: 1 },
      { frames: [{ frameId: 'R1' }], seed: 1 },
      { frames: [{ frameId: 'R1', loaderId: '' }], seed: 1 },
      { frames, seed: -1 },
      { frames, seed: 1, filter: 'all' },
      { frames: [], seed: 1 },
    ]) {
      const res = await router.dispatch({ id: 'b', method: 'browser.frames.read', params });
      expect(res.ok, JSON.stringify(params).slice(0, 60)).toBe(false);
    }
    expect(evaluated).toEqual([]);
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('answers gone, unreachable or failed per frame, with no error text', async () => {
    let world = 40;
    mockWebContents.debugger.sendCommand.mockImplementation((async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'MAIN', loaderId: 'LM', url: 'https://top.test/' },
            childFrames: [
              { frame: { id: 'G1', loaderId: 'GL1-NOW', parentId: 'MAIN', url: 'https://top.test/' } },
              { frame: { id: 'G2', loaderId: 'GL2', parentId: 'MAIN', url: 'https://top.test/' } },
              { frame: { id: 'G3', loaderId: 'GL3', parentId: 'MAIN', url: 'https://top.test/' } },
            ],
          },
        };
      }
      if (method === 'Page.createIsolatedWorld') {
        if (params['frameId'] === 'G2') throw new Error('No frame for given id found');
        return { executionContextId: ++world };
      }
      if (method === 'Runtime.evaluate') {
        return { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: secret page text' } } };
      }
      return {};
    }) as never);
    const res = await register().dispatch({
      id: 'k',
      method: 'browser.frames.read',
      params: { frames: [{ frameId: 'G1', loaderId: 'GL1-OLD' }, { frameId: 'G2', loaderId: 'GL2' }, { frameId: 'G3', loaderId: 'GL3' }], seed: 5 },
    });
    expect(res).toMatchObject({ ok: true, result: { frames: [{ gone: true }, { unreachable: true }, { failed: true }], nextRef: 5 } });
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('stops reading at its deadline, well inside the client timeout, and says which frames it left unread', async () => {
    const evaluated = guestListing(1);
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const impl = mockWebContents.debugger.sendCommand.getMockImplementation() as (m: string, p: Record<string, unknown>) => Promise<unknown>;
    mockWebContents.debugger.sendCommand.mockImplementation((async (method: string, params: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate') now += FRAMES_READ_DEADLINE_MS / 2 + 1;
      return impl(method, params);
    }) as never);
    const res = await register().dispatch({
      id: 'd',
      method: 'browser.frames.read',
      params: { frames: [...frames, { frameId: 'R3', loaderId: 'RL3' }], seed: 1 },
    });
    clock.mockRestore();
    expect(FRAMES_READ_DEADLINE_MS).toBeLessThan(10_000);
    expect(evaluated).toHaveLength(2);
    expect(res).toMatchObject({ ok: true, result: { frames: [{ value: expect.any(Object) }, { value: expect.any(Object) }, { unread: 'time' }] } });
  });

  it('stops when the caller has hung up, so an abandoned snapshot stamps nothing more', async () => {
    const evaluated = guestListing(1);
    const hangUp = new AbortController();
    const impl = mockWebContents.debugger.sendCommand.getMockImplementation() as (m: string, p: Record<string, unknown>) => Promise<unknown>;
    mockWebContents.debugger.sendCommand.mockImplementation((async (method: string, params: Record<string, unknown>) => {
      const out = await impl(method, params);
      if (method === 'Runtime.evaluate') hangUp.abort();
      return out;
    }) as never);
    await register().dispatch(
      { id: 'a', method: 'browser.frames.read', params: { frames, seed: 1 } },
      { operator: true, signal: hangUp.signal },
    );
    expect(evaluated).toHaveLength(1);
  });

  it('reads no further once the listings it read fill the byte budget it was given', async () => {
    const evaluated = guestListing(3);
    const res = await register().dispatch({
      id: 'g',
      method: 'browser.frames.read',
      params: { frames: [...frames, { frameId: 'R3', loaderId: 'RL3' }], seed: 1, budget: 10 },
    });
    expect(evaluated).toHaveLength(1);
    expect(res).toMatchObject({ ok: true, result: { frames: [{ value: expect.any(Object) }, { unread: 'budget' }, { unread: 'budget' }], nextRef: 4 } });
    for (const budget of [0, -1, 1.5, '10']) {
      const bad = await register().dispatch({ id: 'gb', method: 'browser.frames.read', params: { frames, seed: 1, budget } });
      expect(bad.ok, String(budget)).toBe(false);
    }
  });

  it('needs the capability the snapshot listing needs: it rewrites data-wmux-ref in the frames', () => {
    expect(METHOD_CAPABILITY['browser.frames.read'].capability).toBe(METHOD_CAPABILITY['browser.evaluate'].capability);
  });

  it('is held by the same gates as the snapshot read: an unscoped caller is refused', async () => {
    guestListing(1);
    const res = await register('enforce').dispatch({
      id: 's',
      method: 'browser.frames.read',
      params: { frames, seed: 1 },
      clientName: 'approved-plugin',
    }, { externalWire: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('BROWSER_SCOPE_REFUSED');
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();
  });
});
