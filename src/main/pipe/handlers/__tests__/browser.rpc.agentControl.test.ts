import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc, untilAborted } from '../browser.rpc';
import { dispatchAsClaimedCaller } from './claimedCaller';
import { BrowserAgentControl } from '../../../browser-session/BrowserAgentControl';

const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  on: vi.fn(),
  getURL: vi.fn(() => 'https://example.com'),
  debugger: { sendCommand: vi.fn(async () => ({ result: { value: 2 } })), isAttached: vi.fn(() => true) },
};

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => mockWebContents) },
}));
vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: vi.fn(async () => ({ valid: true })),
}));
const { sendToRendererMock } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each case stubs its own argument shape
  sendToRendererMock: vi.fn(async (..._args: any[]): Promise<unknown> => ({ ok: true })),
}));
vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

const SURFACE = {
  surfaceId: 'tab-1', webContentsId: 42,
  targetId: 'target-1', workspaceId: 'ws-a',
};

function setup() {
  const revoked = new Map<string, Error>();
  let registered = true;
  const cdp = {
    getTarget: vi.fn((surfaceId?: string) => (registered && (!surfaceId || surfaceId === SURFACE.surfaceId) ? SURFACE : null)),
    waitForTarget: vi.fn(async () => SURFACE),
    ensureAwake: vi.fn(async () => null),
    listTargets: vi.fn(() => [SURFACE]),
    getCdpPort: vi.fn(() => 18800),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn((sid: string) => `lease-for-${sid}`),
    renewRpcLease: vi.fn((token: string) => !revoked.has(token)),
    releaseRpcLease: vi.fn(() => true),
    rpcLeaseRevocation: vi.fn((token: string) => revoked.get(token)),
    watchRpcLease: vi.fn(async () => undefined),
    isDiscarded: vi.fn(() => false),
  };
  const control = new BrowserAgentControl({
    emit: () => undefined,
    cancelInFlight: (_surfaceId, error) => revoked.set('lease-held', error),
  });
  const router = dispatchAsClaimedCaller(new RpcRouter());
  registerBrowserRpc(
    router,
    () => null as unknown as BrowserWindow,
    cdp as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    control,
  );
  const cleanup = cdp.setCaptureCleanup.mock.calls[0]?.[0] as ((wcId: number) => void) | undefined;
  return { router, cdp, control, cleanup, unregister: () => { registered = false; } };
}

