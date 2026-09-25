import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return { __handlers: handlers, ipcMain: { removeHandler: (name: string) => handlers.delete(name),
    handle: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn) } };
});
import * as electron from 'electron';
import { registerChatHandlers } from '../chat.handler';
import { CHAT_IPC } from '../../../../shared/transcript/chatIpc';
import type { DaemonClient } from '../../../DaemonClient';
const handlers = (electron as unknown as { __handlers: Map<string, (...args: any[]) => unknown> }).__handlers;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); });
function fixture(connected = true, lateWindow = false) {
  const client = Object.assign(new EventEmitter(), { isConnected: connected, rpc: vi.fn(async (method: string) => {
    if (method === 'daemon.approvals.list') return { pending: [] };
    if (method === 'daemon.transcript.status') return { available: true, reason: 'ok' };
    if (method === 'daemon.getAgentState') return { agentName: 'Claude Code', agentStatus: 'running' };
    return { ok: true, status: { available: true, reason: 'ok' } };
  }) });
  const wc = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: vi.fn() });
  const window = { webContents: wc } as unknown as Electron.BrowserWindow;
  let windowReady = !lateWindow;
  cleanup = registerChatHandlers(client as unknown as DaemonClient, () => windowReady ? window : null);
  const event = { sender: wc, senderFrame: wc.mainFrame };
  const call = (name: keyof typeof CHAT_IPC, ...args: unknown[]) => handlers.get(CHAT_IPC[name])!(event, ...args);
  return { client, wc, event, call, revealWindow: () => { windowReady = true; } };
}
describe('private desktop transcript bridge', () => {
  it('refuses model settings from untrusted frames or malformed choices before any RPC', async () => {
    const f=fixture(); f.client.rpc.mockClear();
    await handlers.get(CHAT_IPC.settings)!({ ...f.event, sender: {} }, {ptyId:'pane'});
    await f.call('settings',{ptyId:'pane',choice:{model:'model',effort:'low'}});
    expect(f.client.rpc).not.toHaveBeenCalled();
  });
  it('scopes skill lookup to a trusted pane and drops arbitrary filesystem fields', async () => {
    const f=fixture();
    await f.call('skills',{ptyId:'pane',agent:'codex',cwd:'/private',path:'/private'});
    expect(f.client.rpc).toHaveBeenCalledWith('daemon.chat.skills',{id:'pane',agent:'codex'},{timeoutMs:30000});
    f.client.rpc.mockClear();
    await f.call('skills',{ptyId:'pane',agent:'shell'});
    expect(f.client.rpc).not.toHaveBeenCalled();
  });
  it('limits terminal launch to first-party callers and fixed agent choices', async () => {
    const f = fixture();
    await f.call('launchTerminal', { ptyId: 'pane', agent: 'codex', prompt: 'hello' });
    expect(f.client.rpc).toHaveBeenCalledWith('daemon.chat.launchTerminal', { id: 'pane', agent: 'codex', prompt: 'hello' }, { timeoutMs: 30000 });
    f.client.rpc.mockClear();
    await f.call('launchTerminal', { ptyId: 'pane', agent: 'sh', prompt: 'hello' });
    await handlers.get(CHAT_IPC.launchTerminal)!({ ...f.event, sender: {} }, { ptyId: 'pane', agent: 'claude', prompt: 'hello' });
    expect(f.client.rpc).not.toHaveBeenCalled();
  });
  it('forwards explicit launch mode and refuses another provider mode', async () => {
    const f = fixture();
    await f.call('launchTerminal', { ptyId: 'pane', agent: 'codex', prompt: 'hello', mode: 'yolo' });
    expect(f.client.rpc).toHaveBeenCalledWith('daemon.chat.launchTerminal', { id: 'pane', agent: 'codex', prompt: 'hello', mode: 'yolo' }, { timeoutMs: 30000 });
    f.client.rpc.mockClear();
    await f.call('launchTerminal', { ptyId: 'pane', agent: 'claude', prompt: 'hello', mode: 'yolo' });
    expect(f.client.rpc).not.toHaveBeenCalled();
  });
  it('reports live activity separately from readable saved history', async () => {
    const f = fixture();
    expect(await f.call('status', 'pty')).toMatchObject({ available: true, agentAlive: true, agentStatus: 'running' });
    f.client.rpc.mockImplementation(async (method: string) => method === 'daemon.getAgentState'
      ? { agentName: null, agentStatus: 'idle' } : { available: true, reason: 'ok' } as any);
    expect(await f.call('status', 'pty')).toMatchObject({ available: true, agentAlive: false, agentStatus: 'idle' });
  });
  it('refuses webviews and subframes before consulting the daemon', async () => {
    const f = fixture();
    const status = handlers.get(CHAT_IPC.status)!;
    expect(await status({ ...f.event, sender: {} }, 'pty')).toEqual({ available: false, reason: 'unavailable' });
    expect(await status({ ...f.event, senderFrame: {} }, 'pty')).toEqual({ available: false, reason: 'unavailable' });
    expect(f.client.rpc).not.toHaveBeenCalled();
  });
  it('forwards only subscribed transcript events and reference-counts duplicate views', async () => {
    const f = fixture(); await f.call('subscribe', 'pty'); await f.call('subscribe', 'pty');
    f.client.emit('event', { type: 'transcript.appended', sessionId: 'other', data: {} });
    expect(f.wc.send).not.toHaveBeenCalled();
    f.client.emit('event', { type: 'transcript.appended', sessionId: 'pty', data: { seq: 1 } });
    expect(f.wc.send).toHaveBeenCalledWith(CHAT_IPC.append, 'pty', { seq: 1 });
    await f.call('unsubscribe', 'pty');
    expect(f.client.rpc.mock.calls.some(([method]) => method === 'daemon.transcript.unsubscribe')).toBe(false);
    await f.call('unsubscribe', 'pty');
    expect(f.client.rpc).toHaveBeenCalledWith('daemon.transcript.unsubscribe', { id: 'pty' });
  });
  it('releases subscriptions on reload and removes listeners/handlers on teardown', async () => {
    const f = fixture(); await f.call('subscribe', 'pty');
    f.wc.emit('did-start-navigation', {}, 'url', false, true);
    expect(f.client.rpc).toHaveBeenCalledWith('daemon.transcript.unsubscribe', { id: 'pty' });
    f.client.emit('event', { type: 'transcript.appended', sessionId: 'pty', data: {} });
    expect(f.wc.send).not.toHaveBeenCalled();
    cleanup!(); cleanup = undefined;
    expect(handlers.size).toBe(0); expect(f.client.listenerCount('event')).toBe(0);
  });
  it('fails closed when the daemon is disconnected, including approval state', async () => {
    const f = fixture(false);
    expect(await f.call('openGates')).toBeNull();
    expect(await f.call('snapshot', 'pty')).toBeNull();
    expect(await f.call('send', { ptyId: 'pty', agentSessionId: 'session', text: 'hello' })).toEqual({ result: 'error' });
    expect(f.client.rpc).not.toHaveBeenCalled();
  });
  it('attaches cleanup when the application window is created after handler registration', async () => {
    const f = fixture(true, true);
    expect(f.wc.listenerCount('did-start-navigation')).toBe(0);
    f.revealWindow(); await f.call('subscribe', 'pty');
    expect(f.wc.listenerCount('did-start-navigation')).toBe(1);
    f.wc.emit('did-start-navigation', { isMainFrame: true });
    expect(f.client.rpc).toHaveBeenCalledWith('daemon.transcript.unsubscribe', { id: 'pty' });
  });
  it('validates handles and forwards identity-bound input only through the private method', async () => {
    const f = fixture();
    expect(await f.call('codeBlock', { ptyId: 'pty', n: -1, srcOffset: 0 })).toBeNull();
    expect(await f.call('snapshot', 'pty', -1)).toBeNull();
    expect(await f.call('send', { ptyId: 'pty', agentSessionId: 's', text: 'x'.repeat(16001) })).toEqual({ result: 'unavailable' });
    expect(f.client.rpc).not.toHaveBeenCalled();
    await f.call('send', { ptyId: 'pty', agentSessionId: 's', text: 'hello' });
    expect(f.client.rpc).toHaveBeenCalledWith('daemon.transcript.send', { id: 'pty', agentSessionId: 's', text: 'hello' });
  });
  it('forwards Stop and image paths only in their validated shape', async () => {
    const f = fixture();
    await f.call('interrupt', { ptyId: 'pty', agentSessionId: 's', key: '\x03' });
    expect(f.client.rpc).toHaveBeenCalledWith('daemon.transcript.interrupt', { id: 'pty', agentSessionId: 's' });
    f.client.rpc.mockClear();
    for (const attachments of [['relative.png'], ['/tmp/a.txt'], ['/tmp/a\n.png'], Array(6).fill('/tmp/a.png'), '/tmp/a.png']) {
      expect(await f.call('send', { ptyId: 'pty', agentSessionId: 's', text: 'look', attachments })).toEqual({ result: 'unavailable' });
    }
    expect(await handlers.get(CHAT_IPC.interrupt)!({ ...f.event, sender: {} }, { ptyId: 'pty', agentSessionId: 's' })).toEqual({ result: 'unavailable' });
    expect(f.client.rpc).not.toHaveBeenCalled();
    await f.call('send', { ptyId: 'pty', agentSessionId: 's', text: 'look', attachments: ['/tmp/shot one.PNG'] });
    expect(f.client.rpc).toHaveBeenCalledWith('daemon.transcript.send', { id: 'pty', agentSessionId: 's', text: 'look', attachments: ['/tmp/shot one.PNG'] });
  });
});
