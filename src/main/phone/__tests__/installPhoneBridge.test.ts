import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../../DaemonClient';
import { installPhoneBridge } from '../installPhoneBridge';

function fixture() {
  const client = Object.assign(new EventEmitter(), { rpc: vi.fn(async () => ({ ok: true })) });
  const handle = vi.fn(async () => ({ accounts: [] }));
  const dispose = installPhoneBridge(client as unknown as DaemonClient, handle);
  const event = { type: 'phone.request', data: { requestId: 'r1', command: 'accounts.list', payload: { workspaceId: 'ws-1' }, expiresAt: Date.now() + 10000 } };
  return { client, handle, dispose, event };
}
describe('desktop phone listener lifetime', () => {
  it('registers and handles a request once without retrying duplicate events', async () => {
    const { client, handle, dispose, event } = fixture();
    client.emit('event', event);
    client.emit('event', event);
    await Promise.resolve();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('daemon.phone.complete', { requestId: 'r1', ok: true, result: { accounts: [] } });
    // The desktop announces the optional commands it handles at register.
    expect(client.rpc).toHaveBeenCalledWith('daemon.phone.register', { commands: ['accounts.envForAccount', 'moa.wake', 'factory.message', 'workspaces.fleetTicket', 'workspaces.roomThreads', 'workspaces.roomCards', 'workspaces.botApproval', 'workspaces.botApprovalDecide', 'workspaces.bots', 'factory.threadMessage', 'factory.threadAttachments', 'workspaces.roomAttachment', 'workspaces.roomFile', 'workspaces.workerResume', 'workspaces.guestPost', 'workspaces.guestCards', 'browser.help', 'workspaces.browserHelpDecide', 'browser.chromePreview', 'agentEnv.summary'] });
    dispose();
    client.emit('event', { ...event, data: { ...event.data, requestId: 'r2' } });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('event')).toBe(0);
  });
  it('rejects expired and nonfinite deadlines before reaching the account writer', () => {
    const { client, handle, dispose, event } = fixture();
    for (const expiresAt of [0, NaN, Infinity]) client.emit('event', { ...event, data: { ...event.data, expiresAt } });
    expect(handle).not.toHaveBeenCalled();
    dispose();
  });
  it('answers a generic failure when a handler throws synchronously, without throwing out of the listener', async () => {
    const { client, handle, dispose, event } = fixture();
    handle.mockImplementationOnce(() => { throw new Error('invalid moa.wake payload'); });
    expect(() => client.emit('event', event)).not.toThrow();
    await Promise.resolve();
    expect(client.rpc).toHaveBeenCalledWith('daemon.phone.complete', { requestId: 'r1', ok: false });
    dispose();
  });
  it('returns only a generic failure when a local operation fails', async () => {
    const { client, handle, dispose, event } = fixture();
    handle.mockRejectedValueOnce(new Error('/private/account secret'));
    client.emit('event', event);
    await Promise.resolve();
    expect(client.rpc).toHaveBeenCalledWith('daemon.phone.complete', { requestId: 'r1', ok: false });
    dispose();
  });
});
describe('desktop phone listener with the browser stream', () => {
  it('announces browser.stream, hands it the stream commands, and stops its screencasts on disconnect and dispose', async () => {
    const client = Object.assign(new EventEmitter(), { rpc: vi.fn(async () => ({ ok: true })) });
    const handle = vi.fn(async () => ({ pages: [] }));
    const streams = { handle: vi.fn(async () => ({ backend: 'chrome' })), tab: vi.fn(() => null), stopAll: vi.fn() };
    const dispose = installPhoneBridge(client as unknown as DaemonClient, handle, streams);
    const register = client.rpc.mock.calls.find((c) => (c as unknown[])[0] === 'daemon.phone.register') as unknown as [string, { commands: string[] }];
    expect(register[1].commands).toContain('browser.stream');
    const request = (requestId: string, command: string) => ({ type: 'phone.request', data: { requestId, command, payload: { workspaceId: 'ws-1' }, expiresAt: Date.now() + 10000 } });
    client.emit('event', request('r1', 'browser.streamStart'));
    client.emit('event', request('r2', 'browser.capture'));
    await Promise.resolve();
    expect(streams.handle).toHaveBeenCalledWith('browser.streamStart', { workspaceId: 'ws-1' });
    expect(handle).toHaveBeenCalledWith('browser.capture', { workspaceId: 'ws-1' });
    expect(streams.handle).toHaveBeenCalledTimes(1);
    client.emit('disconnected');
    expect(streams.stopAll).toHaveBeenCalledTimes(1);
    dispose();
    expect(streams.stopAll).toHaveBeenCalledTimes(2);
    expect(client.listenerCount('disconnected')).toBe(0);
  });

  it('without a stream manager announces nothing new and routes as before', () => {
    const client = Object.assign(new EventEmitter(), { rpc: vi.fn(async () => ({ ok: true })) });
    const dispose = installPhoneBridge(client as unknown as DaemonClient, vi.fn(async () => ({})));
    const register = client.rpc.mock.calls.find((c) => (c as unknown[])[0] === 'daemon.phone.register') as unknown as [string, { commands: string[] }];
    expect(register[1].commands).not.toContain('browser.stream');
    dispose();
  });
});
