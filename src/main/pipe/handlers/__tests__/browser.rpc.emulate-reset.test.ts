import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import type { RpcMethod } from '../../../../shared/rpc';
import { registerBrowserRpc } from '../browser.rpc';
import { dispatchAsClaimedCaller } from './claimedCaller';

// #1357: `device: null` on the packaged lane used to clear the metrics override
// and stop there — the viewport stayed at the phone's width, the page was never
// re-evaluated, and a refused touch disable was swallowed without a word.

const sent: Array<{ method: string; params: Record<string, unknown> }> = [];

/** What the emulated page answers the probe with, per call. */
let probeValues: Array<{ w: number; h: number; dpr: number; touch: number }> = [];
let touchFails = false;

const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  getUserAgent: vi.fn(() => 'real-ua'),
  reload: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
  debugger: {
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params: params ?? {} });
      if (method === 'Emulation.setTouchEmulationEnabled' && touchFails) {
        throw new Error('touch emulation unsupported');
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: probeValues.shift() ?? { w: 0, h: 0, dpr: 1, touch: 0 } } };
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

async function call(
  router: RpcRouter,
  params: Record<string, unknown>,
): Promise<{ applied: string[] }> {
  const response = await router.dispatch({
    id: 'c-emulate',
    method: 'browser.emulate' as RpcMethod,
    params: { ...params, workspaceId: 'ws-a' },
  });
  if (!response.ok) throw new Error(`browser.emulate failed: ${response.error}`);
  return response.result as unknown as { applied: string[] };
}

const PRESET = {
  deviceMetrics: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, hasTouch: true },
  deviceLabel: 'iPhone 13 (390x844)',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
};

const commands = (): string[] => sent.map((s) => s.method);

describe('browser.emulate device reset (packaged CDP lane)', () => {
  beforeEach(() => {
    sent.length = 0;
    probeValues = [];
    touchFails = false;
    vi.clearAllMocks();
  });

  it('restores the pre-preset viewport, disables touch and reloads', async () => {
    const router = register();
    // Probe order: before the preset, after the preset, after the reset.
    probeValues = [
      { w: 1280, h: 720, dpr: 1, touch: 0 },
      { w: 390, h: 844, dpr: 3, touch: 5 },
      { w: 1280, h: 720, dpr: 1, touch: 0 },
    ];
    await call(router, PRESET);
    sent.length = 0;

    const res = await call(router, { deviceReset: true });

    expect(commands()).toContain('Emulation.clearDeviceMetricsOverride');
    const touch = sent.find((s) => s.method === 'Emulation.setTouchEmulationEnabled');
    // maxTouchPoints must be absent, not 0: CDP refuses 0 and the catch below
    // would turn that refusal into a silent no-op (#1357).
    expect(touch?.params).toEqual({ enabled: false });
    const restore = sent.find((s) => s.method === 'Emulation.setDeviceMetricsOverride');
    expect(restore?.params).toMatchObject({ width: 1280, height: 720, mobile: false });
    expect(mockWebContents.reload).toHaveBeenCalledTimes(1);
    expect(res.applied).toContain('device=reset (viewport 1280x720 restored, reloaded)');
    expect(res.applied).toContain('probe=1280x720 dpr=1 maxTouchPoints=0');
    expect(res.applied).not.toContain('touch=could not be disabled');
  });

  it('reports a refused touch disable instead of swallowing it', async () => {
    const router = register();
    probeValues = [
      { w: 1280, h: 720, dpr: 1, touch: 0 },
      { w: 390, h: 844, dpr: 3, touch: 5 },
      { w: 1280, h: 720, dpr: 1, touch: 5 },
    ];
    await call(router, PRESET);
    touchFails = true;

    const res = await call(router, { deviceReset: true });

    expect(res.applied).toContain('touch=could not be disabled');
    expect(res.applied).toContain('probe=1280x720 dpr=1 maxTouchPoints=5');
  });

  it('says so when there is no pre-preset viewport to restore', async () => {
    const router = register();
    probeValues = [{ w: 0, h: 0, dpr: 1, touch: 0 }];

    const res = await call(router, { deviceReset: true });

    expect(res.applied).toContain(
      'device=reset (viewport from surface bounds (no pre-preset viewport recorded), reloaded)',
    );
    expect(sent.some((s) => s.method === 'Emulation.setDeviceMetricsOverride')).toBe(false);
  });

  it('probes the page after a preset is applied too', async () => {
    const router = register();
    probeValues = [
      { w: 1280, h: 720, dpr: 1, touch: 0 },
      { w: 390, h: 844, dpr: 3, touch: 5 },
    ];

    const res = await call(router, PRESET);

    expect(res.applied).toContain('probe=390x844 dpr=3 maxTouchPoints=5');
  });
});
