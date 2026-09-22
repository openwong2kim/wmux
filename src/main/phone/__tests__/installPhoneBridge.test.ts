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
  it('returns only a generic failure when a local operation fails', async () => {
    const { client, handle, dispose, event } = fixture();
    handle.mockRejectedValueOnce(new Error('/private/account secret'));
    client.emit('event', event);
    await Promise.resolve();
    expect(client.rpc).toHaveBeenCalledWith('daemon.phone.complete', { requestId: 'r1', ok: false });
    dispose();
  });
});
