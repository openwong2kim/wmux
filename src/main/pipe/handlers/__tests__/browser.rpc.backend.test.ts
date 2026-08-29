import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import {
  EXTERNAL_BACKEND_UNSUPPORTED_CODE,
  EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE,
} from '../../../../shared/browserBackend';
import type { BrowserBackendStore } from '../../../browser-session/BrowserBackendStore';

/**
 * #517 backend fork — external mode contract.
 *
 * External mode is fire-and-forget: open/navigate/tabs-new delegate to
 * shell.openExternal, everything else fails closed with the shared contract
 * error. Builtin default must stay byte-identical (regression gate).
 */

const { validateResolvedNavigationUrlMock } = vi.hoisted(() => ({
  validateResolvedNavigationUrlMock: vi.fn(),
}));
const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));
const { openExternalMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
}));

// browser.navigate resolves on the guest's commit event (#756), so the fake
// guest must accept listeners. Auto-fire `did-navigate` on subscribe: these
// tests care about WHICH transport ran, not about commit timing (that is
// covered in browser.rpc.navigate756.test.ts).
const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  loadURL: vi.fn(),
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    if (event === 'did-navigate') setTimeout(() => fn(), 0);
  }),
  off: vi.fn(),
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
  shell: { openExternal: openExternalMock },
}));

vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: validateResolvedNavigationUrlMock,
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

type Backend = 'builtin' | 'external' | 'chrome';

interface Harness {
  router: RpcRouter;
  cdp: {
    getTarget: ReturnType<typeof vi.fn>;
    ensureAwake: ReturnType<typeof vi.fn>;
    listTargets: ReturnType<typeof vi.fn>;
  };
  setBackend: (b: Backend) => void;
}

const TARGET = {
  surfaceId: 'surface-1',
  webContentsId: 42,
  targetId: 'target-1',
  wsUrl: 'ws://127.0.0.1/devtools/page/target-1',
  workspaceId: 'ws-1',
};

