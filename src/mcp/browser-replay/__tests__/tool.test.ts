import { describe, it, expect, beforeEach, vi } from 'vitest';

// Every RPC the tool issues, in order. The password assertions read this.
const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
let listResponse: unknown[] = [];
let getResponse: unknown = null;

vi.mock('../../playwright/browserScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../playwright/browserScope')>();
  return {
    ...actual,
    sendScopedBrowserRpc: async (method: string, _scope: unknown, params: Record<string, unknown> = {}) => {
      rpcCalls.push({ method, params });
      if (method === 'browser.actionCache.list') return { traces: listResponse };
      if (method === 'browser.actionCache.get') return { trace: getResponse };
      if (method === 'browser.actionCache.put') {
        return { ok: true, trace: (params.trace as Record<string, unknown>) };
      }
      if (method === 'browser.actionCache.forget') return { removed: 1 };
      return {};
    },
  };
});

// The lease is transport, not behaviour under test: run the body against a
// fixed scope so the tool's own decisions are what the cases exercise.
vi.mock('../../playwright/automationLease', () => ({
  withAutomationLease: async (
    _deps: unknown,
    _surfaceId: string | undefined,
    fn: (scope: { workspaceId: string }) => Promise<unknown>,
  ) => fn({ workspaceId: 'ws-1' }),
}));

vi.mock('../../playwright/snapshot', () => ({
  generateSnapshot: async () => 'button "Sign in" [ref=1]',
  listRefEntries: () => [],
  resolveRef: async () => null,
  browserScopeKey: (scope: { workspaceId: string; surfaceId?: string }) =>
    `${scope.workspaceId}\u0000${scope.surfaceId ?? ''}`,
}));

vi.mock('../../playwright/PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      getPageForScope: async () => pageForScope,
    }),
  },
}));

let pageForScope: unknown = null;

import { createReplayToolCatalog } from '../tool';
import { ActionRing, recordAction } from '../actionRing';
import type { TraceRecord } from '../../../shared/browserReplay/actionTrace';

// The lease mock resolves every call to this scope, so the ring's scope key and
// the tool's cut key have to agree on it.
const scope = { workspaceId: 'ws-1' };
let ring: ActionRing;
let deps: { resolveWorkspaceId: () => Promise<string>; actionRing: ActionRing };

function invoke(input: Record<string, unknown>) {
  const [tool] = createReplayToolCatalog(deps);
  return tool.invoke(input, { principal: { kind: 'unattributed' } }) as Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;
}

const SECRET = 'hunter2-do-not-store';

beforeEach(() => {
  rpcCalls.length = 0;
  listResponse = [];
  getResponse = null;
  pageForScope = null;
  ring = new ActionRing();
  deps = { resolveWorkspaceId: async () => 'ws-1', actionRing: ring };
});

describe('browser_replay — the tool surface', () => {
  it('is one tool, registered only in the full profile', () => {
    const [tool] = createReplayToolCatalog(deps);
    expect(createReplayToolCatalog(deps)).toHaveLength(1);
    expect(tool.name).toBe('browser_replay');
    expect(tool.profiles).toEqual(['full']);
  });

  it('lists nothing helpfully when the workspace has no flows', async () => {
    const result = await invoke({ action: 'list' });
    expect(result.content[0].text).toContain('No recorded flows');
    expect(rpcCalls.map((c) => c.method)).toEqual(['browser.actionCache.list']);
  });

  it('refuses save/run/forget without a usable name', async () => {
    for (const action of ['save', 'run', 'forget']) {
      const result = await invoke({ action });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('needs a name');
    }
    expect(rpcCalls).toEqual([]);
  });

  it('refuses a name that could pollute the store keyspace', async () => {
    const result = await invoke({ action: 'save', name: '__proto__' });
    expect(result.isError).toBe(true);
    expect(rpcCalls).toEqual([]);
  });
});

