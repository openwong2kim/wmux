import { beforeEach, describe, expect, it, vi } from 'vitest';

// browser_navigate returns isError for several reasons that are wmux's own —
// a tabs-tool error, an unresolved scope, no live page. Those say nothing
// about the host, and filing them would fill a site's memory with this
// application's problems. Only a real request that went out and did not come
// back is remembered, and only its error CLASS is kept.

const mockSendRpc = vi.fn();
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

vi.mock('../../browser-replay/actionRing', () => ({ recordAction: vi.fn() }));

// #1359: the chrome lane now runs the shared resolving URL policy before it
// drives the page. These hosts are fictional, so the resolver is stubbed to
// miss — keeping the suite off the machine's DNS. A host that does not resolve
// is not a positive block, so the navigation still goes out and fails the way
// this suite is about.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  }),
}));

const getPageForScope = vi.fn();
const resolveWorkspaceBackend = vi.fn(async () => 'chrome');
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope, resolveWorkspaceBackend }),
  },
}));

import { registerNavigationTools } from '../tools/navigation';
import { browserTabsError } from '../../../shared/browserTabs';
import type { BrowserToolDeps } from '../browserScope';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function collectTools(deps: BrowserToolDeps): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerNavigationTools(server as never, deps);
  return tools;
}

/** A page whose goto always throws the given error. */
function failingPage(error: Error) {
  return {
    url: () => 'about:blank',
    goto: vi.fn(async () => {
      throw error;
    }),
  };
}

const resolveWorkspaceId = vi.fn(async () => 'ws-caller');
let siteRecords: Array<Record<string, unknown>>;
/** How long the mocked record RPC takes to settle. */
let recordDelayMs = 0;
let navigate: ToolHandler;
let tabs: ToolHandler;

beforeEach(() => {
  vi.clearAllMocks();
  siteRecords = [];
  recordDelayMs = 0;
  resolveWorkspaceId.mockResolvedValue('ws-caller');
  resolveWorkspaceBackend.mockResolvedValue('chrome');
  mockSendRpc.mockImplementation((method: string, params: Record<string, unknown>) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
    if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
    if (method === 'browser.siteMemory.record') {
      return recordDelayMs === 0
        ? (siteRecords.push(params), Promise.resolve({ ok: true }))
        : new Promise((resolve) =>
            setTimeout(() => {
              siteRecords.push(params);
              resolve({ ok: true });
            }, recordDelayMs),
          );
    }
    if (method === 'browser.tabs') {
      return Promise.resolve(
        browserTabsError('BROWSER_TABS_WORKSPACE_UNRESOLVED', 'The calling workspace is unavailable.'),
      );
    }
    return Promise.resolve({});
  });
  const tools = collectTools({ resolveWorkspaceId });
  navigate = tools.get('browser_navigate')!;
  tabs = tools.get('browser_tabs')!;
});

/** Let the fire-and-forget hook's microtasks settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('browser_navigate site-memory write hook', () => {
  it('records a net::ERR_ navigation failure', async () => {
    getPageForScope.mockResolvedValue(
      failingPage(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://gone.test/')),
    );
    const res = await navigate({ url: 'https://gone.test/page?token=abc' });
    expect(res.isError).toBe(true);
    await settle();
    expect(siteRecords).toHaveLength(1);
    expect(siteRecords[0]).toMatchObject({
      domain: 'gone.test',
      kind: 'failure',
      source: 'navigate',
      cause: 'net::ERR_NAME_NOT_RESOLVED',
      // normalizeUrlKey drops the query, so a one-time token cannot be stored.
      urlKey: 'https://gone.test/page',
    });
  });

  it('records a navigation timeout by its class alone', async () => {
    const timeout = new Error('Timeout 30000ms exceeded loading https://slow.test/');
    timeout.name = 'TimeoutError';
    getPageForScope.mockResolvedValue(failingPage(timeout));
    await navigate({ url: 'https://slow.test/' });
    await settle();
    expect(siteRecords[0]).toMatchObject({ domain: 'slow.test', cause: 'TimeoutError' });
  });

  it('records nothing for an internal tabs-tool error', async () => {
    const res = await tabs({ action: 'list' });
    expect(res.isError).toBe(true);
    await settle();
    expect(siteRecords).toHaveLength(0);
  });

  it('records nothing when the failure is wmux\'s own', async () => {
    // No page resolved for the scope: wmux's problem, not the host's.
    getPageForScope.mockResolvedValue(null);
    const res = await navigate({ url: 'https://fine.test/' });
    expect(res.isError).toBe(true);
    await settle();
    expect(siteRecords).toHaveLength(0);
  });
  it('waits for the record before returning, so a process exit cannot lose it', async () => {
    // A stdio MCP process can exit as soon as the tool response is written,
    // taking an in-flight RPC with it. Measured: no file without a hold.
    recordDelayMs = 50;
    getPageForScope.mockResolvedValue(
      failingPage(new Error('page.goto: net::ERR_CONNECTION_REFUSED')),
    );
    const res = await navigate({ url: 'https://gone.test/page' });
    expect(res.isError).toBe(true);
    // No settle() here: the record must already be in by the time the tool
    // result is handed back, not merely queued behind it.
    expect(siteRecords).toHaveLength(1);
    expect(siteRecords[0]).toMatchObject({ cause: 'net::ERR_CONNECTION_REFUSED' });
  });

  it('gives up on a record that hangs rather than holding the navigation', async () => {
    vi.useFakeTimers();
    try {
      // Longer than the bound: the agent's error must not wait on bookkeeping.
      recordDelayMs = 60_000;
      getPageForScope.mockResolvedValue(
        failingPage(new Error('page.goto: net::ERR_TIMED_OUT')),
      );
      const pending = navigate({ url: 'https://gone.test/page' });
      await vi.advanceTimersByTimeAsync(2_000);
      const res = await pending;
      expect(res.isError).toBe(true);
      expect(siteRecords).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('browser_navigate site-memory record on a protected pane', () => {
  it('names the policy epoch it was authorized at; an unprotected pane names none', async () => {
    mockSendRpc.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'browser.lease.acquire') {
        return Promise.resolve({ token: 'lease-1', policy: { protected: true, epoch: 9, hosts: { mode: 'allowlist', allow: ['gone.test'], block: [] } } });
      }
      if (method === 'browser.siteMemory.record') {
        siteRecords.push(params);
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ entries: [] });
    });
    getPageForScope.mockResolvedValue(failingPage(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://gone.test/')));
    await navigate({ url: 'https://gone.test/' });
    await settle();
    expect(siteRecords).toHaveLength(1);
    expect(siteRecords[0]).toMatchObject({ domain: 'gone.test', kind: 'failure', policyEpoch: 9 });
  });

  it('an unprotected navigation failure carries no epoch', async () => {
    getPageForScope.mockResolvedValue(failingPage(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://gone.test/')));
    await navigate({ url: 'https://gone.test/' });
    await settle();
    expect(siteRecords[0]).not.toHaveProperty('policyEpoch');
  });
});
