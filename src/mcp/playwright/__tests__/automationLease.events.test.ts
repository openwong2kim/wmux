import { beforeEach, describe, expect, it, vi } from 'vitest';

// Inline lifecycle events: withAutomationLease drains browser.lifecycle.get
// twice per op — before the tool body (events from between calls, capture
// warm-up) and after it (events the body itself caused) — merges both into
// one prepended block, and manages the snapshot baseline (unconditional
// invalidate on pre-drain navigated/closed, conditional on post-drain).
// The mock router models the real ring's DESTRUCTIVE drain with a closure
// queue: each lifecycle.get empties it. Mock idiom follows
// automationLease.test.ts.

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { withAutomationLease } from '../automationLease';
import { getSnapshotBaseline, setSnapshotBaseline, snapshotSurfaceKey } from '../snapshotCache';

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

/** Destructive-drain router: lifecycle.get returns the queued entries once. */
function queueRouter(queue: unknown[], drainError?: Error) {
  return (method: string) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
    if (method === 'browser.lifecycle.get') {
      if (drainError) return Promise.reject(drainError);
      return Promise.resolve({ entries: queue.splice(0) });
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
    const queue: unknown[] = [{ type: 'navigated', url: 'https://a.test/', ts: Date.now() - 3000 }];
    mockSendRpc.mockImplementation(queueRouter(queue));
    const body = vi.fn(async () => ({
      content: [{ type: 'text', text: 'tool output' }],
    }));

    const result = await withAutomationLease(deps, 's1', body);

    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain('[browser events]');
    expect(result.content[0].text).toContain('navigated: https://a.test/');
    expect(result.content[1].text).toBe('tool output');
  });

  it('leaves non-content results and drain failures untouched', async () => {
    mockSendRpc.mockImplementation(queueRouter([], new Error('unknown method')));
    const plain = await withAutomationLease(deps, 's1', async () => 'plain-string');
    expect(plain).toBe('plain-string');

    mockSendRpc.mockImplementation(queueRouter([{ type: 'loaded', ts: Date.now() }]));
    const nonContent = await withAutomationLease(deps, 's1', async () => ({ value: 1 }));
    expect(nonContent).toEqual({ value: 1 });
  });

  it('invalidates the snapshot baseline on a navigated event', async () => {
    const key = snapshotSurfaceKey('ws-test', 's1');
    setSnapshotBaseline(key, 'ai||', 'old snapshot');
    expect(getSnapshotBaseline(key, 'ai||')).not.toBeNull();

    mockSendRpc.mockImplementation(
      queueRouter([{ type: 'navigated', url: 'https://b.test/', ts: Date.now() }]),
    );
    await withAutomationLease(deps, 's1', async () => ({ content: [] }));

    expect(getSnapshotBaseline(key, 'ai||')).toBeNull();
  });

  it('a loaded-only drain does not invalidate the baseline', async () => {
    const key = snapshotSurfaceKey('ws-test', 's1');
    setSnapshotBaseline(key, 'ai||', 'old snapshot');

    mockSendRpc.mockImplementation(queueRouter([{ type: 'loaded', ts: Date.now() }]));
    await withAutomationLease(deps, 's1', async () => ({ content: [] }));

    expect(getSnapshotBaseline(key, 'ai||')).not.toBeNull();
  });

  // -- dual drain (#1063 follow-up): events the body caused land on THIS
  //    result, not the next call's ------------------------------------------

  it('attributes events produced during the body to the same result', async () => {
    const queue: unknown[] = [];
    mockSendRpc.mockImplementation(queueRouter(queue));
    const body = vi.fn(async () => {
      // e.g. a click that triggered a navigation while the body ran
      queue.push({ type: 'navigated', url: 'https://during.test/', ts: Date.now() });
      return { content: [{ type: 'text', text: 'clicked' }] };
    });

    const result = await withAutomationLease(deps, 's1', body);

    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain('navigated: https://during.test/');
    expect(result.content[1].text).toBe('clicked');
  });

  it('merges pre- and post-body events into one block, pre first', async () => {
    const queue: unknown[] = [{ type: 'navigated', url: 'https://before.test/', ts: Date.now() - 5000 }];
    mockSendRpc.mockImplementation(queueRouter(queue));
    const body = async () => {
      queue.push({ type: 'navigated', url: 'https://during.test/', ts: Date.now() });
      return { content: [{ type: 'text', text: 'out' }] };
    };

    const result = await withAutomationLease(deps, 's1', body);

    expect(result.content).toHaveLength(2);
    const block = result.content[0].text as string;
    expect(block.indexOf('https://before.test/')).toBeGreaterThan(-1);
    expect(block.indexOf('https://before.test/')).toBeLessThan(block.indexOf('https://during.test/'));
  });

  it('suppresses the trailing self-echo navigated the tool already reports', async () => {
    const queue: unknown[] = [];
    mockSendRpc.mockImplementation(queueRouter(queue));
    const body = async () => {
      queue.push({ type: 'navigated', url: 'https://target.test/', ts: Date.now() });
      return { content: [{ type: 'text', text: 'Navigated to https://target.test/' }] };
    };

    const result = await withAutomationLease(deps, 's1', body, {
      redundantNavigationUrl: () => 'https://target.test/',
    });

    // The lone self-echo is dropped — no events block at all.
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('Navigated to https://target.test/');
  });

  it('keeps a redirect chain visible: only the final self-echo is dropped', async () => {
    const queue: unknown[] = [];
    mockSendRpc.mockImplementation(queueRouter(queue));
    const body = async () => {
      queue.push({ type: 'navigated', url: 'https://requested.test/', ts: Date.now() });
      queue.push({ type: 'navigated', url: 'https://final.test/', ts: Date.now() });
      return { content: [{ type: 'text', text: 'Navigated to https://final.test/' }] };
    };

    const result = await withAutomationLease(deps, 's1', body, {
      redundantNavigationUrl: () => 'https://final.test/',
    });

    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain('https://requested.test/');
    expect(result.content[0].text).not.toContain('https://final.test/');
  });

  it('post-drain preserves a baseline the body wrote for the final URL', async () => {
    const key = snapshotSurfaceKey('ws-test', 's1');
    const queue: unknown[] = [];
    mockSendRpc.mockImplementation(queueRouter(queue));
    const body = async () => {
      // snapshot-during-navigation: the body observed the navigation and
      // wrote a baseline for the page's final URL
      queue.push({ type: 'navigated', url: 'https://final.test/', ts: Date.now() });
      setSnapshotBaseline(key, 'ai||', 'fresh snapshot', 'https://final.test/');
      return { content: [] };
    };

    await withAutomationLease(deps, 's1', body);

    expect(getSnapshotBaseline(key, 'ai||', 'https://final.test/')).not.toBeNull();
  });

  it('post-drain invalidates a baseline that does not match the navigated URL', async () => {
    const key = snapshotSurfaceKey('ws-test', 's1');
    const queue: unknown[] = [];
    mockSendRpc.mockImplementation(queueRouter(queue));
    const body = async () => {
      setSnapshotBaseline(key, 'ai||', 'stale snapshot', 'https://old.test/');
      queue.push({ type: 'navigated', url: 'https://new.test/', ts: Date.now() });
      return { content: [] };
    };

    await withAutomationLease(deps, 's1', body);

    expect(getSnapshotBaseline(key, 'ai||')).toBeNull();
  });

  it('skips the post-drain when the body throws — events stay for the next op', async () => {
    const queue: unknown[] = [{ type: 'navigated', url: 'https://pre.test/', ts: Date.now() }];
    mockSendRpc.mockImplementation(queueRouter(queue));
    const body = async () => {
      queue.push({ type: 'navigated', url: 'https://during.test/', ts: Date.now() });
      throw new Error('body failed');
    };

    await expect(withAutomationLease(deps, 's1', body)).rejects.toThrow('body failed');

    // Only the pre-drain ran: the during-body event is still queued.
    expect(queue).toHaveLength(1);
    expect((queue[0] as { url: string }).url).toBe('https://during.test/');
  });
});