describe('browser_replay save — a password never reaches the put RPC', () => {
  it('does not carry the typed secret in the put payload', async () => {
    // Exactly what interaction.ts does for a password field: the value is
    // omitted at the recorder, so there is nothing downstream to leak.
    recordAction(deps, {
      scope,
      tool: 'browser_type',
      page: null,
      args: {},
      unrecordable: 'password',
      url: 'https://example.com/login',
    });

    const result = await invoke({ action: 'save', name: 'login' });

    const put = rpcCalls.find((c) => c.method === 'browser.actionCache.put');
    expect(put).toBeDefined();
    expect(JSON.stringify(put)).not.toContain(SECRET);
    expect(JSON.stringify(rpcCalls)).not.toContain(SECRET);
    // Saved for the record, but honestly marked as unable to run.
    expect(result.content[0].text).toContain('will refuse to run');
  });

  it('refuses to run a saved flow that contains the password hole', async () => {
    getResponse = {
      id: 'tr_1',
      name: 'login',
      urlKey: 'https://example.com/login',
      surfaceShape: '',
      steps: [{ tool: 'browser_type', axis: { kind: 'none' }, args: {}, unrecordable: 'password' }],
      observedCount: 1,
      successCount: 0,
      failCount: 0,
      createdAt: 0,
      lastUsedAt: 0,
    } satisfies TraceRecord;

    const result = await invoke({ action: 'run', name: 'login' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('step 1 (password)');
    // It never got as far as needing a page, and never recorded a run.
    expect(rpcCalls.map((c) => c.method)).toEqual(['browser.actionCache.get']);
  });

  it('a non-password type step does carry its text, so the guard is not vacuous', async () => {
    recordAction(deps, {
      scope,
      tool: 'browser_type',
      page: null,
      args: { text: 'a search term' },
      url: 'https://example.com/s',
    });
    await invoke({ action: 'save', name: 'search' });
    expect(JSON.stringify(rpcCalls)).toContain('a search term');
  });
});

describe('browser_replay save — cutting the ring', () => {
  it('refuses to save on a connection with no recorder rather than borrowing one', async () => {
    const ringless = { resolveWorkspaceId: async () => 'ws-1' };
    const [tool] = createReplayToolCatalog(ringless);
    const result = (await tool.invoke(
      { action: 'save', name: 'flow' },
      { principal: { kind: 'unattributed' } },
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no action recorder');
    expect(rpcCalls).toEqual([]);
  });

  it('does not cut another surface\'s actions into this surface\'s flow', async () => {
    recordAction(deps, {
      scope: { workspaceId: 'ws-1', surfaceId: 'other' },
      tool: 'browser_click',
      page: null,
      url: 'https://example.com/other',
    });
    const result = await invoke({ action: 'save', name: 'flow' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('on this surface');
    expect(rpcCalls).toEqual([]);
  });

  it('refuses to save when no action has been recorded', async () => {
    const result = await invoke({ action: 'save', name: 'nothing' });
    expect(result.isError).toBe(true);
    expect(rpcCalls).toEqual([]);
  });

  it('cuts from the last navigate by default', async () => {
    recordAction(deps, { scope, tool: 'browser_click', page: null, url: 'https://example.com/a' });
    recordAction(deps, { scope, tool: 'browser_navigate', page: null, args: { url: 'https://example.com/b' }, url: 'https://example.com/b' });
    recordAction(deps, { scope, tool: 'browser_click', page: null, url: 'https://example.com/b' });

    await invoke({ action: 'save', name: 'flow' });
    const put = rpcCalls.find((c) => c.method === 'browser.actionCache.put');
    const trace = put!.params.trace as TraceRecord;
    expect(trace.steps.map((s) => s.tool)).toEqual(['browser_navigate', 'browser_click']);
    expect(trace.urlKey).toBe('https://example.com/b');
  });

  it('honours an explicit step count', async () => {
    for (let i = 0; i < 4; i++) {
      recordAction(deps, { scope, tool: 'browser_click', page: null, url: 'https://example.com/a' });
    }
    await invoke({ action: 'save', name: 'flow', steps: 2 });
    const put = rpcCalls.find((c) => c.method === 'browser.actionCache.put');
    expect((put!.params.trace as TraceRecord).steps).toHaveLength(2);
  });
});

describe('browser_replay run — page requirement and stats', () => {
  it('reports an unknown flow rather than running an empty one', async () => {
    const result = await invoke({ action: 'run', name: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No flow named "nope"');
  });

  const clickFlow = (urlKey: string): TraceRecord => ({
    id: 'tr_1',
    name: 'flow',
    urlKey,
    surfaceShape: '',
    steps: [
      {
        tool: 'browser_click',
        axis: { kind: 'ref', role: 'button', name: 'Go', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' },
        args: {},
      },
    ],
    observedCount: 1,
    successCount: 1,
    failCount: 0,
    createdAt: 0,
    lastUsedAt: 0,
  });

  it('refuses to replay a flow from a page it was not recorded on', async () => {
    // The stored axes were numbered against one page. Elsewhere they would
    // match whatever role+name happens to exist — a successful replay of the
    // wrong actions, which is worse than a failed one.
    getResponse = clickFlow('https://example.com/a');
    pageForScope = { url: () => 'https://example.com/somewhere-else' };

    const result = await invoke({ action: 'run', name: 'flow' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('recorded on https://example.com/a');
    expect(result.content[0].text).toContain('Navigate there first');
    expect(rpcCalls.some((c) => c.method === 'browser.actionCache.stats')).toBe(false);
  });

  it('ignores the query string when deciding it is the same page', async () => {
    getResponse = clickFlow('https://example.com/a');
    pageForScope = { url: () => 'https://example.com/a?page=2' };

    const result = await invoke({ action: 'run', name: 'flow' });
    expect(result.content[0].text).not.toContain('Navigate there first');
  });

  it('exempts a flow that starts with its own navigate', async () => {
    getResponse = {
      ...clickFlow('https://example.com/a'),
      steps: [
        { tool: 'browser_navigate', axis: { kind: 'none' }, args: { url: 'https://example.com/a' } },
      ],
    } satisfies TraceRecord;
    pageForScope = null;

    const result = await invoke({ action: 'run', name: 'flow' });
    // It got past the page gate and stopped on the missing page instead.
    expect(result.content[0].text).toContain('no live page');
  });

  it('refuses the RPC lane instead of replaying against a different addressing scheme', async () => {
    getResponse = {
      ...clickFlow('https://example.com/a'),
      steps: [
        { tool: 'browser_navigate', axis: { kind: 'none' }, args: { url: 'https://example.com/a' } },
      ],
    } satisfies TraceRecord;
    pageForScope = null;

    const result = await invoke({ action: 'run', name: 'flow' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no live page');
    expect(rpcCalls.some((c) => c.method === 'browser.actionCache.stats')).toBe(false);
  });
});

describe('browser_replay forget', () => {
  it('deletes by name through the scoped RPC', async () => {
    const result = await invoke({ action: 'forget', name: 'flow' });
    expect(result.content[0].text).toBe('Forgot "flow".');
    expect(rpcCalls[0]).toMatchObject({
      method: 'browser.actionCache.forget',
      params: { name: 'flow' },
    });
  });
});
