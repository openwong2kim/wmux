import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return { __handlers: handlers, ipcMain: { removeHandler: (name: string) => handlers.delete(name),
    handle: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn) } };
});
import * as electron from 'electron';
import { registerChatV2Handlers, stageChatV2Attachment } from '../chatv2.handler';
import { CHATV2_IPC, CHATV2_RPC, type ChatV2Method } from '../../../../shared/chatv2/ipc';
import type { DaemonClient } from '../../../DaemonClient';

const handlers = (electron as unknown as { __handlers: Map<string, (...args: any[]) => unknown> }).__handlers;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function fixture() {
  const client = Object.assign(new EventEmitter(), { isConnected: true, rpc: vi.fn(async (..._args: unknown[]) => ({ ok: true, binding: null })) });
  const wc = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: vi.fn() });
  const window = { webContents: wc } as unknown as Electron.BrowserWindow;
  cleanup = registerChatV2Handlers(client as unknown as DaemonClient, () => window);
  const event = { sender: wc, senderFrame: wc.mainFrame };
  const call = (method: ChatV2Method, params: unknown) => handlers.get(CHATV2_IPC[method])!(event, params);
  const push = (paneId: string) => client.emit('event', { type: 'chatv2.events', sessionId: paneId, data: { paneId, events: [] } });
  return { client, wc, event, call, push, register: () => registerChatV2Handlers(client as unknown as DaemonClient, () => window) };
}

describe('chat v2 IPC bridge', () => {
  it('refuses untrusted frames and invalid params before any RPC, and forwards only parsed fields', async () => {
    const f = fixture();
    expect(await handlers.get(CHATV2_IPC.create)!({ ...f.event, senderFrame: {} }, { paneId: 'p', agent: 'claude', mode: 'default' }))
      .toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await f.call('create', { paneId: 'p', agent: 'shell', mode: 'default' })).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(f.client.rpc).not.toHaveBeenCalled();
    await f.call('create', { paneId: 'p', agent: 'claude', mode: 'bypass', cwd: '/etc', argv: ['x'] });
    expect(f.client.rpc).toHaveBeenCalledWith(CHATV2_RPC.create, { paneId: 'p', agent: 'claude', mode: 'bypass' }, { timeoutMs: 30_000 });
  });

  it('forwards pushes only for subscribed panes, counting views per pane', async () => {
    const f = fixture();
    f.push('p1');
    expect(f.wc.send).not.toHaveBeenCalled();
    await f.call('subscribe', { paneId: 'p1' });
    await f.call('subscribe', { paneId: 'p1' });
    f.push('p1');
    f.push('p2');
    expect(f.wc.send).toHaveBeenCalledTimes(1);
    expect(f.wc.send).toHaveBeenCalledWith(CHATV2_IPC.events, { paneId: 'p1', events: [] });
    await f.call('unsubscribe', { paneId: 'p1' });
    expect(f.client.rpc).not.toHaveBeenCalledWith(CHATV2_RPC.unsubscribe, expect.anything(), expect.anything());
    await f.call('unsubscribe', { paneId: 'p1' });
    expect(f.client.rpc).toHaveBeenCalledWith(CHATV2_RPC.unsubscribe, { paneId: 'p1' }, { timeoutMs: 30_000 });
    f.push('p1');
    expect(f.wc.send).toHaveBeenCalledTimes(1);
  });

  it('subscribes again and asks the renderer to re-snapshot after a daemon reconnect', async () => {
    const f = fixture();
    await f.call('subscribe', { paneId: 'p1' });
    cleanup?.();
    f.client.rpc.mockClear();
    cleanup = f.register();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.client.rpc).toHaveBeenCalledWith(CHATV2_RPC.subscribe, { paneId: 'p1' });
    expect(f.wc.send).toHaveBeenCalledWith(CHATV2_IPC.resync, { paneIds: ['p1'] });
    // A reload drops the set.
    f.wc.emit('did-start-navigation', { isMainFrame: true });
    f.push('p1');
    expect(f.wc.send).toHaveBeenCalledTimes(1);
  });

  it('stages only image files into the attachment directory, private to the user', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatv2-stage-'));
    const image = path.join(dir, 'shot.PNG');
    fs.writeFileSync(image, 'png');
    const staged = await stageChatV2Attachment(image, dir);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(path.dirname(staged.path)).toBe(path.join(dir, 'chatv2-attachments'));
    expect(staged.path.endsWith('.png')).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(staged.path).mode & 0o777).toBe(0o600);
    expect(await stageChatV2Attachment(path.join(dir, 'notes.txt'), dir)).toEqual({ ok: false, reason: 'not-image' });
    expect(await stageChatV2Attachment('relative.png', dir)).toEqual({ ok: false, reason: 'missing' });
  });
});