function register(opts: { backend?: Backend; hasTarget?: boolean; withStore?: boolean; launcher?: unknown } = {}): Harness {
  let backend: Backend = opts.backend ?? 'builtin';
  const hasTarget = opts.hasTarget ?? false;
  const router = new RpcRouter();
  const cdp = {
    getTarget: vi.fn(() => (hasTarget ? TARGET : null)),
    listTargets: vi.fn(() => (hasTarget ? [TARGET] : [])),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn(() => 'lease-1'),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  const store = { get: () => backend, set: (b: Backend) => { backend = b; } };
  registerBrowserRpc(
    router,
    () => null as unknown as BrowserWindow,
    cdp as never,
    (opts.withStore === false ? undefined : store) as unknown as BrowserBackendStore,
    undefined,
    undefined,
    opts.launcher as never,
  );
  return { router, cdp, setBackend: (b) => { backend = b; } };
}

async function dispatch(router: RpcRouter, method: string, params: Record<string, unknown> = {}) {
  const response = await router.dispatch({ id: '1', method, params } as never);
  if (response.ok) return { result: (response as { result?: unknown }).result };
  return { error: { message: String((response as { error?: unknown }).error ?? '') } };
}

beforeEach(() => {
  vi.clearAllMocks();
  validateResolvedNavigationUrlMock.mockResolvedValue({ valid: true });
  sendToRendererMock.mockResolvedValue({ ok: true });
  openExternalMock.mockResolvedValue(undefined);
});

describe('browser backend fork (#517)', () => {
  describe('regression: builtin default', () => {
    it('browser.open with no store behaves exactly as before (renderer send, no openExternal)', async () => {
      const { router } = register({ withStore: false });
      const res = await dispatch(router, 'browser.open', { url: 'https://example.com', workspaceId: 'ws-1' });
      expect((res as { result?: unknown }).result).toEqual({ ok: true });
      expect(sendToRendererMock).toHaveBeenCalledWith(expect.anything(), 'browser.open', expect.objectContaining({ url: 'https://example.com' }));
      expect(openExternalMock).not.toHaveBeenCalled();
    });

    it('browser.open with store at builtin is identical to no-store behavior', async () => {
      const { router } = register({ backend: 'builtin' });
      await dispatch(router, 'browser.open', { url: 'https://example.com', workspaceId: 'ws-1' });
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);
      expect(openExternalMock).not.toHaveBeenCalled();
    });
  });

  describe('external open', () => {
    it('delegates to shell.openExternal, returns fire-and-forget result, no renderer send', async () => {
      const { router } = register({ backend: 'external' });
      const res = await dispatch(router, 'browser.open', { url: 'https://example.com', workspaceId: 'ws-1' });
      expect((res as { result?: unknown }).result).toEqual({ backend: 'external', opened: true, url: 'https://example.com' });
      expect(openExternalMock).toHaveBeenCalledWith('https://example.com');
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it('rejects a URL the navigation policy blocks, without calling openExternal', async () => {
      validateResolvedNavigationUrlMock.mockResolvedValue({ valid: false, reason: 'blocked scheme' });
      const { router } = register({ backend: 'external' });
      const res = await dispatch(router, 'browser.open', { url: 'file:///etc/passwd', workspaceId: 'ws-1' });
      expect((res as { error?: { message?: string } }).error?.message).toContain('blocked scheme');
      expect(openExternalMock).not.toHaveBeenCalled();
    });

    it('propagates shell.openExternal failure as an error', async () => {
      openExternalMock.mockRejectedValue(new Error('no handler'));
      const { router } = register({ backend: 'external' });
      const res = await dispatch(router, 'browser.open', { url: 'https://example.com', workspaceId: 'ws-1' });
      expect((res as { error?: { message?: string } }).error?.message).toContain('no handler');
    });

    it('open without a url fails with a dedicated argument error, not the contract error (GLM P3)', async () => {
      const { router } = register({ backend: 'external' });
      const res = await dispatch(router, 'browser.open', { workspaceId: 'ws-1' });
      const message = (res as { error?: { message?: string } }).error?.message ?? '';
      expect(message).toContain('a url is required');
      expect(message).not.toContain(EXTERNAL_BACKEND_UNSUPPORTED_CODE);
      expect(openExternalMock).not.toHaveBeenCalled();
    });
  });

  describe('external navigate', () => {
    it('with no builtin surface delegates like open', async () => {
      const { router } = register({ backend: 'external', hasTarget: false });
      const res = await dispatch(router, 'browser.navigate', { url: 'https://example.com' });
      expect((res as { result?: unknown }).result).toEqual({ backend: 'external', opened: true, url: 'https://example.com' });
      expect(openExternalMock).toHaveBeenCalledWith('https://example.com');
    });

    it('with a live builtin surface (manual pane) navigates it normally — mixed mode', async () => {
      const { router } = register({ backend: 'external', hasTarget: true });
      const res = await dispatch(router, 'browser.navigate', { url: 'https://example.com', surfaceId: 'surface-1' });
      expect((res as { result?: { ok?: boolean } }).result?.ok).toBe(true);
      expect(mockWebContents.loadURL).toHaveBeenCalledWith('https://example.com');
      expect(openExternalMock).not.toHaveBeenCalled();
    });
  });

  describe('external tabs', () => {
    it('tabs new delegates like open and returns a BrowserTabsResult-shaped envelope (codex P1)', async () => {
      const { router } = register({ backend: 'external' });
      const res = await dispatch(router, 'browser.tabs', { action: 'new', url: 'https://example.com', workspaceId: 'ws-1' });
      expect((res as { result?: unknown }).result).toEqual({
        ok: true, action: 'new', backend: 'external', opened: true, url: 'https://example.com',
      });
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it('tabs new OS-launch failure reports BROWSER_TAB_CREATE_FAILED, not URL_BLOCKED', async () => {
      openExternalMock.mockRejectedValue(new Error('no handler'));
      const { router } = register({ backend: 'external' });
      const res = await dispatch(router, 'browser.tabs', { action: 'new', url: 'https://example.com', workspaceId: 'ws-1' });
      const result = (res as { result?: { ok?: boolean; error?: { code?: string } } }).result;
      expect(result?.ok).toBe(false);
      expect(result?.error?.code).toBe('BROWSER_TAB_CREATE_FAILED');
    });

    it('tabs new without url is an explicit invalid-argument error', async () => {
      const { router } = register({ backend: 'external' });
      const res = await dispatch(router, 'browser.tabs', { action: 'new', workspaceId: 'ws-1' });
      const result = (res as { result?: { ok?: boolean; error?: { code?: string } } }).result;
      expect(result?.ok).toBe(false);
      expect(result?.error?.code).toBe('BROWSER_TABS_INVALID_ARGUMENT');
    });

    it('tabs list still goes to the renderer (builtin surfaces only)', async () => {
      const { router } = register({ backend: 'external' });
      await dispatch(router, 'browser.tabs', { action: 'list', workspaceId: 'ws-1' });
      expect(sendToRendererMock).toHaveBeenCalledWith(expect.anything(), 'browser.tabs', expect.objectContaining({ action: 'list' }));
    });
  });

  describe('deep automation fails closed', () => {
    it('leased handler with no resolvable target returns the shared contract error, not a generic miss', async () => {
      const { router } = register({ backend: 'external', hasTarget: false });
      const res = await dispatch(router, 'browser.goBack', {});
      expect((res as { error?: { message?: string } }).error?.message).toBe(EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE);
    });

    it('leased handler with an EXPLICIT surfaceId on a live builtin target still works — mixed mode', async () => {
      const { router } = register({ backend: 'external', hasTarget: true });
      const res = await dispatch(router, 'browser.goBack', { surfaceId: 'surface-1' });
      expect((res as { error?: unknown }).error).toBeUndefined();
    });

    it('NEVER resolves the default target without a surfaceId — another workspace pane must not be automated (codex P1)', async () => {
      const { router, cdp } = register({ backend: 'external', hasTarget: true });
      const res = await dispatch(router, 'browser.goBack', {});
      expect((res as { error?: { message?: string } }).error?.message).toBe(EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE);
      expect(cdp.ensureAwake).not.toHaveBeenCalled();
    });

    it('navigate without a surfaceId delegates externally even when some builtin pane exists (codex P1)', async () => {
      const { router } = register({ backend: 'external', hasTarget: true });
      const res = await dispatch(router, 'browser.navigate', { url: 'https://example.com' });
      expect((res as { result?: unknown }).result).toEqual({ backend: 'external', opened: true, url: 'https://example.com' });
      expect(mockWebContents.loadURL).not.toHaveBeenCalled();
    });

    it('lease.acquire without a surfaceId returns no token instead of leasing a foreign pane', async () => {
      const { router } = register({ backend: 'external', hasTarget: true });
      const res = await dispatch(router, 'browser.lease.acquire', {});
      expect((res as { result?: { token?: unknown } }).result?.token).toBeNull();
    });

    it('builtin backend keeps the generic error path (regression)', async () => {
      const { router } = register({ backend: 'builtin', hasTarget: false });
      const res = await dispatch(router, 'browser.goBack', {});
      // The point of this regression test is that builtin does NOT get the
      // external-backend contract error; the no-target wording became a
      // matchable cause in #756.
      expect((res as { error?: { message?: string } }).error?.message).toContain('BROWSER_NO_TARGET');
      expect((res as { error?: { message?: string } }).error?.message).not.toContain(EXTERNAL_BACKEND_UNSUPPORTED_CODE);
    });
  });

  describe('cdp.info workspaceBackend', () => {
    it.each(['builtin', 'external'] as const)('reports %s', async (backend) => {
      const { router } = register({ backend, hasTarget: backend === 'builtin' });
      const res = await dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-1' });
      const result = (res as { result?: { workspaceBackend?: string } }).result;
      expect(result?.workspaceBackend).toBe(backend);
    });

    it('does not wait for builtin target registration in external mode', async () => {
      vi.useFakeTimers();
      try {
        const { router, cdp } = register({ backend: 'external', hasTarget: false });
        const responsePromise = dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-1' });

        await vi.advanceTimersByTimeAsync(0);

        expect(vi.getTimerCount()).toBe(0);
        expect(cdp.listTargets).toHaveBeenCalledTimes(1);
        await expect(responsePromise).resolves.toMatchObject({
          result: {
            workspaceBackend: 'external',
            targetsScoped: true,
            targets: [],
          },
        });
      } finally {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    });

    it('reports the backend as it stands after the grace period, not before it', async () => {
      // Settings writes the backend over IPC on the same event loop, so it can
      // land mid-wait. Reporting the entry value would tell the caller
      // 'builtin' + zero targets — a generic target-miss it would retry — when
      // the honest answer is now the external-backend contract error.
      vi.useFakeTimers();
      try {
        const { router, setBackend } = register({ backend: 'builtin', hasTarget: false });
        const responsePromise = dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-1' });

        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1); // the entry value chose to wait
        setBackend('external');
        await vi.advanceTimersByTimeAsync(1500);

        await expect(responsePromise).resolves.toMatchObject({
          result: {
            workspaceBackend: 'external',
            targetsScoped: true,
            targets: [],
          },
        });
      } finally {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    });
  });
});


// ── Phase 2: 'chrome' backend ──────────────────────────────────────────────

// The two ids are deliberately DIFFERENT here: surfaceId is the stable wmux
// handle agents hold, targetId the CDP target it currently maps to. Anything
// that conflates them shows up as a failure rather than passing by accident.
function makeFakeLauncher() {
  const tabs = new Map<string, { targetId: string; url: string; workspaceId?: string; title: string }>();
  let nextId = 1;
  const visible = (workspaceId?: string) =>
    [...tabs.entries()]
      .filter(([, t]) => workspaceId === undefined || t.workspaceId === undefined || t.workspaceId === workspaceId)
      .map(([surfaceId, t]) => ({
        surfaceId,
        targetId: t.targetId,
        workspaceId: t.workspaceId,
        url: t.url,
        title: t.title,
      }));
  return {
    tabs,
    ensureRunning: vi.fn(async () => 18901),
    endpoint: vi.fn(async () => ({ cdpPort: 18901 })),
    cdpInfoTargets: vi.fn(async (workspaceId?: string) => visible(workspaceId)),
    openTab: vi.fn(async (url: string, workspaceId?: string) => {
      const n = nextId++;
      const surfaceId = `sfc-${n}`;
      const targetId = `tgt-${n}`;
      tabs.set(surfaceId, { targetId, url, workspaceId, title: '' });
      return { surfaceId, targetId, url };
    }),
    listTargets: vi.fn(async (workspaceId?: string) => visible(workspaceId)),
    closeSurface: vi.fn(async (surfaceId: string) => tabs.delete(surfaceId)),
    hasSurface: vi.fn((surfaceId: string) => tabs.has(surfaceId)),
    dispose: vi.fn(),
    isRunning: vi.fn(() => true),
  };
}

function makeFakeRegistry(perWorkspace?: Record<string, ReturnType<typeof makeFakeLauncher>>) {
  const fallback = makeFakeLauncher();
  const all = [fallback, ...Object.values(perWorkspace ?? {})];
  return {
    fallback,
    forWorkspace: vi.fn((ws?: string) => (ws && perWorkspace?.[ws]) || fallback),
    forProfile: vi.fn(() => fallback),
    ownerOfSurface: vi.fn((surfaceId: string) => {
      for (const client of all) {
        const record = client.tabs.get(surfaceId);
        if (record) return { workspaceId: record.workspaceId, client };
      }
      return null;
    }),
    disposeAll: vi.fn(),
  };
}

describe('chrome backend', () => {
  it('browser.open opens a tracked Chrome tab and returns a stable surfaceId, not the CDP targetId', async () => {
    const registry = makeFakeRegistry();
    const { router } = register({ backend: 'chrome', launcher: registry });
    const { result } = await dispatch(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' });
    expect(result).toMatchObject({ ok: true, backend: 'chrome', surfaceId: 'sfc-1', url: 'https://a.test/' });
    expect(registry.forWorkspace).toHaveBeenCalledWith('ws-1');
    expect(registry.fallback.openTab).toHaveBeenCalledWith('https://a.test/', 'ws-1');
    expect(sendToRendererMock).not.toHaveBeenCalled();
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('browser.cdp.info reports the chrome endpoint with workspace-scoped registry targets and no shellUrl', async () => {
    const registry = makeFakeRegistry();
    const { router } = register({ backend: 'chrome', launcher: registry });
    await dispatch(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' });
    await dispatch(router, 'browser.open', { url: 'https://b.test/', workspaceId: 'ws-2' });

    const { result } = await dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-1' });
    const info = result as { workspaceBackend: string; shellUrl?: string; targets: Array<{ surfaceId: string; targetId: string; workspaceId?: string }> };
    expect(info.workspaceBackend).toBe('chrome');
    expect(info.shellUrl).toBeUndefined();
    // The engine matches the registry on surfaceId, then dials CDP with
    // targetId - cdp.info must carry BOTH, and they are not the same value.
    expect(info.targets).toEqual([{ surfaceId: 'sfc-1', targetId: 'tgt-1', workspaceId: 'ws-1' }]);
  });

  it('a leased RPC-fallback handler with no builtin target throws the chrome contract error', async () => {
    const registry = makeFakeRegistry();
    const { router } = register({ backend: 'chrome', launcher: registry });
    const { error } = await dispatch(router, 'browser.screenshot', {});
    expect(error?.message).toContain('CHROME_BACKEND_RPC_UNSUPPORTED');
  });

  it('browser.lifecycle.get returns empty entries instead of the contract error', async () => {
    const registry = makeFakeRegistry();
    const { router } = register({ backend: 'chrome', launcher: registry });
    const { result } = await dispatch(router, 'browser.lifecycle.get', {});
    expect(result).toEqual({ entries: [] });
  });

  it('browser.tabs list/close operate on the workspace-scoped registry', async () => {
    const registry = makeFakeRegistry();
    const { router } = register({ backend: 'chrome', launcher: registry });
    await dispatch(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' });

    const list = (await dispatch(router, 'browser.tabs', { action: 'list', workspaceId: 'ws-1' })).result as {
      ok: boolean; tabs: Array<{ surfaceId: string; paneId: string }>;
    };
    expect(list.ok).toBe(true);
    expect(list.tabs.map((t) => t.surfaceId)).toEqual(['sfc-1']);
    expect(list.tabs.map((t) => t.paneId)).toEqual(['chrome:sfc-1']);

    const closed = (await dispatch(router, 'browser.tabs', { action: 'close', surfaceId: 'sfc-1', workspaceId: 'ws-1' })).result as { ok: boolean };
    expect(closed.ok).toBe(true);
    expect(registry.fallback.closeSurface).toHaveBeenCalledWith('sfc-1');
  });

  it('two bound workspaces resolve to different launchers (ports + tab isolation) (Phase 2.5)', async () => {
    const wsA = makeFakeLauncher();
    const wsB = makeFakeLauncher();
    wsA.ensureRunning.mockResolvedValue(18901);
    wsB.ensureRunning.mockResolvedValue(18906);
    const registry = makeFakeRegistry({ 'ws-a': wsA, 'ws-b': wsB });
    const { router } = register({ backend: 'chrome', launcher: registry });

    await dispatch(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-a' });
    await dispatch(router, 'browser.open', { url: 'https://b.test/', workspaceId: 'ws-b' });
    expect(wsA.openTab).toHaveBeenCalledWith('https://a.test/', 'ws-a');
    expect(wsB.openTab).toHaveBeenCalledWith('https://b.test/', 'ws-b');

    // Tab isolation: ws-a's list never sees ws-b's tab (separate instance).
    const listA = (await dispatch(router, 'browser.tabs', { action: 'list', workspaceId: 'ws-a' })).result as {
      tabs: Array<{ url: string }>;
    };
    expect(listA.tabs.map((t) => t.url)).toEqual(['https://a.test/']);

    // cdp.info reports each workspace's own endpoint. (No RpcContext in this
    // harness → attach info undisclosed; assert via the endpoint() calls.)
    await dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-a' });
    await dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-b' });
    expect(wsA.endpoint).toHaveBeenCalled();
    expect(wsB.endpoint).toHaveBeenCalled();
  });

  it('live attach: cdp.info reports wsEndpoint with no targets; tabs list exposes all live tabs (Phase 3)', async () => {
    const live = {
      endpoint: vi.fn(async () => ({ wsEndpoint: 'ws://127.0.0.1:9333/devtools/browser/abc' })),
      cdpInfoTargets: vi.fn(async () => []),
      // Live keeps surfaceId identical to targetId - see LiveChromeClient.
      openTab: vi.fn(async (url: string) => ({ surfaceId: 'lt-1', targetId: 'lt-1', url })),
      listTargets: vi.fn(async () => [
        { surfaceId: 'lt-1', targetId: 'lt-1', url: 'https://a.test/', title: 'A' },
        { surfaceId: 'lt-2', targetId: 'lt-2', url: 'https://b.test/', title: 'B' },
      ]),
      closeSurface: vi.fn(async () => true),
      selectSurface: vi.fn(async () => true),
      hasSurface: vi.fn(() => true),
      dispose: vi.fn(),
    };
    const registry = {
      forWorkspace: vi.fn(() => live),
      forProfile: vi.fn(() => live),
      ownerOfSurface: vi.fn(() => null),
      disposeAll: vi.fn(),
    };
    const { router } = register({ backend: 'chrome', launcher: registry });

    // cdp.info: safe default — no targets, backend marker present. (No
    // RpcContext in this harness → wsEndpoint undisclosed, like cdpPort.)
    const info = (await dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-1' })).result as {
      workspaceBackend: string; targets: unknown[]; cdpPort?: number; wsEndpoint?: string;
    };
    expect(info.workspaceBackend).toBe('chrome');
    expect(info.targets).toEqual([]);
    expect(info.cdpPort).toBeUndefined();

    // Full exposure: all live tabs listed; select drives real focus.
    const list = (await dispatch(router, 'browser.tabs', { action: 'list', workspaceId: 'ws-1' })).result as {
      tabs: Array<{ surfaceId: string }>;
    };
    expect(list.tabs.map((t) => t.surfaceId)).toEqual(['lt-1', 'lt-2']);
    const sel = (await dispatch(router, 'browser.tabs', { action: 'select', surfaceId: 'lt-2', workspaceId: 'ws-1' })).result as { ok: boolean };
    expect(sel.ok).toBe(true);
    expect(live.selectSurface).toHaveBeenCalledWith('lt-2');
  });

  it('chrome mode without a wired launcher fails with a clear message', async () => {
    const { router } = register({ backend: 'chrome' });
    const { error } = await dispatch(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' });
    expect(error?.message).toContain('no Chrome launcher is wired');
  });
});

// ── browser.close on the 'chrome' backend ──────────────────────────────────
//
// Chrome tabs live outside the renderer, so the pre-existing bridge send was a
// silent no-op for them: browser_close reported success and closed nothing.
// The chrome branch closes the tab itself, and scopes the close to the caller.
describe('chrome backend browser.close', () => {
  it('closes the named surface and never touches the renderer', async () => {
    const registry = makeFakeRegistry();
    const { router } = register({ backend: 'chrome', launcher: registry });
    await dispatch(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' });

    const { result } = await dispatch(router, 'browser.close', { surfaceId: 'sfc-1', workspaceId: 'ws-1' });
    expect(result).toEqual({ ok: true, backend: 'chrome', closed: true, surfaceId: 'sfc-1' });
    expect(registry.fallback.closeSurface).toHaveBeenCalledWith('sfc-1');
    // The renderer knows nothing about Chrome tabs — sending there is what
    // made the old behavior a silent no-op.
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('without a surfaceId closes the workspace most recently opened tab', async () => {
    const registry = makeFakeRegistry();
    const { router } = register({ backend: 'chrome', launcher: registry });
    await dispatch(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' });
    await dispatch(router, 'browser.open', { url: 'https://b.test/', workspaceId: 'ws-1' });

    const { result } = await dispatch(router, 'browser.close', { workspaceId: 'ws-1' });
    expect(result).toMatchObject({ ok: true, closed: true, surfaceId: 'sfc-2' });
    expect(registry.fallback.closeSurface).toHaveBeenCalledWith('sfc-2');
    expect(registry.fallback.tabs.has('sfc-1')).toBe(true); // the older tab stays
  });

  it('a transitional raw CDP targetId still resolves to its surface', async () => {
    const registry = makeFakeRegistry();
    const { router } = register({ backend: 'chrome', launcher: registry });
    await dispatch(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' });

    const { result } = await dispatch(router, 'browser.close', { surfaceId: 'tgt-1', workspaceId: 'ws-1' });
    expect(result).toMatchObject({ ok: true, closed: true, surfaceId: 'sfc-1' });
  });

  it('refuses to close a surface owned by another workspace (cross-workspace teardown)', async () => {
    const wsA = makeFakeLauncher();
    const wsB = makeFakeLauncher();
    const registry = makeFakeRegistry({ 'ws-a': wsA, 'ws-b': wsB });
    const { router } = register({ backend: 'chrome', launcher: registry });
    await dispatch(router, 'browser.open', { url: 'https://b.test/', workspaceId: 'ws-b' });

    const { error } = await dispatch(router, 'browser.close', { surfaceId: 'sfc-1', workspaceId: 'ws-a' });
    expect(error?.message).toContain('no wmux-opened Chrome tab');
    expect(wsB.closeSurface).not.toHaveBeenCalled();
    expect(wsB.tabs.has('sfc-1')).toBe(true);
  });

  it('closes a surface the caller workspace owns under a different profile launcher', async () => {
    // The workspace rebound to another profile after opening the tab: the
    // caller resolves to a launcher that never saw it, and the registry
    // fallback finds the real owner — allowed only because the record's
    // workspace matches the caller's scope.
    const owner = makeFakeLauncher();
    const registry = makeFakeRegistry({ 'ws-owner': owner });
    await owner.openTab('https://a.test/', 'ws-caller');
    const { router } = register({ backend: 'chrome', launcher: registry });

    const { result } = await dispatch(router, 'browser.close', { surfaceId: 'sfc-1', workspaceId: 'ws-caller' });
    expect(result).toMatchObject({ ok: true, closed: true, surfaceId: 'sfc-1' });
    expect(owner.closeSurface).toHaveBeenCalledWith('sfc-1');
  });

  it('with nothing open reports an explicit error instead of a silent success', async () => {
    const registry = makeFakeRegistry();
    const { router } = register({ backend: 'chrome', launcher: registry });
    const { error } = await dispatch(router, 'browser.close', { workspaceId: 'ws-1' });
    expect(error?.message).toContain('no open wmux Chrome tab');
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('builtin backend still forwards browser.close to the renderer (regression)', async () => {
    const { router } = register({ backend: 'builtin' });
    await dispatch(router, 'browser.close', { surfaceId: 'surface-9', workspaceId: 'ws-1' });
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'browser.close',
      expect.objectContaining({ surfaceId: 'surface-9', workspaceId: 'ws-1' }),
    );
  });
});
