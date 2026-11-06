import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewCdpManager } from '../WebviewCdpManager';

const mockWebContents = {
  debugger: { on: vi.fn(), attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
  isDestroyed: vi.fn(() => false),
  on: vi.fn(),
  getURL: vi.fn(() => 'https://example.com'),
  getTitle: vi.fn(() => 'Example Page'),
  setBackgroundThrottling: vi.fn(),
  stop: vi.fn(),
};

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => mockWebContents) },
}));

describe('WebviewCdpManager — agent activity and Stop', () => {
  let manager: WebviewCdpManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new WebviewCdpManager(0);
    await manager.register('s1', 42, 'ws-1');
  });

  it('reports every lease count change to the observer', () => {
    const seen: Array<[string, number]> = [];
    manager.setLeaseObserver((surfaceId, leases) => seen.push([surfaceId, leases]));
    const a = manager.acquireRpcLease('s1');
    const b = manager.acquireRpcLease('s1');
    manager.releaseRpcLease(a);
    manager.releaseRpcLease(b);
    expect(seen).toEqual([['s1', 1], ['s1', 2], ['s1', 1], ['s1', 0]]);
  });

  it('revoking ends the surface\'s RPC leases and tells their holder why', async () => {
    const seen: number[] = [];
    manager.setLeaseObserver((_s, leases) => seen.push(leases));
    const token = manager.acquireRpcLease('s1');
    const other = manager.acquireRpcLease('s1');
    const parked = manager.watchRpcLease(token, 60_000);

    const why = new Error('BROWSER_AGENT_PAUSED: stopped');
    expect(manager.revokeRpcLeases('s1', why)).toBe(2);

    // The parked renew wakes at once rather than at its timeout.
    await parked;
    expect(manager.rpcLeaseRevocation(token)).toBe(why);
    expect(manager.rpcLeaseRevocation(other)).toBe(why);
    expect(manager.renewRpcLease(token)).toBe(false);
    expect(seen.at(-1)).toBe(0);

    // The holder's own release still clears the record.
    expect(manager.releaseRpcLease(token)).toBe(false);
    expect(manager.rpcLeaseRevocation(token)).toBeUndefined();
  });

  it('leaves other surfaces\' leases alone', async () => {
    await manager.register('s2', 43, 'ws-1');
    const keep = manager.acquireRpcLease('s2');
    manager.revokeRpcLeases('s1', new Error('x'));
    expect(manager.renewRpcLease(keep)).toBe(true);
    expect(manager.rpcLeaseRevocation(keep)).toBeUndefined();
  });

  it('a parked watch also wakes on an ordinary release, and returns at once for no lease', async () => {
    const token = manager.acquireRpcLease('s1');
    const parked = manager.watchRpcLease(token, 60_000);
    manager.releaseRpcLease(token);
    await parked;
    await expect(manager.watchRpcLease('lease-unknown', 60_000)).resolves.toBeUndefined();
  });

  it('stopLoading stops the guest\'s navigation', () => {
    expect(manager.stopLoading('s1')).toBe(true);
    expect(mockWebContents.stop).toHaveBeenCalledTimes(1);
    expect(manager.stopLoading('missing')).toBe(false);
  });
});
