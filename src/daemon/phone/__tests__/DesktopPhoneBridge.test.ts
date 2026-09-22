import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopPhoneBridge } from '../DesktopPhoneBridge';

afterEach(() => vi.useRealTimers());
describe('desktop phone request ownership', () => {
  it('accepts only the registered owner and consumes a receipt once', async () => {
    const send = vi.fn(() => true);
    const bridge = new DesktopPhoneBridge(send);
    expect(bridge.register('main')).toBe(true);
    expect(bridge.register('other')).toBe(false);
    const pending = bridge.request('accounts.list', { workspaceId: 'ws-1' });
    const event = send.mock.calls[0] as unknown as [string, { data: { requestId: string } }];
    const response = { requestId: event[1].data.requestId, ok: true, result: { accounts: [] } };
    expect(bridge.complete('other', response)).toBe(false);
    expect(bridge.complete('main', response)).toBe(true);
    expect(bridge.complete('main', response)).toBe(false);
    await expect(pending).resolves.toEqual({ accounts: [] });
  });
  it('rejects pending requests on owner disconnect and permits a replacement', async () => {
    const bridge = new DesktopPhoneBridge(() => true);
    bridge.register('main');
    const pending = bridge.request('accounts.bind', {});
    const rejected = expect(pending).rejects.toThrow('desktop-disconnected');
    bridge.disconnect('other');
    expect(bridge.available).toBe(true);
    bridge.disconnect('main');
    await rejected;
    expect(bridge.available).toBe(false);
    expect(bridge.register('replacement')).toBe(true);
  });
  it('bounds concurrency and expires requests without retries', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => true);
    const bridge = new DesktopPhoneBridge(send, 100);
    bridge.register('main');
    const requests = Array.from({ length: 16 }, () => bridge.request('accounts.list', {}).catch(e => e.message));
    await expect(bridge.request('accounts.list', {})).rejects.toThrow('desktop-busy');
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all(requests)).toEqual(Array(16).fill('desktop-timeout'));
    expect(send).toHaveBeenCalledTimes(16);
  });
  it('fails closed without a desktop owner', async () => {
    await expect(new DesktopPhoneBridge(() => true).request('accounts.list', {})).rejects.toThrow('desktop-unavailable');
  });
});
