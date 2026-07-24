import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';

const { validateResolvedNavigationUrlMock } = vi.hoisted(() => ({
  validateResolvedNavigationUrlMock: vi.fn(),
}));
const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));
const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  canGoBack: vi.fn(() => true),
  goBack: vi.fn(),
  loadURL: vi.fn(),
  once: vi.fn(),
  debugger: {
    sendCommand: vi.fn(async () => ({})),
    // EventEmitter-ish surface used by BrowserCaptureManager (#106).
    isAttached: vi.fn(() => true),
    attach: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
};

vi.mock('electron', () => ({
  webContents: {
    fromId: vi.fn(() => mockWebContents),
  },
}));

vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: validateResolvedNavigationUrlMock,
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

describe('registerBrowserRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWebContents.isDestroyed.mockReturnValue(false);
    mockWebContents.canGoBack.mockReturnValue(true);
    validateResolvedNavigationUrlMock.mockResolvedValue({ valid: true });
    sendToRendererMock.mockResolvedValue({ ok: true });
  });

  function register(getWindow: () => BrowserWindow | null = () => null): RpcRouter {
    const router = new RpcRouter();
    const webviewCdpManager = {
      getTarget: vi.fn(() => ({ surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1', wsUrl: 'ws://127.0.0.1/devtools/page/target-1' })),
      listTargets: vi.fn(() => [{ surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1', wsUrl: 'ws://127.0.0.1/devtools/page/target-1' }]),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      // #517: automation ops run through the per-op lease wrapper.
      withAutomationLease: vi.fn(async (_surfaceId: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };

    registerBrowserRpc(router, getWindow, webviewCdpManager as never);
    return router;
  }

  /** Build a fake main window whose webContents.getURL() returns `url`. */
  function windowWithUrl(url: string | (() => string)): () => BrowserWindow {
    const getURL = typeof url === 'function' ? url : () => url;
    return () => ({ webContents: { getURL } }) as unknown as BrowserWindow;
  }

  it('does not expose browser.cdp.send through the RPC router', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '1',
      method: 'browser.cdp.send' as never,
      params: { method: 'Page.navigate' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('Unknown method: browser.cdp.send');
    }
  });

  it('browser.goBack uses the reviewed navigation method instead of raw CDP', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '2',
      method: 'browser.goBack',
      params: {},
    });

    expect(response.ok).toBe(true);
    expect(mockWebContents.goBack).toHaveBeenCalledTimes(1);
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('browser.cdp.info only returns minimal target metadata', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '3',
      method: 'browser.cdp.info',
      params: {},
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      // No window (getWindow → null): shellUrl is omitted, not null.
      expect(response.result).toEqual({
        cdpPort: 18800,
        targets: [{ surfaceId: 'surface-1', targetId: 'target-1' }],
      });
    }
  });

  it('browser.cdp.info exposes the main-window URL as shellUrl', async () => {
    const router = register(
      windowWithUrl('file:///x/.vite/renderer/main_window/index.html'),
    );

    const response = await router.dispatch({
      id: '3b',
      method: 'browser.cdp.info',
      params: {},
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toMatchObject({
        cdpPort: 18800,
        shellUrl: 'file:///x/.vite/renderer/main_window/index.html',
      });
    }
  });

  it('browser.cdp.info omits shellUrl when the URL is empty (mid-load)', async () => {
    const router = register(windowWithUrl(''));

    const response = await router.dispatch({
      id: '3c',
      method: 'browser.cdp.info',
      params: {},
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).not.toHaveProperty('shellUrl');
    }
  });

  it('browser.cdp.info omits shellUrl when getURL throws (window destroyed)', async () => {
    const router = register(windowWithUrl(() => { throw new Error('destroyed'); }));

    const response = await router.dispatch({
      id: '3d',
      method: 'browser.cdp.info',
      params: {},
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).not.toHaveProperty('shellUrl');
    }
  });

  it('browser.navigate rejects URLs whose resolved targets are blocked', async () => {
    validateResolvedNavigationUrlMock.mockResolvedValue({
      valid: false,
      reason: 'Blocked resolved address 169.254.169.254: Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });

    const router = register();
    const response = await router.dispatch({
      id: '4',
      method: 'browser.navigate',
      params: { url: 'https://metadata.example' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('browser.navigate: Blocked resolved address 169.254.169.254');
    }
    expect(mockWebContents.loadURL).not.toHaveBeenCalled();
  });

  it('browser.tabs list forwards the strictly supplied workspace without CDP state', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '4b',
      method: 'browser.tabs',
      params: { action: 'list', workspaceId: 'ws-caller' },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.tabs', {
      action: 'list',
      workspaceId: 'ws-caller',
    });
  });

  it('browser.tabs new validates the URL and supplies the active partition', async () => {
    const router = register();

    await router.dispatch({
      id: '4c',
      method: 'browser.tabs',
      params: {
        action: 'new',
        workspaceId: 'ws-caller',
        url: 'https://example.com/',
      },
    });

    expect(validateResolvedNavigationUrlMock).toHaveBeenCalledWith('https://example.com/');
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.tabs', {
      action: 'new',
      workspaceId: 'ws-caller',
      url: 'https://example.com/',
      partition: 'persist:wmux-default',
    });
  });

  it('browser.tabs new returns a stable blocked-url error before renderer mutation', async () => {
    validateResolvedNavigationUrlMock.mockResolvedValue({
      valid: false,
      reason: 'Blocked resolved address 169.254.169.254',
    });
    const router = register();

    const response = await router.dispatch({
      id: '4d',
      method: 'browser.tabs',
      params: {
        action: 'new',
        workspaceId: 'ws-caller',
        url: 'https://metadata.example/',
      },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toMatchObject({
        ok: false,
        error: { code: 'BROWSER_TAB_URL_BLOCKED' },
      });
    }
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.any(Function),
      'browser.tabs',
      expect.anything(),
    );
  });

  it('browser.tabs rejects missing workspace identity and select without surfaceId', async () => {
    const router = register();

    const noWorkspace = await router.dispatch({
      id: '4e',
      method: 'browser.tabs',
      params: { action: 'list' },
    });
    const noSurface = await router.dispatch({
      id: '4f',
      method: 'browser.tabs',
      params: { action: 'select', workspaceId: 'ws-caller' },
    });

    expect(noWorkspace.ok).toBe(true);
    if (noWorkspace.ok) {
      expect(noWorkspace.result).toMatchObject({
        ok: false,
        error: { code: 'BROWSER_TABS_WORKSPACE_UNRESOLVED' },
      });
    }
    expect(noSurface.ok).toBe(true);
    if (noSurface.ok) {
      expect(noSurface.result).toMatchObject({
        ok: false,
        error: { code: 'BROWSER_TABS_INVALID_ARGUMENT' },
      });
    }
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.any(Function),
      'browser.tabs',
      expect.anything(),
    );
  });

  it('browser.tabs close forwards only the stable surface id inside the caller workspace', async () => {
    const router = register();

    await router.dispatch({
      id: '4g',
      method: 'browser.tabs',
      params: {
        action: 'close',
        workspaceId: 'ws-caller',
        surfaceId: 'surface-a',
      },
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.tabs', {
      action: 'close',
      workspaceId: 'ws-caller',
      surfaceId: 'surface-a',
    });
  });

  it('browser.open passes the active profile partition to the renderer', async () => {
    const router = register();

    await router.dispatch({
      id: '5',
      method: 'browser.open',
      params: {},
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.open', {
      partition: 'persist:wmux-default',
    });
  });

  it('browser.close forwards surfaceId and workspaceId to the renderer (caller-ws routing)', async () => {
    const router = register();

    await router.dispatch({
      id: '5b',
      method: 'browser.close',
      params: { surfaceId: 'surface-9', workspaceId: 'ws-caller' },
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.close', {
      surfaceId: 'surface-9',
      workspaceId: 'ws-caller',
    });
  });

  it('browser.close omits absent ids (renderer falls back to the active workspace)', async () => {
    const router = register();

    await router.dispatch({
      id: '5c',
      method: 'browser.close',
      params: {},
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.close', {});
  });

  it('browser.session.start applies only the default partition to renderer browser surfaces', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '6',
      method: 'browser.session.start',
      params: {},
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.session.applyProfile', {
      partition: 'persist:wmux-default',
    });
  });

  it('browser.session.start rejects protected browser profiles', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '7',
      method: 'browser.session.start',
      params: { profile: 'login' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('profile "login" is not available');
    }
    expect(sendToRendererMock).not.toHaveBeenCalledWith(expect.any(Function), 'browser.session.applyProfile', {
      partition: 'persist:wmux-login',
    });
  });

  it('browser.session.start rejects invalid profile names before building partitions', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '8',
      method: 'browser.session.start',
      params: { profile: '../login\ncontrol-char' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('Browser profile names must be 1-64 characters');
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('browser.console.get drains the capture buffer (#106)', async () => {
    const router = register();
    const response = await router.dispatch({ id: '7', method: 'browser.console.get', params: {} });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toHaveProperty('entries');
      expect(Array.isArray((response.result as { entries: unknown[] }).entries)).toBe(true);
    }
  });

  it('browser.network.get drains the capture buffer (#106)', async () => {
    const router = register();
    const response = await router.dispatch({ id: '8', method: 'browser.network.get', params: {} });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toHaveProperty('entries');
    }
  });

  it('browser.responseBody.get requires urlPattern (#106)', async () => {
    const router = register();
    const response = await router.dispatch({ id: '9', method: 'browser.responseBody.get', params: {} });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('missing "urlPattern"');
    }
  });

  it('browser.responseBody.get returns a body field for a pattern (#106)', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '10',
      method: 'browser.responseBody.get',
      params: { urlPattern: '*api*' },
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toHaveProperty('body');
    }
  });

  it('browser.console.get fails clearly when no webview target is registered (#106)', async () => {
    const router = new RpcRouter();
    const webviewCdpManager = {
      getTarget: vi.fn(() => null),
      listTargets: vi.fn(() => []),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      // #517: no registered target → registerLeased runs the handler unleased.
      withAutomationLease: vi.fn(async (_surfaceId: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };
    registerBrowserRpc(router, () => null, webviewCdpManager as never);
    const response = await router.dispatch({ id: '11', method: 'browser.console.get', params: {} });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('no webview target registered');
    }
  });

  // browser.press.cdp regression coverage (#353). The old handler dispatched
  // non-named keys as CDP type:'char', which inserts text but fires NO keydown.
  // Assert the handler now dispatches real keyDown/keyUp descriptors.
  function keyEventCalls(): unknown[][] {
    return (mockWebContents.debugger.sendCommand.mock.calls as unknown[][]).filter(
      (c) => c[0] === 'Input.dispatchKeyEvent',
    );
  }

  it("browser.press.cdp {key:'z'} synthesizes keyDown (with text) + keyUp", async () => {
    const router = register();
    const response = await router.dispatch({
      id: '12',
      method: 'browser.press.cdp',
      params: { key: 'z' },
    });

    expect(response.ok).toBe(true);
    const calls = keyEventCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({
      type: 'keyDown',
      key: 'z',
      code: 'KeyZ',
      text: 'z',
      windowsVirtualKeyCode: 90,
    });
    expect(calls[1][1]).toMatchObject({ type: 'keyUp', key: 'z' });
    // keyUp must not re-insert the character.
    expect(calls[1][1]).not.toHaveProperty('text');
  });

  it("browser.press.cdp {key:'Control+a'} sets the modifier bitmask and suppresses text", async () => {
    const router = register();
    const response = await router.dispatch({
      id: '13',
      method: 'browser.press.cdp',
      params: { key: 'Control+a' },
    });

    expect(response.ok).toBe(true);
    const calls = keyEventCalls();
    expect(calls[0][1]).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    // Shortcut semantics: no text insertion (Control+a selects all, not types "a").
    expect(calls[0][1]).not.toHaveProperty('text');
  });

  it("browser.press.cdp rejects multi-character text with a pointer to browser.type.cdp", async () => {
    const router = register();
    const response = await router.dispatch({
      id: '14',
      method: 'browser.press.cdp',
      params: { key: 'abc' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('browser.type.cdp');
    }
    expect(keyEventCalls()).toHaveLength(0);
  });
});

// ── #529 — screenshot hang fallback ─────────────────────────────────────────

describe('browser.screenshot capture fallback (#529)', () => {
  // Local mirror of the register() helper above (it is scoped to the first
  // describe block).
  function register(): RpcRouter {
    const router = new RpcRouter();
    const webviewCdpManager = {
      getTarget: vi.fn(() => ({ surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1', wsUrl: 'ws://127.0.0.1/devtools/page/target-1' })),
      listTargets: vi.fn(() => []),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      withAutomationLease: vi.fn(async (_surfaceId: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };
    registerBrowserRpc(router, () => null, webviewCdpManager as never);
    return router;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebContents.isDestroyed.mockReturnValue(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (mockWebContents as Record<string, unknown>)['capturePage'];
  });

  it('returns the CDP capture when it resolves promptly (fast path unchanged)', async () => {
    mockWebContents.debugger.sendCommand.mockResolvedValueOnce({ data: 'cdp-png' });
    const router = register();
    const p = router.dispatch({ id: 's1', method: 'browser.screenshot', params: {} });
    await vi.advanceTimersByTimeAsync(10);
    const response = await p;
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toEqual({ data: 'cdp-png' });
  });

  it('falls back to capturePage when the CDP capture hangs', async () => {
    // A capture that never settles — the #529 compositor hang.
    mockWebContents.debugger.sendCommand.mockReturnValueOnce(new Promise(() => {}));
    (mockWebContents as Record<string, unknown>)['capturePage'] = vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from('fallback-png'),
    }));
    const router = register();
    const p = router.dispatch({ id: 's2', method: 'browser.screenshot', params: {} });
    await vi.advanceTimersByTimeAsync(3000);
    const response = await p;
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({ data: Buffer.from('fallback-png').toString('base64') });
    }
  });

  it('fails with a clear error when the CDP capture hangs AND capturePage is empty', async () => {
    mockWebContents.debugger.sendCommand.mockReturnValueOnce(new Promise(() => {}));
    (mockWebContents as Record<string, unknown>)['capturePage'] = vi.fn(async () => ({
      isEmpty: () => true,
      toPNG: () => Buffer.alloc(0),
    }));
    const router = register();
    const p = router.dispatch({ id: 's3', method: 'browser.screenshot', params: {} });
    await vi.advanceTimersByTimeAsync(3000);
    const response = await p;
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('not producing frames');
  });

  it('a rejected CDP capture (debugger detached) also falls back instead of throwing', async () => {
    mockWebContents.debugger.sendCommand.mockRejectedValueOnce(new Error('Debugger detached'));
    (mockWebContents as Record<string, unknown>)['capturePage'] = vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from('after-detach'),
    }));
    const router = register();
    const p = router.dispatch({ id: 's4', method: 'browser.screenshot', params: {} });
    await vi.advanceTimersByTimeAsync(3000);
    const response = await p;
    expect(response.ok).toBe(true);
  });
});
