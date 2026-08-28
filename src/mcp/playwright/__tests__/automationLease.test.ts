import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { withAutomationLease } from '../automationLease';

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

beforeEach(() => {
  mockSendRpc.mockReset();
  deps.resolveWorkspaceId.mockReset();
  deps.resolveWorkspaceId.mockResolvedValue('ws-test');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('automation lease workspace scope', () => {
  it('resolves identity once and reuses it for acquire and the tool body', async () => {
    mockSendRpc.mockImplementation((method: string) =>
      Promise.resolve(method === 'browser.lease.acquire' ? { token: 'lease-1' } : {}),
    );
    const body = vi.fn(async () => 'done');

    await expect(withAutomationLease(deps, 'surface-1', body)).resolves.toBe('done');

    expect(deps.resolveWorkspaceId).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledWith({ workspaceId: 'ws-test', surfaceId: 'surface-1' });
    expect(mockSendRpc.mock.calls).toEqual([
      ['browser.lease.acquire', { workspaceId: 'ws-test', surfaceId: 'surface-1' }],
      // Lifecycle drains ride inside the lease bracket: pre-drain before the
      // body, post-drain after it (attributing the body's own events).
      ['browser.lifecycle.get', { workspaceId: 'ws-test', surfaceId: 'surface-1' }],
      ['browser.lifecycle.get', { workspaceId: 'ws-test', surfaceId: 'surface-1' }],
      ['browser.lease.release', { token: 'lease-1' }],
    ]);
  });

  it('runs the body between the two drains, and the post-drain before release', async () => {
    const order: string[] = [];
    mockSendRpc.mockImplementation((method: string) => {
      order.push(method);
      return Promise.resolve(method === 'browser.lease.acquire' ? { token: 'lease-1' } : {});
    });
    const body = vi.fn(async () => {
      order.push('BODY');
      return 'done';
    });

    await withAutomationLease(deps, 'surface-1', body);

    expect(order).toEqual([
      'browser.lease.acquire',
      'browser.lifecycle.get', // pre-drain
      'BODY',
      'browser.lifecycle.get', // post-drain — still inside the lease bracket
      'browser.lease.release',
    ]);
  });

  it('fails closed before lease or body execution when identity is unavailable', async () => {
    deps.resolveWorkspaceId.mockRejectedValue(new Error('Workspace identity unknown.'));
    const body = vi.fn(async () => 'must not run');

    await expect(withAutomationLease(deps, undefined, body)).rejects.toThrow(
      'Workspace identity unknown.',
    );

    expect(mockSendRpc).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
  });

  it('includes the same workspaceId in every late-acquire retry', async () => {
    vi.useFakeTimers();
    let acquireCount = 0;
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.lease.acquire') {
        acquireCount++;
        return Promise.resolve({ token: acquireCount === 1 ? null : 'lease-late' });
      }
      return Promise.resolve({});
    });

    let finishBody!: () => void;
    const bodyDone = new Promise<void>((resolve) => { finishBody = resolve; });
    const operation = withAutomationLease(deps, undefined, async () => {
      await bodyDone;
      return 'done';
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockSendRpc.mock.calls.filter(([method]) => method === 'browser.lease.acquire')).toEqual([
      ['browser.lease.acquire', { workspaceId: 'ws-test' }],
      ['browser.lease.acquire', { workspaceId: 'ws-test' }],
    ]);

    finishBody();
    await expect(operation).resolves.toBe('done');
    expect(mockSendRpc).toHaveBeenCalledWith('browser.lease.release', { token: 'lease-late' });
  });
});
