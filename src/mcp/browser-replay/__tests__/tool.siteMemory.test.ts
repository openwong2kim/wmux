// The replay write hook. It rides the same point every replay passes through
// — the stats call — and is fire-and-forget in both directions: a failure it
// cannot record is not worth failing a replay over, and a replay it cannot
// explain is not worth recording.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayResult } from '../replayRunner';
import type { TraceRecord } from '../../../shared/browserReplay/actionTrace';

const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
let getResponse: TraceRecord | null = null;
let siteMemoryRejects = false;
let tabsResponse: { ok: boolean; action: string; tabs: Array<Record<string, unknown>> } = {
  ok: true,
  action: 'list',
  tabs: [{ surfaceId: 's1', url: 'https://shop.test/cart?ref=1', selected: true }],
};
let recordResponse: Record<string, unknown> = { ok: true };

vi.mock('../../playwright/browserScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../playwright/browserScope')>();
  return {
    ...actual,
    sendScopedBrowserRpc: async (
      method: string,
      _scope: unknown,
      params: Record<string, unknown> = {},
    ) => {
      rpcCalls.push({ method, params });
      if (method === 'browser.actionCache.get') return { trace: getResponse };
      if (method === 'browser.actionCache.promoted') return { promoted: [] };
      if (method === 'browser.siteMemory.record') {
        if (siteMemoryRejects) throw new Error('main does not know this method');
        return recordResponse;
      }
      return {};
    },
  };
});

// main's browser.tabs handler, as far as `list` goes: it answers the
// workspace's tabs, and refuses `list` that names a surfaceId (#2064). Every
// other method is unreachable here, as it is with no main to connect to.
const tabsListCalls: Array<Record<string, unknown>> = [];
vi.mock('../../wmux-client', () => ({
  sendRpc: async (method: string, params: Record<string, unknown> = {}) => {
    if (method !== 'browser.tabs') throw new Error('wmux main is not reachable');
    tabsListCalls.push(params);
    if (params['surfaceId']) {
      return {
        ok: false,
        error: {
          code: 'BROWSER_TABS_INVALID_ARGUMENT',
          message: 'browser_tabs list does not accept surfaceId.',
        },
      };
    }
    return tabsResponse;
  },
}));

vi.mock('../../playwright/automationLease', () => ({
  withAutomationLease: async (
    _deps: unknown,
    _surfaceId: string | undefined,
    fn: (scope: { workspaceId: string }) => Promise<unknown>,
  ) => fn({ workspaceId: 'ws-1' }),
}));

vi.mock('../../playwright/snapshot', () => ({
  generateSnapshot: async () => '',
  listRefEntries: () => [],
  resolveRef: async () => null,
  browserScopeKey: (scope: { workspaceId: string; surfaceId?: string }) =>
    `${scope.workspaceId}\u0000${scope.surfaceId ?? ''}`,
}));

vi.mock('../../playwright/PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      getPageForScope: async () => ({ url: () => 'https://shop.test/cart' }),
    }),
  },
}));

let replayResult: ReplayResult;
vi.mock('../replayRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../replayRunner')>();
  return { ...actual, replayTrace: async () => replayResult };
});

import { createReplayToolCatalog } from '../tool';
import { ActionRing } from '../actionRing';

let deps: { resolveWorkspaceId: () => Promise<string>; actionRing: ActionRing };

function invoke(input: Record<string, unknown>) {
  const [tool] = createReplayToolCatalog(deps);
  return tool.invoke(input, { principal: { kind: 'unattributed' } }) as Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;
}

function trace(urlKey = 'https://shop.test/cart'): TraceRecord {
  return {
    id: 'tr_1',
    name: 'checkout',
    urlKey,
    surfaceShape: '',
    steps: [{ tool: 'browser_click', axis: { kind: 'none' }, args: {} }],
    observedCount: 1,
    successCount: 2,
    failCount: 0,
    createdAt: 0,
    lastUsedAt: 0,
  };
}

function result(over: Partial<ReplayResult> = {}): ReplayResult {
  return {
    ok: false,
    steps: [{ index: 1, tool: 'browser_click', ok: false, detail: 'no element matched "Pay now"' }],
    warnings: [],
    failedStep: 1,
    recordedShape: 'aaaa',
    liveShape: 'bbbb',
    ...over,
  };
}

/** Every siteMemory.record call the run made, settled. */
async function siteRecords(): Promise<Array<Record<string, unknown>>> {
  // The hook is fire-and-forget, so let its microtasks run before asserting.
  await Promise.resolve();
  await Promise.resolve();
  return rpcCalls.filter((c) => c.method === 'browser.siteMemory.record').map((c) => c.params);
}

beforeEach(() => {
  rpcCalls.length = 0;
  tabsListCalls.length = 0;
  getResponse = trace();
  siteMemoryRejects = false;
  recordResponse = { ok: true };
  tabsResponse = {
    ok: true,
    action: 'list',
    tabs: [{ surfaceId: 's1', url: 'https://shop.test/cart?ref=1', selected: true }],
  };
  replayResult = result();
  deps = { resolveWorkspaceId: async () => 'ws-1', actionRing: new ActionRing() };
});

