import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import { dispatchAsClaimedCaller } from './claimedCaller';

// On `chrome` the help request's OS toast is the only signal in front of the
// human. Electron 42 reports a toast it could not show as a `failed` event, so
// the listener has to be on before `show()` or that event goes nowhere. The
// fake Notification is a real EventEmitter and records the order of `on` and
// `show`.
const { toasts, gate } = vi.hoisted(() => ({
  toasts: [] as Array<{ steps: string[]; emitter: unknown }>,
  // #2964: an isolated packaged copy on Windows raises no OS toast at all.
  gate: { allowed: true, isSupported: 0 },
}));
vi.mock('../../../notification/osToastGate', () => ({ osToastsAllowed: () => gate.allowed }));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Notification extends Emitter {
    static isSupported = () => {
      gate.isSupported += 1;
      return true;
    };
    readonly steps: string[] = [];
    constructor(readonly options: unknown) {
      super();
      toasts.push({ steps: this.steps, emitter: this });
    }
    override on(event: string, listener: (...args: unknown[]) => void): this {
      this.steps.push(`on:${event}`);
      return super.on(event, listener);
    }
    show(): void {
      this.steps.push('show');
    }
  }
  return { Notification, webContents: { fromId: vi.fn(() => null) } };
});
vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: vi.fn(async () => ({ valid: true })),
}));
vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn(async () => ({ ok: true })) }));

function register(): RpcRouter {
  const router = dispatchAsClaimedCaller(new RpcRouter());
  const cdp = {
    getTarget: vi.fn(() => null),
    listTargets: vi.fn(() => []),
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
  registerBrowserRpc(router, () => null as unknown as BrowserWindow, cdp as never, { get: () => 'chrome' } as never);
  return router;
}

describe('browser.help.request OS toast', () => {
  afterEach(() => {
    toasts.length = 0;
    gate.allowed = true;
    gate.isSupported = 0;
    vi.restoreAllMocks();
  });

  it('attaches the failed listener before show(), so a toast the OS refuses is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const router = register();

    const response = await router.dispatch({
      id: '1',
      method: 'browser.help.request',
      params: { workspaceId: 'ws-1', prompt: 'Solve the captcha' },
    });
    expect(response.ok).toBe(true);

    expect(toasts).toHaveLength(1);
    expect(toasts[0].steps).toEqual(['on:failed', 'show']);

    (toasts[0].emitter as EventEmitter).emit('failed', {}, 'Notifications are not allowed');
    expect(warn).toHaveBeenCalledWith(
      '[browser.help.request] OS notification failed to show:',
      'Notifications are not allowed',
    );

    const requestId = (response as { result?: { requestId?: string } }).result?.requestId;
    await router.dispatch({ id: '2', method: 'browser.help.cancel', params: { workspaceId: 'ws-1', requestId } });
  });

  it('an isolated packaged copy never reaches Notification, isSupported() included (#2964)', async () => {
    gate.allowed = false;
    const router = register();

    const response = await router.dispatch({
      id: '1',
      method: 'browser.help.request',
      params: { workspaceId: 'ws-1', prompt: 'Solve the captcha' },
    });
    expect(response.ok).toBe(true);
    expect(toasts).toHaveLength(0);
    expect(gate.isSupported).toBe(0);

    const requestId = (response as { result?: { requestId?: string } }).result?.requestId;
    await router.dispatch({ id: '2', method: 'browser.help.cancel', params: { workspaceId: 'ws-1', requestId } });
  });
});
