import { describe, it, expect, vi } from 'vitest';
import { sendNotification } from '../sendNotification';
import { IPC } from '../../../shared/constants';

function makeWindow(isDestroyed = false) {
  return {
    isDestroyed: () => isDestroyed,
    webContents: { send: vi.fn() },
  };
}

describe('sendNotification', () => {
  it('no-op when window is null', () => {
    // Should not throw and should not invoke any send
    expect(() => sendNotification(null, 'p1', { title: 't', body: 'b', type: 'info' })).not.toThrow();
  });

  it('no-op when window is destroyed', () => {
    const win = makeWindow(true);
    sendNotification(win as never, 'p1', { title: 't', body: 'b', type: 'info' });
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('sends (channel, ptyId, payload) when ptyId is a string', () => {
    const win = makeWindow();
    sendNotification(win as never, 'pty-1', { title: 't', body: 'b', type: 'agent' });
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.NOTIFICATION, 'pty-1', {
      title: 't', body: 'b', type: 'agent',
    });
  });

  it('sends with ptyId=null for app-level / RPC notifications', () => {
    const win = makeWindow();
    sendNotification(win as never, null, { title: 't', body: 'b', type: 'info', workspaceId: 'ws-9' });
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.NOTIFICATION, null, {
      title: 't', body: 'b', type: 'info', workspaceId: 'ws-9',
    });
  });
});