describe('browser_replay write hook', () => {
  it('records a failure entry when a replay fails', async () => {
    await invoke({ action: 'run', name: 'checkout' });
    const records = await siteRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      domain: 'shop.test',
      kind: 'failure',
      source: 'replay',
      urlKey: 'https://shop.test/cart',
      cause: 'no element matched "Pay now"',
    });
    expect(records[0]?.['what']).toContain('step 1');
    // The remedy is a constant this code chose, never anything page-derived.
    expect(records[0]?.['tryInstead']).toContain('re-recording');
  });

  it('records nothing on an inconclusive run', async () => {
    // The PAGE changed shape; the flow is not known to be broken. Same reason
    // this outcome is kept out of the trace's failure streak.
    replayResult = result({ inconclusive: true });
    await invoke({ action: 'run', name: 'checkout' });
    expect(await siteRecords()).toHaveLength(0);
  });

  it('a failed record RPC never fails the replay', async () => {
    siteMemoryRejects = true;
    const res = await invoke({ action: 'run', name: 'checkout' });
    // The replay's own failure is reported; the memory error is not surfaced.
    expect(res.content[0].text).toContain('stopped at step 1');
    expect(res.content[0].text).not.toContain('does not know this method');
  });

  it("attributes a replay failure to the flow's own domain, not a redirect target", async () => {
    // The flow was recorded on shop.test; the run died after being bounced to
    // an identity provider. That is not the provider's knowledge.
    getResponse = trace('https://shop.test/cart');
    replayResult = result({
      steps: [
        { index: 1, tool: 'browser_click', ok: false, detail: 'stuck on https://sso.example/login' },
      ],
    });
    await invoke({ action: 'run', name: 'checkout' });
    const records = await siteRecords();
    expect(records[0]).toMatchObject({ domain: 'shop.test' });
  });

  it('a successful replay bumps provenFlowCount without adding a note', async () => {
    replayResult = result({ ok: true, failedStep: undefined, steps: [] });
    await invoke({ action: 'run', name: 'checkout' });
    const records = await siteRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ domain: 'shop.test', kind: 'success' });
  });
});

describe('browser_replay note', () => {
  it('note stores an agent-authored entry against the landed host', async () => {
    const res = await invoke({ action: 'note', note: 'the search box needs two clicks to focus' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('shop.test');
    const records = await siteRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      domain: 'shop.test',
      kind: 'note',
      note: 'the search box needs two clicks to focus',
    });
    // The site is never a parameter: an agent that names the site can name the
    // wrong one, and the only one it has standing to write is the one it is on.
    expect(records[0]).not.toHaveProperty('urlKey');
  });

  it('note works without a live Page', async () => {
    // getPageForScope is never consulted on this path, so a backend that mints
    // no Playwright Page still lets an agent write down what it learned.
    const res = await invoke({ action: 'note', note: 'the export button is under More' });
    expect(res.isError).toBeUndefined();
    expect(rpcCalls.map((c) => c.method)).not.toContain('browser.actionCache.get');
  });

  it('note refuses text carrying a credential', async () => {
    // The refusal reason that comes back is a PATTERN NAME, never the text.
    recordResponse = { ok: false, reason: 'long-token' };
    const res = await invoke({ action: 'note', note: 'the key is QUJDREVGR0hJSktMTU5PUFFSU1RVVld' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('long-token');
    expect(res.content[0].text).not.toContain('QUJDREVG');
  });

  it('note finds the site of a named surface, which main refuses to list by (#2064)', async () => {
    tabsResponse = {
      ok: true,
      action: 'list',
      tabs: [
        { surfaceId: 's1', url: 'https://other.test/', selected: true },
        { surfaceId: 's2', url: 'https://shop.test/cart', selected: false },
      ],
    };
    const res = await invoke({ action: 'note', note: 'checkout needs a login', surfaceId: 's2' });
    expect(res.isError).toBeUndefined();
    // The listing names no surface, and stays confined to this workspace.
    expect(tabsListCalls).toEqual([{ action: 'list', workspaceId: 'ws-1' }]);
    const records = await siteRecords();
    expect(records).toHaveLength(1);
    // The named surface's host, not the selected tab's.
    expect(records[0]).toMatchObject({ domain: 'shop.test', kind: 'note' });
  });

  it('note never falls back to another tab when the named surface is not listed', async () => {
    const res = await invoke({ action: 'note', note: 'something worth knowing', surfaceId: 's-gone' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('which site');
    expect(await siteRecords()).toHaveLength(0);
  });

  it('note says which site it could not identify rather than guessing', async () => {
    tabsResponse = { ok: true, action: 'list', tabs: [] };
    const res = await invoke({ action: 'note', note: 'something worth knowing' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('which site');
    expect(await siteRecords()).toHaveLength(0);
  });
});
