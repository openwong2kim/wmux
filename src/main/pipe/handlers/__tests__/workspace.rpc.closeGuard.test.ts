// workspace.close refuses the caller's own workspace unless `force` is set.
// An orchestrating agent read a fan-out accept's owner workspace id as a
// task's and closed the workspace it was running in, with every agent inside.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerWorkspaceRpc } from '../workspace.rpc';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;
const owners: Record<string, string> = { 'daemon-own': 'ws-own' };

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerWorkspaceRpc(router, () => fakeWindow, {
    getHqWorkspaceId: () => 'ws-hq',
    resolveCallerWorkspace: async (pty) => owners[pty] ?? null,
  });
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendToRendererMock.mockResolvedValue({ ok: true });
});

describe('workspace.close — the caller’s own workspace', () => {
  it('is refused without force, before reaching the renderer', async () => {
    const res = await setup().dispatch({ id: 'c1', method: 'workspace.close', params: { id: 'ws-own', senderPtyId: 'daemon-own' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/workspace this call comes from/);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('goes through with force, and force reaches the renderer', async () => {
    const res = await setup().dispatch({ id: 'c3', method: 'workspace.close', params: { id: 'ws-own', senderPtyId: 'daemon-own', force: true } });
    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.anything(), 'workspace.close', { id: 'ws-own', force: true });
  });

  it('another workspace closes as before; an unresolvable pty skips the check', async () => {
    let res = await setup().dispatch({ id: 'c4', method: 'workspace.close', params: { id: 'ws-other', senderPtyId: 'daemon-own' } });
    expect(res.ok).toBe(true);
    res = await setup().dispatch({ id: 'c5', method: 'workspace.close', params: { id: 'ws-own', senderPtyId: 'daemon-gone' } });
    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenLastCalledWith(expect.anything(), 'workspace.close', { id: 'ws-own' });
  });

  it('force never lifts the HQ refusal', async () => {
    const res = await setup().dispatch({ id: 'c6', method: 'workspace.close', params: { id: 'ws-hq', force: true } });
    expect(res.ok).toBe(false);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });
});
