import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import type { RpcMethod } from '../../../../shared/rpc';
import { registerBrowserRpc } from '../browser.rpc';
import { dispatchAsClaimedCaller } from './claimedCaller';

// browser.screenshot with a selector: one element, cropped to its box, over the
// guest's own debugger. The property every case below protects is that a crop
// either comes back cropped or fails; it never widens to the viewport.

const BOX = { x: 10, y: 20, width: 30, height: 40, scrollX: 0, scrollY: 500, vw: 800, vh: 600 };

let box: Record<string, unknown> | null = BOX;
let capture: () => Promise<unknown> = async () => ({ data: 'clip-png' });
const sent: Array<{ method: string; params: Record<string, unknown> }> = [];

const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  getUserAgent: vi.fn(() => 'real-ua'),
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
  capturePage: vi.fn(),
  debugger: {
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params: params ?? {} });
      if (method === 'Runtime.evaluate') {
        if (String(params?.expression ?? '').includes('getBoundingClientRect')) return { result: { value: box } };
        // The preset's before/after probes.
        return { result: { value: { w: 390, h: 426, dpr: 1, touch: 0 } } };
      }
      if (method === 'Page.captureScreenshot') return capture();
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
  nativeImage: { createFromBuffer: vi.fn() },
}));
vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: vi.fn(async () => ({ valid: true })),
}));
vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn(async () => ({ ok: true })) }));

const TARGET = { surfaceId: 'surface-own', targetId: 'T-own', webContentsId: 7, workspaceId: 'ws-a' };

function register(): RpcRouter {
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
  const router = dispatchAsClaimedCaller(new RpcRouter());
  registerBrowserRpc(router, () => null as unknown as BrowserWindow, cdp as never);
  return router;
}

async function shoot(router: RpcRouter, params: Record<string, unknown>) {
  const p = router.dispatch({
    id: 'shot',
    method: 'browser.screenshot' as RpcMethod,
    params: { ...params, workspaceId: 'ws-a' },
  });
  // Past both bounds: the 2.5 s CDP wait and the 1.5 s capturePage wait.
  await vi.advanceTimersByTimeAsync(5000);
  return p;
}

const hangs = () => new Promise<never>(() => undefined);
const image = (png: string) => ({ isEmpty: () => false, toPNG: () => Buffer.from(png) });

describe('browser.screenshot with a selector (element capture over RPC)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    vi.clearAllMocks();
    box = BOX;
    capture = async () => ({ data: 'clip-png' });
    mockWebContents.capturePage.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('crops the CDP capture to the element, in document coordinates', async () => {
    const res = await shoot(register(), { selector: '[data-wmux-ref="3"]' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ data: 'clip-png' });
    const shot = sent.find((s) => s.method === 'Page.captureScreenshot');
    expect(shot?.params).toMatchObject({
      clip: { x: 10, y: 520, width: 30, height: 40, scale: 1 },
      captureBeyondViewport: true,
    });
    expect(mockWebContents.capturePage).not.toHaveBeenCalled();
  });

  it('a hung CDP capture falls back to capturePage cropped to the element, never the viewport', async () => {
    capture = hangs;
    mockWebContents.capturePage.mockImplementation(async () => image('cropped'));

    const res = await shoot(register(), { selector: '[data-wmux-ref="3"]' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ data: Buffer.from('cropped').toString('base64') });
    expect(mockWebContents.capturePage).toHaveBeenCalledTimes(1);
    expect(mockWebContents.capturePage).toHaveBeenCalledWith({ x: 10, y: 20, width: 30, height: 40 });
  });

  it('refuses the fallback for an element that is not wholly on screen', async () => {
    capture = hangs;
    box = { ...BOX, y: 580 }; // runs past the 600 px viewport
    mockWebContents.capturePage.mockImplementation(async () => image('viewport'));

    const res = await shoot(register(), { selector: '[data-wmux-ref="3"]' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(String(res.error)).toContain('does not fit on screen');
    expect(mockWebContents.capturePage).not.toHaveBeenCalled();
  });

  it('a hidden guest (both captures hang) fails instead of answering', async () => {
    capture = hangs;
    mockWebContents.capturePage.mockImplementation(hangs);

    const res = await shoot(register(), { selector: '[data-wmux-ref="3"]' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(String(res.error)).toContain('not producing frames');
    for (const call of mockWebContents.capturePage.mock.calls) expect(call[0]).toBeDefined();
  });

  it('scales the fallback crop by an active device preset, like input points', async () => {
    const router = register();
    const emulated = router.dispatch({
      id: 'emu',
      method: 'browser.emulate' as RpcMethod,
      params: {
        workspaceId: 'ws-a',
        deviceMetrics: { width: 390, height: 426, deviceScaleFactor: 1, mobile: true, scale: 2, fill: true },
      },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await emulated).ok).toBe(true);
    capture = hangs;
    mockWebContents.capturePage.mockImplementation(async () => image('scaled'));

    const res = await shoot(router, { selector: '[data-wmux-ref="3"]' });

    expect(res.ok).toBe(true);
    expect(mockWebContents.capturePage).toHaveBeenCalledWith({ x: 20, y: 40, width: 60, height: 80 });
  });

  it('an unresolvable ref errors and captures nothing', async () => {
    box = { missing: true };

    const res = await shoot(register(), { selector: '[data-wmux-ref="99"]' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(String(res.error)).toContain('no element matches [data-wmux-ref="99"]');
    expect(sent.some((s) => s.method === 'Page.captureScreenshot')).toBe(false);
    expect(mockWebContents.capturePage).not.toHaveBeenCalled();
  });

  it('refuses a selector combined with fullPage', async () => {
    const res = await shoot(register(), { selector: '#a', fullPage: true });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(String(res.error)).toContain('cannot be combined');
    expect(sent.some((s) => s.method === 'Page.captureScreenshot')).toBe(false);
  });
});
