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

function makeFakeLauncher() {
  const tabs = new Map<string, { url: string; workspaceId?: string; title: string }>();
  let nextId = 1;
  return {
    tabs,
    ensureRunning: vi.fn(async () => 18901),
    openTab: vi.fn(async (url: string, workspaceId?: string) => {
      const targetId = `tgt-${nextId++}`;
      tabs.set(targetId, { url, workspaceId, title: '' });
      return { targetId, url };
    }),
    listTargets: vi.fn(async (workspaceId?: string) =>
      [...tabs.entries()]
        .filter(([, t]) => workspaceId === undefined || t.workspaceId === undefined || t.workspaceId === workspaceId)
        .map(([targetId, t]) => ({ targetId, workspaceId: t.workspaceId, url: t.url, title: t.title })),
    ),
    closeTab: vi.fn(async (targetId: string) => tabs.delete(targetId)),
    dispose: vi.fn(),
    isRunning: vi.fn(() => true),
  };
}

function makeFakeRegistry(perWorkspace?: Record<string, ReturnType<typeof makeFakeLauncher>>) {
  const fallback = makeFakeLauncher();
  return {
    fallback,
    forWorkspace: vi.fn((ws?: string) => (ws && perWorkspace?.[ws]) || fallback),
    forProfile: vi.fn(() => fallback),
    ownerOfTarget: vi.fn(),
    disposeAll: vi.fn(),
  };
}

describe('chrome backend', () => {
  it('browser.open opens a tracked Chrome tab and returns its targetId as surfaceId', async () => {
    const registry = makeFakeRegistry();
    const { router } = register({ backend: 'chrome', launcher: registry });
    const { result } = await dispatch(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' });
    expect(result).toMatchObject({ ok: true, backend: 'chrome', surfaceId: 'tgt-1', url: 'https://a.test/' });
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
    expect(info.targets).toEqual([{ surfaceId: 'tgt-1', targetId: 'tgt-1', workspaceId: 'ws-1' }]);
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
      ok: boolean; tabs: Array<{ surfaceId: string }>;
    };
    expect(list.ok).toBe(true);
    expect(list.tabs.map((t) => t.surfaceId)).toEqual(['tgt-1']);

    const closed = (await dispatch(router, 'browser.tabs', { action: 'close', surfaceId: 'tgt-1', workspaceId: 'ws-1' })).result as { ok: boolean };
    expect(closed.ok).toBe(true);
    expect(registry.fallback.closeTab).toHaveBeenCalledWith('tgt-1');
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

    // cdp.info reports each workspace's own port. (No RpcContext in this
    // harness → attach info undisclosed; assert via the launcher calls.)
    await dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-a' });
    await dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-b' });
    expect(wsA.ensureRunning).toHaveBeenCalled();
    expect(wsB.ensureRunning).toHaveBeenCalled();
  });

  it('chrome mode without a wired launcher fails with a clear message', async () => {
    const { router } = register({ backend: 'chrome' });
    const { error } = await dispatch(router, 'browser.open', { url: 'https://a.test/', workspaceId: 'ws-1' });
    expect(error?.message).toContain('no Chrome launcher is wired');
  });
});
