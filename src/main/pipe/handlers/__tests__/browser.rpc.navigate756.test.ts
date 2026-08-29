import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';

const { validateResolvedNavigationUrlMock } = vi.hoisted(() => ({
  validateResolvedNavigationUrlMock: vi.fn(),
}));
const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));

// A guest that emits like the real one. `did-navigate` is the commit signal
// browser.navigate now returns on, so the fake has to be able to fire it
// independently of loadURL settling — that separation IS the fix under test.
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
const emit = (event: string, ...args: unknown[]): void => {
  for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
};
/**
 * The handler awaits the navigation guard before it subscribes, so firing on a
 * fixed number of microtask ticks races the implementation. Wait for the
 * subscription itself — that is the observable precondition.
 */
async function waitForListener(event: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if ((listeners.get(event)?.size ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`handler never subscribed to "${event}"`);
}
const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  loadURL: vi.fn(),
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    const set = listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
    set.add(fn);
    listeners.set(event, set);
  }),
  off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    listeners.get(event)?.delete(fn);
  }),
  debugger: {
    sendCommand: vi.fn(async () => ({})),
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
  validateResolvedNavigationUrl: validateResolvedNavigationUrlMock,
}));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const TARGET = { surfaceId: 'surface-own', targetId: 'T-own', webContentsId: 7, workspaceId: 'ws-a' };

function register(targets: Array<typeof TARGET>) {
  const cdp = {
    getTarget: vi.fn((surfaceId?: string, ws?: string) => {
      const owns = (t: typeof TARGET): boolean => !ws || t.workspaceId === ws;
      if (surfaceId) {
        const t = targets.find((x) => x.surfaceId === surfaceId);
        return t && owns(t) ? t : null;
      }
      return targets.find(owns) ?? null;
    }),
    ensureAwake: vi.fn(async () => null),
    listTargets: vi.fn(() => targets),
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
  return { router, cdp };
}

describe('browser.navigate returns on commit (#756)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    mockWebContents.isDestroyed.mockReturnValue(false);
    sendToRendererMock.mockResolvedValue({ ok: true });
    validateResolvedNavigationUrlMock.mockResolvedValue({ valid: true });
  });

  it('resolves when the guest commits, without waiting for the full load', async () => {
    // The bug: loadURL() settles only on FULL load, which is unbounded, so a
    // slow page blew the caller's deadline and reported a transport timeout
    // for a navigation that was actually fine. Here loadURL never settles —
    // exactly that hostile case — and the call must still answer on commit.
    mockWebContents.loadURL.mockImplementation(() => new Promise(() => { /* never */ }));
    const { router } = register([TARGET]);

    const pending = router.dispatch({
      id: 'c1',
      method: 'browser.navigate',
      params: { url: 'https://slow.example', workspaceId: 'ws-a' },
    });

    let settled = false;
    void pending.then(() => { settled = true; });
    await waitForListener('did-navigate');
    expect(settled).toBe(false); // nothing has committed yet

    emit('did-navigate');
    const response = await pending;

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).not.toHaveBeenCalled(); // stayed on the CDP path
  });

  it('reports a main-frame navigation failure instead of hanging', async () => {
    mockWebContents.loadURL.mockImplementation(() => new Promise(() => { /* never */ }));
    const { router } = register([TARGET]);

    const pending = router.dispatch({
      id: 'c2',
      method: 'browser.navigate',
      params: { url: 'https://dead.example', workspaceId: 'ws-a' },
    });
    await waitForListener('did-fail-load');
    emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://dead.example', true);

    const response = await pending;
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('ERR_NAME_NOT_RESOLVED');
  });

  it('ignores a superseded navigation (ERR_ABORTED) rather than calling it a failure', async () => {
    mockWebContents.loadURL.mockImplementation(() => new Promise(() => { /* never */ }));
    const { router } = register([TARGET]);

    const pending = router.dispatch({
      id: 'c3',
      method: 'browser.navigate',
      params: { url: 'https://redirects.example', workspaceId: 'ws-a' },
    });
    await waitForListener('did-fail-load');
    // A redirect/superseding navigation surfaces as ERR_ABORTED on the frame
    // we started; the request was still issued, so it must not fail the call.
    emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://redirects.example', true);
    emit('did-navigate');

    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('ignores a subframe failure', async () => {
    mockWebContents.loadURL.mockImplementation(() => new Promise(() => { /* never */ }));
    const { router } = register([TARGET]);

    const pending = router.dispatch({
      id: 'c4',
      method: 'browser.navigate',
      params: { url: 'https://ads.example', workspaceId: 'ws-a' },
    });
    await waitForListener('did-fail-load');
    emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://tracker.example', false);
    emit('did-navigate');

    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('detaches its listeners once settled', async () => {
    mockWebContents.loadURL.mockResolvedValue(undefined);
    const { router } = register([TARGET]);

    await router.dispatch({
      id: 'c5',
      method: 'browser.navigate',
      params: { url: 'https://ok.example', workspaceId: 'ws-a' },
    });

    // A navigate per tool call would otherwise accumulate listeners on a
    // long-lived guest.
    expect(listeners.get('did-navigate')?.size ?? 0).toBe(0);
    expect(listeners.get('did-fail-load')?.size ?? 0).toBe(0);
  });
});

describe('no-target causes are distinguishable (#756)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    mockWebContents.isDestroyed.mockReturnValue(false);
    sendToRendererMock.mockResolvedValue({ ok: true });
    validateResolvedNavigationUrlMock.mockResolvedValue({ valid: true });
    mockWebContents.loadURL.mockResolvedValue(undefined);
  });

  it('says NOT_OWNED when the surface exists but belongs to another workspace', async () => {
    const foreign = { ...TARGET, surfaceId: 'surface-foreign', workspaceId: 'ws-b' };
    const { router } = register([foreign]);

    const response = await router.dispatch({
      id: 'e1',
      method: 'browser.evaluate',
      params: { expression: '1', surfaceId: foreign.surfaceId, workspaceId: 'ws-a' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      // Permanent: retrying can never succeed, and the caller must be able to
      // tell that apart from "no browser yet" without parsing prose.
      expect(response.error).toContain('BROWSER_NOT_OWNED');
      expect(response.error).toContain('Do not retry');
      // Must not leak the other workspace's identity.
      expect(response.error).not.toContain('ws-b');
    }
  });

  it('says NO_TARGET when nothing is registered at all', async () => {
    const { router } = register([]);

    const response = await router.dispatch({
      id: 'e2',
      method: 'browser.evaluate',
      params: { expression: '1', workspaceId: 'ws-a' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('BROWSER_NO_TARGET');
      expect(response.error).toContain('browser_open');
    }
  });

  it('does not claim NOT_OWNED for an unscoped caller', async () => {
    // No workspaceId means nothing was refused on ownership grounds; the
    // honest answer is that there is no target.
    const { router } = register([]);

    const response = await router.dispatch({
      id: 'e3',
      method: 'browser.evaluate',
      params: { expression: '1' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('BROWSER_NO_TARGET');
  });
});