const acquire = (router: RpcRouter, authorize: boolean) =>
  router.dispatch({
    id: 'a',
    method: 'browser.lease.acquire',
    params: { surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a', ...(authorize && { authorize: true }) },
  });

describe('browser RPC — the user paused or took over the tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('refuses the MCP lane\'s lease while paused, with the stable code, and leases again after Resume', async () => {
    const { router, cdp, control } = setup();
    control.apply(SURFACE.surfaceId, 'stop');

    for (const authorize of [true, false]) {
      const res = await acquire(router, authorize);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('BROWSER_AGENT_PAUSED: the user paused agent control of this tab');
    }
    expect(cdp.acquireRpcLease).not.toHaveBeenCalled();

    control.apply(SURFACE.surfaceId, 'resume');
    const res = await acquire(router, true);
    expect(res.ok).toBe(true);
    expect(cdp.acquireRpcLease).toHaveBeenCalledWith(SURFACE.surfaceId);
  });

  it('refuses main\'s own leased browser calls while the user has the tab, before the page is touched', async () => {
    const { router, cdp, control } = setup();
    control.apply(SURFACE.surfaceId, 'takeOver');

    const res = await router.dispatch({
      id: 'e',
      method: 'browser.evaluate',
      params: { expression: '1+1', surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a' },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('BROWSER_USER_IN_CONTROL');
    expect(cdp.withAutomationLease).not.toHaveBeenCalled();
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();

    control.apply(SURFACE.surfaceId, 'handBack');
    const after = await router.dispatch({
      id: 'e2',
      method: 'browser.evaluate',
      params: { expression: '1+1', surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a' },
    });
    expect(after.ok).toBe(true);
  });

  it('refuses an upload into a tab the user paused, before any path check or page command', async () => {
    const { router, cdp, control } = setup();
    control.apply(SURFACE.surfaceId, 'stop');

    const res = await router.dispatch({
      id: 'u',
      method: 'browser.upload.cdp',
      params: { files: ['/tmp/x'], surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a' },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('BROWSER_AGENT_PAUSED');
    expect(cdp.withAutomationLease).not.toHaveBeenCalled();
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('a renew of a lease the user ended fails with the reason, so the op in flight stops', async () => {
    const { router, control } = setup();
    control.apply(SURFACE.surfaceId, 'stop');

    const res = await router.dispatch({ id: 'r', method: 'browser.lease.renew', params: { token: 'lease-held' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/BROWSER_AGENT_PAUSED: the user stopped this action/);
  });

  it('a renew with waitMs parks on the lease and says it did', async () => {
    const { router, cdp } = setup();
    const res = await router.dispatch({ id: 'w', method: 'browser.lease.renew', params: { token: 'lease-x', waitMs: 60_000 } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ ok: true, watched: true });
    // Capped well inside the lease TTL.
    expect(cdp.watchRpcLease).toHaveBeenCalledWith('lease-x', 8_000);

    const plain = await router.dispatch({ id: 'p', method: 'browser.lease.renew', params: { token: 'lease-x' } });
    if (plain.ok) expect(plain.result).toEqual({ ok: true });
  });

  it('refuses to close a taken-over tab, by name or as the workspace\'s browser tab', async () => {
    const { router, control } = setup();
    control.apply(SURFACE.surfaceId, 'takeOver');

    for (const params of [
      { surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a' },
      { workspaceId: 'ws-a' },
    ]) {
      const res = await router.dispatch({ id: 'c', method: 'browser.close', params });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('browser.close: BROWSER_USER_IN_CONTROL');
    }
    const tabs = await router.dispatch({
      id: 't', method: 'browser.tabs', params: { action: 'close', surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a' },
    });
    // A tabs error the tool shows as is, not a throw it would relabel.
    expect(tabs.ok).toBe(true);
    if (tabs.ok) {
      expect(tabs.result).toMatchObject({ ok: false, error: { code: 'BROWSER_TABS_SCOPE_REFUSED' } });
      expect(JSON.stringify(tabs.result)).toContain('browser_tabs close: BROWSER_USER_IN_CONTROL');
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();

    control.apply(SURFACE.surfaceId, 'handBack');
    const after = await router.dispatch({ id: 'c2', method: 'browser.close', params: { surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a' } });
    expect(after.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.anything(), 'browser.close', expect.objectContaining({ surfaceId: SURFACE.surfaceId }));
  });

  it('does not hand out the CDP target of a paused tab, named or by default', async () => {
    const { router, control } = setup();
    control.apply(SURFACE.surfaceId, 'stop');
    for (const params of [{ surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a' }, { workspaceId: 'ws-a' }]) {
      const res = await router.dispatch({ id: 'g', method: 'browser.cdp.target', params });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('browser.cdp.target: BROWSER_AGENT_PAUSED');
    }
    control.apply(SURFACE.surfaceId, 'resume');
    const res = await router.dispatch({ id: 'g2', method: 'browser.cdp.target', params: { surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a' } });
    if (res.ok) expect(res.result).toEqual({ targetId: SURFACE.targetId, surfaceId: SURFACE.surfaceId });
    else throw new Error(res.error);
  });

  it('refuses a named paused tab before waking it, so a discarded tab is not reloaded', async () => {
    const { router, cdp, control, unregister } = setup();
    unregister(); // discarded: no live target until a wake
    control.apply(SURFACE.surfaceId, 'stop');
    const res = await acquire(router, true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('BROWSER_AGENT_PAUSED');
    expect(cdp.ensureAwake).not.toHaveBeenCalled();
  });

  it('a parked renew whose caller hung up ends without a final renew', async () => {
    const { router, cdp } = setup();
    let release!: () => void;
    cdp.watchRpcLease.mockImplementation(() => new Promise<undefined>((r) => { release = () => r(undefined); }));
    const hangUp = new AbortController();
    const pending = router.dispatch(
      { id: 'w2', method: 'browser.lease.renew', params: { token: 'lease-x', waitMs: 8_000 } },
      { operator: true, signal: hangUp.signal },
    );
    await vi.waitFor(() => expect(cdp.watchRpcLease).toHaveBeenCalled(), { timeout: 5_000 });
    hangUp.abort();
    await pending;
    release();
    // Only the renewal that started the park: the lease lapses at its TTL.
    expect(cdp.renewRpcLease).toHaveBeenCalledTimes(1);
  });

  it('forgets a tab\'s hold once its guest is gone for good, but not on a remount', async () => {
    vi.useFakeTimers();
    const { control, cleanup, unregister, cdp } = setup();
    control.apply(SURFACE.surfaceId, 'takeOver');
    // A remount: the guest goes and comes back within the grace.
    cleanup?.(SURFACE.webContentsId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(control.get(SURFACE.surfaceId).mode).toBe('user');

    // A discard keeps it: the tab is asleep, not closed.
    cdp.isDiscarded.mockReturnValueOnce(true);
    cleanup?.(SURFACE.webContentsId);
    unregister();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(control.get(SURFACE.surfaceId).mode).toBe('user');
  });

  it('a closed tab\'s hold is dropped after the grace', async () => {
    vi.useFakeTimers();
    const { control, cleanup, unregister } = setup();
    control.apply(SURFACE.surfaceId, 'takeOver');
    cleanup?.(SURFACE.webContentsId);
    unregister();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(control.get(SURFACE.surfaceId).mode).toBe('agent');
  });

  it('an unnamed close refuses a held tab that is discarded (no live target), found through the renderer', async () => {
    const { router, control, cdp } = setup();
    cdp.listTargets.mockReturnValue([]); // the held tab sleeps: no CDP target
    control.apply('sleeping-tab', 'takeOver');
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string) =>
      method === 'surface.list' ? [{ id: 'sleeping-tab', paneId: 'p1', surfaceType: 'browser' }] : { ok: true });

    const res = await router.dispatch({ id: 'c', method: 'browser.close', params: { workspaceId: 'ws-a' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('browser.close: BROWSER_USER_IN_CONTROL');
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.anything(), 'surface.list', { workspaceId: 'ws-a', includeStashed: true });
    expect(sendToRendererMock).not.toHaveBeenCalledWith(expect.anything(), 'browser.close', expect.anything());
  });
});

describe('untilAborted', () => {
  it('removes its abort listener whichever side wins', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await untilAborted(Promise.resolve(), controller.signal);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);

    const parked = untilAborted(new Promise(() => undefined), controller.signal);
    controller.abort();
    await parked;
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls[1][1]).toBe(add.mock.calls[1][1]);
  });
});

