import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { resetProtectionMemoryForTests, withAutomationLease } from '../automationLease';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';

// An operation with no surface to lease re-reads main's authorization every
// 2s. "Always on this pane" bumps the policy epoch without touching the site
// policy: that widens the pane and must not fail the operation under way. A
// change of the site policy during it still does.

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };
const HOSTS = { mode: 'allowlist', allow: ['a.test'], block: [] };
let current: unknown;

beforeEach(() => {
  vi.useFakeTimers();
  mockSendRpc.mockReset();
  __resetSurfaceRoutingForTesting();
  resetProtectionMemoryForTests();
  current = { protected: true, epoch: 3, hosts: HOSTS };
  mockSendRpc.mockImplementation((method: string) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: null, policy: current });
    if (method === 'browser.cdp.info') return Promise.resolve({ targetsScoped: true, targets: [] });
    if (method === 'browser.tabs') return Promise.resolve({ ok: false });
    return Promise.resolve({});
  });
});
afterEach(() => vi.useRealTimers());

/** Run an unleased operation that lasts past two late-acquire ticks while `change` happens. */
async function longOp(change: () => void) {
  const op = withAutomationLease(deps, undefined, async () => {
    change();
    await vi.advanceTimersByTimeAsync(5_000);
    return 'finished';
  });
  return op;
}

describe('withAutomationLease — epoch moves under an unleased protected operation', () => {
  it('a grants-only change (same site policy, new epoch) lets the operation finish', async () => {
    await expect(longOp(() => { current = { protected: true, epoch: 4, hosts: HOSTS }; })).resolves.toBe('finished');
  });

  it('a site-policy edit during it still revokes the operation', async () => {
    await expect(
      longOp(() => { current = { protected: true, epoch: 4, hosts: { ...HOSTS, allow: ['a.test', 'b.test'] } }; }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('protection turned off during it still revokes the operation', async () => {
    await expect(longOp(() => { current = { protected: false }; })).rejects.toMatchObject({ code: 'policy_denied' });
  });
});
