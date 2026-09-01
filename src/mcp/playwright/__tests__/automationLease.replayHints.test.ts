import { beforeEach, describe, expect, it, vi } from 'vitest';

// The replay hint rides the same lease bracket as the lifecycle-event block:
// after a successful navigation, and only when the workspace holds a PROVEN
// flow for the page that was landed on. Mock idiom follows
// automationLease.events.test.ts — one router over sendRpc.

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { withAutomationLease } from '../automationLease';
import type { TraceRecord } from '../../../shared/browserReplay/actionTrace';

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: 'tr_1',
    name: 'checkout',
    urlKey: 'https://shop.test/cart',
    surfaceShape: '',
    steps: [{ tool: 'browser_click', axis: { kind: 'none' }, args: {} }],
    observedCount: 1,
    successCount: 2,
    failCount: 0,
    createdAt: 0,
    lastUsedAt: 0,
    ...overrides,
  };
}

/** Router with a destructive lifecycle drain and a scripted trace list. */
function router(queue: unknown[], traces: TraceRecord[], seen?: Array<Record<string, unknown>>) {
  return (method: string, params: Record<string, unknown>) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
    if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: queue.splice(0) });
    if (method === 'browser.actionCache.list') {
      seen?.push(params);
      return Promise.resolve({ traces });
    }
    return Promise.resolve({});
  };
}

const navigated = (url: string) => ({ type: 'navigated', url, ts: Date.now() });
const body = async () => ({ content: [{ type: 'text', text: 'Navigated to https://shop.test/cart' }] });

beforeEach(() => {
  mockSendRpc.mockReset();
  deps.resolveWorkspaceId.mockReset();
  deps.resolveWorkspaceId.mockResolvedValue('ws-test');
});

describe('replay hints on navigation', () => {
  it('names a proven flow for the page just landed on', async () => {
    mockSendRpc.mockImplementation(router([navigated('https://shop.test/cart')], [trace()]));
    const result = await withAutomationLease(deps, 's1', body);
    expect(result.content[0].text).toContain('[replay]');
    expect(result.content[0].text).toContain('checkout');
  });

  it('asks for the landed page, with query and fragment normalised away', async () => {
    const seen: Array<Record<string, unknown>> = [];
    mockSendRpc.mockImplementation(
      router([navigated('https://shop.test/cart?ref=email#top')], [trace()], seen),
    );
    await withAutomationLease(deps, 's1', body);
    expect(seen[0]).toMatchObject({ urlKey: 'https://shop.test/cart' });
  });

  it('says nothing when the workspace has no flow for the page', async () => {
    mockSendRpc.mockImplementation(router([navigated('https://shop.test/cart')], []));
    const result = await withAutomationLease(deps, 's1', body);
    expect(JSON.stringify(result)).not.toContain('[replay]');
  });

  it('says nothing about an unproven flow', async () => {
    mockSendRpc.mockImplementation(
      router([navigated('https://shop.test/cart')], [trace({ successCount: 0 })]),
    );
    const result = await withAutomationLease(deps, 's1', body);
    expect(JSON.stringify(result)).not.toContain('[replay]');
  });

  it('says nothing about a quarantined flow', async () => {
    mockSendRpc.mockImplementation(
      router(
        [navigated('https://shop.test/cart')],
        [trace({ consecutiveFailsAtStep: 2, lastFailStep: 1 })],
      ),
    );
    const result = await withAutomationLease(deps, 's1', body);
    expect(JSON.stringify(result)).not.toContain('[replay]');
  });

  it('says nothing about a flow that cannot run', async () => {
    mockSendRpc.mockImplementation(
      router(
        [navigated('https://shop.test/cart')],
        [trace({ steps: [{ tool: 'browser_type', axis: { kind: 'none' }, args: {}, unrecordable: 'password' }] })],
      ),
    );
    const result = await withAutomationLease(deps, 's1', body);
    expect(JSON.stringify(result)).not.toContain('[replay]');
  });

  it('does not hint when nothing navigated', async () => {
    const seen: Array<Record<string, unknown>> = [];
    mockSendRpc.mockImplementation(router([], [trace()], seen));
    const result = await withAutomationLease(deps, 's1', body);
    expect(JSON.stringify(result)).not.toContain('[replay]');
    // Not even the lookup: a hint the agent cannot act on is not worth an RPC.
    expect(seen).toHaveLength(0);
  });

  it('does not hint on a failed tool result', async () => {
    mockSendRpc.mockImplementation(router([navigated('https://shop.test/cart')], [trace()]));
    const result = await withAutomationLease(deps, 's1', async () => ({
      content: [{ type: 'text', text: 'URL blocked' }],
      isError: true,
    }));
    expect(JSON.stringify(result)).not.toContain('[replay]');
  });

  it('stays silent when the cache lookup fails on an older main', async () => {
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
      if (method === 'browser.lifecycle.get') {
        return Promise.resolve({ entries: [navigated('https://shop.test/cart')] });
      }
      if (method === 'browser.actionCache.list') return Promise.reject(new Error('unknown method'));
      return Promise.resolve({});
    });
    const result = await withAutomationLease(deps, 's1', body);
    expect(result.content.some((c) => c.text?.includes('[replay]'))).toBe(false);
    expect(result.content.some((c) => c.text?.includes('Navigated to'))).toBe(true);
  });

  it('leaves a non-content result untouched', async () => {
    mockSendRpc.mockImplementation(router([navigated('https://shop.test/cart')], [trace()]));
    expect(await withAutomationLease(deps, 's1', async () => 'plain-string')).toBe('plain-string');
  });
});
