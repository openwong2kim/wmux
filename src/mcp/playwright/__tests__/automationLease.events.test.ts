import { beforeEach, describe, expect, it, vi } from 'vitest';

// Inline lifecycle events (Phase 1): withAutomationLease drains
// browser.lifecycle.get before the tool body, prepends drained events to a
// content-shaped result, and invalidates the snapshot baseline on
// navigated/closed. Mock idiom follows automationLease.test.ts.

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { withAutomationLease } from '../automationLease';
import { getSnapshotBaseline, setSnapshotBaseline, snapshotSurfaceKey } from '../snapshotCache';

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function rpcRouter(lifecycleEntries: unknown) {
  return (method: string) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
    if (method === 'browser.lifecycle.get') {
      return lifecycleEntries instanceof Error
        ? Promise.reject(lifecycleEntries)
        : Promise.resolve({ entries: lifecycleEntries });
    }
    return Promise.resolve({});
  };
}

beforeEach(() => {
  mockSendRpc.mockReset();
  deps.resolveWorkspaceId.mockReset();
  deps.resolveWorkspaceId.mockResolvedValue('ws-test');
});

describe('withAutomationLease lifecycle injection', () => {
  it('prepends drained events to a content-shaped result', async () => {
    mockSendRpc.mockImplementation(
      rpcRouter([{ type: 'navigated', url: 'https://a.test/', ts: Date.now() - 3000 }]),
    );
    const body = vi.fn(async () => ({
      content: [{ type: 'text', text: 'tool output' }],
    }));

    const result = await withAutomationLease(deps, 's1', body);

    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain('[browser events since last tool call]');
    expect(result.content[0].text).toContain('navigated: https://a.test/');
    expect(result.content[1].text).toBe('tool output');
  });

  it('leaves non-content results and drain failures untouched', async () => {
    mockSendRpc.mockImplementation(rpcRouter(new Error('unknown method')));
    const plain = await withAutomationLease(deps, 's1', async () => 'plain-string');
    expect(plain).toBe('plain-string');

    mockSendRpc.mockImplementation(
      rpcRouter([{ type: 'loaded', ts: Date.now() }]),
    );
    const nonContent = await withAutomationLease(deps, 's1', async () => ({ value: 1 }));
    expect(nonContent).toEqual({ value: 1 });
  });

  it('invalidates the snapshot baseline on a navigated event', async () => {
    const key = snapshotSurfaceKey('ws-test', 's1');
    setSnapshotBaseline(key, 'ai||', 'old snapshot');
    expect(getSnapshotBaseline(key, 'ai||')).not.toBeNull();

    mockSendRpc.mockImplementation(
      rpcRouter([{ type: 'navigated', url: 'https://b.test/', ts: Date.now() }]),
    );
    await withAutomationLease(deps, 's1', async () => ({ content: [] }));

    expect(getSnapshotBaseline(key, 'ai||')).toBeNull();
  });

  it('a loaded-only drain does not invalidate the baseline', async () => {
    const key = snapshotSurfaceKey('ws-test', 's1');
    setSnapshotBaseline(key, 'ai||', 'old snapshot');

    mockSendRpc.mockImplementation(rpcRouter([{ type: 'loaded', ts: Date.now() }]));
    await withAutomationLease(deps, 's1', async () => ({ content: [] }));

    expect(getSnapshotBaseline(key, 'ai||')).not.toBeNull();
  });
});
