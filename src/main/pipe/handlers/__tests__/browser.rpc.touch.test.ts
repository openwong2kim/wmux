import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import type { RpcMethod } from '../../../../shared/rpc';
import { registerBrowserRpc } from '../browser.rpc';

// The packaged lane's half of touch dispatch. A device preset here installs the
// touch emulation over `webContents.debugger`, so the input that follows has to
// go out on the same channel as touch — otherwise the page reports five touch
// points and receives mouse events, which is exactly the contradiction the
// preset exists to remove.

const sent: Array<{ method: string; params: Record<string, unknown> }> = [];

const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  getUserAgent: vi.fn(() => 'real-ua'),
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
  debugger: {
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params: params ?? {} });
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        // pointIsOnTarget asks whether the point still hits the element;
        // elementCenter asks where the element is.
        if (expression.includes('elementFromPoint')) return { result: { value: true } };
        return { result: { value: { x: 120, y: 240 } } };
      }
      return {};
    }),
    isAttached: vi.fn(() => true),
    attach: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
};

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => mockWebContents) },
}));
vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: vi.fn(async () => ({ valid: true })),
}));
vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn(async () => ({ ok: true })) }));

const TARGET = { surfaceId: 'surface-own', targetId: 'T-own', webContentsId: 7, workspaceId: 'ws-a' };

function register() {
  const cdp = {
    getTarget: vi.fn(() => TARGET),
    ensureAwake: vi.fn(async () => null),
    listTargets: vi.fn(() => [TARGET]),
    getCdpPort: vi.fn(() => 18800),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn((sid: string) => `lease-${sid}`),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  const router = new RpcRouter();
  registerBrowserRpc(router, () => null as unknown as BrowserWindow, cdp as never);
  return router;
}

async function call(
  router: RpcRouter,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await router.dispatch({
    id: `c-${method}`,
    method: method as RpcMethod,
    params: { ...params, workspaceId: 'ws-a' },
  });
  if (!response.ok) throw new Error(`${method} failed: ${response.error}`);
  return (response.result ?? {}) as Record<string, unknown>;
}

async function emulate(router: RpcRouter, hasTouch: boolean): Promise<void> {
  await call(router, 'browser.emulate', {
    deviceMetrics: { width: 412, height: 915, deviceScaleFactor: 3, mobile: true, hasTouch },
    deviceLabel: 'Pixel 7 (412x915)',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/140.0.0.0 Mobile Safari/537.36',
  });
  sent.length = 0;
}

const types = (method: string): string[] =>
  sent.filter((s) => s.method === method).map((s) => String(s.params.type));

describe('browser.click.cdp under a touchscreen preset', () => {
  beforeEach(() => {
    sent.length = 0;
    vi.clearAllMocks();
  });

  it('dispatches a touch tap and no mouse event', async () => {
    const router = register();
    await emulate(router, true);

    const res = await call(router, 'browser.click.cdp', { selector: '[data-wmux-ref="3"]' });

    expect(res.dispatch).toBe('touch');
    expect(types('Input.dispatchTouchEvent')).toEqual(['touchStart', 'touchEnd']);
    expect(sent.some((s) => s.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('leaves the mouse path alone when the preset has no touchscreen', async () => {
    const router = register();
    await emulate(router, false);

    const res = await call(router, 'browser.click.cdp', { selector: '[data-wmux-ref="3"]' });

    expect(res.dispatch).toBe('mouse');
    expect(sent.some((s) => s.method === 'Input.dispatchTouchEvent')).toBe(false);
    expect(types('Input.dispatchMouseEvent')).toContain('mousePressed');
    expect(types('Input.dispatchMouseEvent')).toContain('mouseReleased');
  });

  it('drags with one finger: press, moves, lift', async () => {
    const router = register();
    await emulate(router, true);

    const res = await call(router, 'browser.drag.cdp', {
      sourceSelector: '[data-wmux-ref="3"]',
      targetSelector: '[data-wmux-ref="4"]',
    });

    expect(res.dispatch).toBe('touch');
    const touch = types('Input.dispatchTouchEvent');
    expect(touch[0]).toBe('touchStart');
    expect(touch[touch.length - 1]).toBe('touchEnd');
    expect(sent.some((s) => s.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('still hovers with the mouse, and says the device could not', async () => {
    const router = register();
    await emulate(router, true);

    const res = await call(router, 'browser.hover.cdp', { selector: '[data-wmux-ref="3"]' });

    // A touchscreen cannot hover, but refusing would turn every hover-gated
    // menu into a silent failure. The move goes out; the caller is told.
    expect(res.touchPreset).toBe(true);
    expect(types('Input.dispatchMouseEvent')).toContain('mouseMoved');
  });
});
