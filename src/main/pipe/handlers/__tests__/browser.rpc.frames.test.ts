// The builtin lane's in-process frames (frameId on browser.evaluate and
// browser.click.cdp, and browser.frames.tree), through the real handler chain
// with a fake guest debugger. The frame logic itself runs against real Chrome
// in browser-session/__tests__/frameAccess.chrome.runtime.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
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
