import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerSurfaceRpc } from '../surface.rpc';

const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

function register(): RpcRouter {
  const router = new RpcRouter();
  registerSurfaceRpc(router, (() => null) as () => BrowserWindow | null);
  return router;
}

describe('surface.rpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendToRendererMock.mockResolvedValue({ ok: true });
  });

  it('forwards workspaceId, shell, and cwd to the renderer when creating a surface', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '1',
      method: 'surface.new',
      params: {
        workspaceId: 'ws-caller',
        shell: 'powershell.exe',
        cwd: 'C:\\Users\\LORD',
      },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'surface.new',
      {
        workspaceId: 'ws-caller',
        shell: 'powershell.exe',
        cwd: 'C:\\Users\\LORD',
      },
    );
  });
});
