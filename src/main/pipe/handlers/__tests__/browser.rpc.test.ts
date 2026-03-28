import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  debugger: {
    sendCommand: vi.fn(),
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

  function register(): RpcRouter {
    const router = new RpcRouter();
    const webviewCdpManager = {
      getTarget: vi.fn(() => ({ surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1', wsUrl: 'ws://127.0.0.1/devtools/page/target-1' })),
      listTargets: vi.fn(() => [{ surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1', wsUrl: 'ws://127.0.0.1/devtools/page/target-1' }]),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
    };

    registerBrowserRpc(router, (() => null) as () => BrowserWindow | null, webviewCdpManager as never);
    return router;
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
      expect(response.result).toEqual({
        cdpPort: 18800,
        targets: [{ surfaceId: 'surface-1', targetId: 'target-1' }],
      });
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

  it('browser.session.start applies the selected partition to renderer browser surfaces', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '6',
      method: 'browser.session.start',
      params: { profile: 'login' },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.session.applyProfile', {
      partition: 'persist:wmux-login',
    });
  });
});
