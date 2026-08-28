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
      // Lifecycle drain rides inside the lease bracket, before the body.
      ['browser.lifecycle.get', { workspaceId: 'ws-test', surfaceId: 'surface-1' }],
      ['browser.lease.release', { token: 'lease-1' }],
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
