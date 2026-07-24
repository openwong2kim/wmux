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

const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  loadURL: vi.fn(),
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

type Backend = 'builtin' | 'external';

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
};

function register(opts: { backend?: Backend; hasTarget?: boolean; withStore?: boolean } = {}): Harness {
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
      expect((res as { error?: { message?: string } }).error?.message).toContain('no webview target registered');
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
  });
});
