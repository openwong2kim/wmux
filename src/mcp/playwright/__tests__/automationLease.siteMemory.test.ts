// The [site] block rides the same lease bracket as the [replay] and [skill]
// hints: after a successful navigation, never on a snapshot footer, never on
// an error. Mock idiom follows automationLease.replayHints.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { withAutomationLease } from '../automationLease';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';
import {
  SITE_HINT_HEADER,
  SITE_HINT_MAX_BYTES,
  SITE_HINT_MAX_LINES,
  emptySiteMemoryRecord,
  mergeFailure,
  type FailureEntry,
  type SiteMemoryRecord,
} from '../../../shared/browserMemory/siteMemory';
import type { TraceRecord } from '../../../shared/browserReplay/actionTrace';

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };
const NOW = 1_800_000_000_000;

function failure(over: Partial<FailureEntry> = {}): FailureEntry {
  return {
    id: over.id ?? 'f1',
    urlKey: over.urlKey ?? 'https://shop.test/cart',
    what: over.what ?? 'replay "checkout" stopped at step 3',
    cause: over.cause ?? 'no element matched the stored axis',
    tryInstead: over.tryInstead ?? 'this page needs re-recording',
    source: 'replay',
    createdAt: NOW,
    lastSeenAt: over.lastSeenAt ?? NOW,
    seenCount: over.seenCount ?? 1,
  };
}

function memoryWith(entries: FailureEntry[]): SiteMemoryRecord {
  let rec = emptySiteMemoryRecord('ws-test', 'shop.test', 'shop.test', NOW);
  for (const entry of entries) rec = mergeFailure(rec, entry, NOW);
  return rec;
}

interface RouterOpts {
  traces?: TraceRecord[];
  memory?: SiteMemoryRecord | null;
  siteRejects?: boolean;
  seen?: Array<Record<string, unknown>>;
}

function router(queue: unknown[], opts: RouterOpts = {}) {
  return (method: string, params: Record<string, unknown>) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
    // Surface routing runs first: a call that names no surfaceId resolves one
    // (this main reports a single unclaimed surface, which the caller adopts)
    // so the lease, the lifecycle drain and the hints all speak about the same
    // page instead of whatever main would have picked.
    if (method === 'browser.cdp.info') {
      return Promise.resolve({
        targetsScoped: true,
        workspaceBackend: 'builtin',
        targets: [{ surfaceId: 'auto-1' }],
      });
    }
    if (method === 'browser.surface.adopt') return Promise.resolve({ ok: true, owner: 'mine' });

    if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: queue.splice(0) });
    if (method === 'browser.actionCache.list') return Promise.resolve({ traces: opts.traces ?? [] });
    if (method === 'browser.actionCache.promoted') return Promise.resolve({ promoted: [] });
    if (method === 'browser.siteMemory.list') {
      opts.seen?.push(params);
      if (opts.siteRejects) return Promise.reject(new Error('no such method'));
      return Promise.resolve({ memory: opts.memory ?? null });
    }
    return Promise.resolve({});
  };
}

function provenTrace(): TraceRecord {
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
  };
}

const navigated = (url: string) => ({ type: 'navigated', url, ts: Date.now() });
const body = async () => ({ content: [{ type: 'text', text: 'Navigated to https://shop.test/cart' }] });

beforeEach(() => {
  // Per-connection pin: no broker scope here, so it lives in the module
  // fallback and would leak between cases.
  __resetSurfaceRoutingForTesting();
  mockSendRpc.mockReset();
  deps.resolveWorkspaceId.mockReset();
  deps.resolveWorkspaceId.mockResolvedValue('ws-test');
});

describe('site memory hints on navigation', () => {
  it('injects at most 600 bytes and at most 4 lines on a landing', async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      failure({
        id: `f-${i}`,
        what: `replay "flow-${i}" stopped at step ${i} ${'w'.repeat(40)}`,
        cause: 'w'.repeat(110),
        tryInstead: 'w'.repeat(110),
        seenCount: 6 - i,
      }),
    );
    mockSendRpc.mockImplementation(
      router([navigated('https://shop.test/cart')], { memory: memoryWith(many) }),
    );
    const result = await withAutomationLease(deps, 's1', body);
    const block = result.content[0].text as string;
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(SITE_HINT_MAX_BYTES);
    // One fixed header line, then at most SITE_HINT_MAX_LINES content lines.
    const lines = block.trimEnd().split('\n');
    expect(lines[0]).toBe(SITE_HINT_HEADER);
    expect(lines.length - 1).toBeLessThanOrEqual(SITE_HINT_MAX_LINES);
  });

  it('injects when there are no recorded flows at all', async () => {
    // The main scenario: a domain wmux has never recorded a flow on, where
    // only failure memory exists. The pre-existing early return was keyed on
    // the two flow blocks alone, which would have suppressed this forever.
    mockSendRpc.mockImplementation(
      router([navigated('https://shop.test/cart')], {
        traces: [],
        memory: memoryWith([failure()]),
      }),
    );
    const result = await withAutomationLease(deps, 's1', body);
    const text = JSON.stringify(result);
    expect(text).toContain('[site]');
    expect(text).not.toContain('[replay]');
  });

  it('keeps the replay hint when the siteMemory RPC rejects', async () => {
    // An older main has no such method. Without the per-call .catch the whole
    // Promise.all rejects and the existing hints disappear with it.
    mockSendRpc.mockImplementation(
      router([navigated('https://shop.test/cart')], {
        traces: [provenTrace()],
        siteRejects: true,
      }),
    );
    const result = await withAutomationLease(deps, 's1', body);
    const text = JSON.stringify(result);
    expect(text).toContain('[replay]');
    expect(text).not.toContain('[site]');
  });

  it('never injects on an isError result', async () => {
    mockSendRpc.mockImplementation(
      router([navigated('https://shop.test/cart')], { memory: memoryWith([failure()]) }),
    );
    const failing = async () => ({
      content: [{ type: 'text', text: 'Error: navigation blocked' }],
      isError: true,
    });
    const result = await withAutomationLease(deps, 's1', failing);
    expect(JSON.stringify(result)).not.toContain('[site]');
  });

  it('never injects into a snapshot footer', async () => {
    // No `navigated` event at all — a snapshot is not a landing.
    mockSendRpc.mockImplementation(router([], { memory: memoryWith([failure()]) }));
    const snapshot = async () => ({ content: [{ type: 'text', text: '- button "Buy"' }] });
    const result = await withAutomationLease(deps, 's1', snapshot);
    expect(JSON.stringify(result)).not.toContain('[site]');
  });

  it('ranks the failure seen most often first', async () => {
    mockSendRpc.mockImplementation(
      router([navigated('https://shop.test/cart')], {
        memory: memoryWith([
          failure({ id: 'rare', what: 'the RARE one', seenCount: 1 }),
          failure({ id: 'common', what: 'the COMMON one', seenCount: 9 }),
        ]),
      }),
    );
    const result = await withAutomationLease(deps, 's1', body);
    const block = result.content[0].text as string;
    expect(block.indexOf('COMMON')).toBeLessThan(block.indexOf('RARE'));
  });

  it('asks for the landed host, not the full URL', async () => {
    const seen: Array<Record<string, unknown>> = [];
    mockSendRpc.mockImplementation(
      router([navigated('https://shop.test/cart?ref=email#top')], { seen }),
    );
    await withAutomationLease(deps, 's1', body);
    expect(seen[0]).toMatchObject({ domain: 'shop.test' });
  });
});
