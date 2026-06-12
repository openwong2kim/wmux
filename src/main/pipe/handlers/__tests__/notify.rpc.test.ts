import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks — vi.mock factories are hoisted above the imports below.
const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  toastManagerShow: vi.fn(),
}));

vi.mock('electron', () => ({}));

vi.mock('../../../notification/sendNotification', () => ({
  sendNotification: mocks.sendNotification,
}));

vi.mock('../../../notification/ToastManager', () => ({
  ToastManager: class { show = mocks.toastManagerShow; },
}));

import { RpcRouter } from '../../RpcRouter';
import { registerNotifyRpc } from '../notify.rpc';

function setupRouter() {
  const router = new RpcRouter();
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  registerNotifyRpc(router, () => win as never);
  return { router, win };
}

describe('notify.rpc', () => {
  beforeEach(() => {
    mocks.sendNotification.mockReset();
    mocks.toastManagerShow.mockReset();
  });

  it('rejects when title is missing', async () => {
    const { router } = setupRouter();
    const res = await router.dispatch({ id: '1', method: 'notify', params: { body: 'b' } });
    expect(res.ok).toBe(false);
  });

  it('rejects when body is missing', async () => {
    const { router } = setupRouter();
    const res = await router.dispatch({ id: '2', method: 'notify', params: { title: 't' } });
    expect(res.ok).toBe(false);
  });

  it('REGRESSION (R6): workspaceId is OPTIONAL — CLI without workspaceId still succeeds', () => {
    // Backward compat for `wmux notify --title X --body Y` from the CLI:
    // before this fix, requiring workspaceId would break every CLI call.
    return setupRouter().router.dispatch({
      id: '3', method: 'notify', params: { title: 't', body: 'b' },
    }).then((res) => {
      expect(res.ok).toBe(true);
      expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
      const [, ptyId, payload] = mocks.sendNotification.mock.calls[0];
      expect(ptyId).toBeNull();
      expect(payload).toMatchObject({ title: 't', body: 'b', type: 'info' });
      expect(payload.workspaceId).toBeUndefined();
    });
  });

  it('forwards workspaceId when provided (MCP path with precise routing)', async () => {
    const { router } = setupRouter();
    const res = await router.dispatch({
      id: '4', method: 'notify',
      params: { title: 't', body: 'b', type: 'agent', workspaceId: 'ws-7' },
    });
    expect(res.ok).toBe(true);
    const [, ptyId, payload] = mocks.sendNotification.mock.calls[0];
    expect(ptyId).toBeNull();
    expect(payload).toMatchObject({ title: 't', body: 'b', type: 'agent', workspaceId: 'ws-7' });
  });

  it('falls back to "info" type when type is missing or invalid', async () => {
    const { router } = setupRouter();
    await router.dispatch({ id: '5', method: 'notify', params: { title: 't', body: 'b', type: 'unknown' } });
    const [, , payload] = mocks.sendNotification.mock.calls[0];
    expect(payload.type).toBe('info');
  });

  it('always invokes the OS toast manager (focus gate is internal to ToastManager)', async () => {
    const { router } = setupRouter();
    await router.dispatch({ id: '6', method: 'notify', params: { title: 't', body: 'b' } });
    // Third arg is the X2 click-to-jump context. With no workspaceId in the
    // request it carries undefined — ToastManager treats that as "click only
    // focuses the window" (legacy behavior).
    expect(mocks.toastManagerShow).toHaveBeenCalledWith('t', 'b', { workspaceId: undefined });
  });

  it('passes workspaceId to the toast click context when provided (X2 pane jump)', async () => {
    const { router } = setupRouter();
    await router.dispatch({
      id: '7', method: 'notify',
      params: { title: 't', body: 'b', workspaceId: 'ws-7' },
    });
    expect(mocks.toastManagerShow).toHaveBeenCalledWith('t', 'b', { workspaceId: 'ws-7' });
  });
});
