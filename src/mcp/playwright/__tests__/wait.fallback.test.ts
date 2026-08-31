import { describe, expect, it, vi, beforeEach } from 'vitest';

// Packaged RPC fallback coverage for browser_wait (#114). On packaged builds
// engine.getPage() returns null and the tool must poll the condition over the
// browser.evaluate RPC channel instead of throwing "No browser page available".

// #517: tool handlers are wrapped in withAutomationLease, which issues
// browser.lease.* RPCs around the real operation, plus a browser.lifecycle.get
// drain before the body. Record that infrastructure traffic
// separately so ordinary fallback assertions see only browser.evaluate calls.
const { mockSendRpc, mockLeaseRpc, getPage, getInstance } = vi.hoisted(() => {
  const getPage = vi.fn();
  return {
    mockSendRpc: vi.fn(),
    mockLeaseRpc: vi.fn(),
    getPage,
    getInstance: vi.fn(() => ({ getPageForScope: getPage })),
  };
});
vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    typeof method === 'string' && (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? mockLeaseRpc(method, ...args)
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance },
}));

import {
  createWaitToolCatalog,
  registerWaitTools,
} from '../tools/wait';
import type { WmuxToolProfile } from '../../toolCatalog';
import {
  expectCommanderCatalogLockstep,
  expectCoreCatalogLockstep,
  expectFrozenCatalog,
} from '../../__tests__/catalogAssertions';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(profile: WmuxToolProfile = 'full'): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerWaitTools(server as never, browserToolDeps, {
    profile,
    context: { principal: { kind: 'unattributed' } },
  });
  return tools;
}

const wait = collectTools().get('browser_wait');
if (!wait) {
  throw new Error('browser_wait failed to register');
}

/** Resolve common page reads (href/readyState) and let each test override the
 *  predicate-defining expression via `truthy`. */
function evalRouter(map: Record<string, unknown>, fallback: unknown = false) {
  return (_method: string, params: { expression: string }) => {
    if (params.expression in map) return Promise.resolve({ value: map[params.expression] });
    return Promise.resolve({ value: fallback });
  };
}

beforeEach(() => {
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  mockLeaseRpc.mockReset();
  mockLeaseRpc.mockResolvedValue({ token: null });
  getInstance.mockClear();
  getPage.mockReset();
  getPage.mockResolvedValue(null); // default: packaged (no Playwright Page)
});

describe('browser_wait catalog registration', () => {
  it('preserves the full order and stays absent from commander', () => {
    expect([...collectTools('full').keys()]).toEqual(['browser_wait']);
    expect([...collectTools('commander').keys()]).toEqual([]);
  });

  it('keeps the legacy schema order, profile membership, and frozen descriptors', () => {
    const specs = createWaitToolCatalog(browserToolDeps);
    expect(specs.map((spec) => spec.name)).toEqual(['browser_wait']);
    expect(specs[0]?.profiles).toEqual(['full']);
    expect(Object.keys(specs[0]?.inputSchema ?? {})).toEqual([
      'url',
      'selector',
      'text',
      'fn',
      'timeout',
      'surfaceId',
    ]);
    expectCommanderCatalogLockstep(specs);
    expectCoreCatalogLockstep(specs);
    expectFrozenCatalog(specs);
  });

  it('keeps registration-time engine acquisition before commander filtering', () => {
    expect([...collectTools('commander').keys()]).toEqual([]);
    expect(getInstance).toHaveBeenCalledTimes(1);
  });

  it('reuses the exact module-scope raw shape across catalogs and SDK registration', () => {
    const firstCatalog = createWaitToolCatalog(browserToolDeps);
    const secondCatalog = createWaitToolCatalog(browserToolDeps);
    let registeredInputSchema: unknown;
    const server = {
      registerTool: (
        _name: string,
        config: { inputSchema: unknown },
      ) => {
        registeredInputSchema = config.inputSchema;
      },
    };

    registerWaitTools(server as never, browserToolDeps, {
      profile: 'full',
      context: { principal: { kind: 'unattributed' } },
    });

    expect(secondCatalog[0]?.inputSchema).toBe(firstCatalog[0]?.inputSchema);
    expect(registeredInputSchema).toBe(firstCatalog[0]?.inputSchema);
  });
});

describe('browser_wait RPC fallback', () => {
  it('polls selector presence AND visibility over browser.evaluate', async () => {
    mockSendRpc.mockResolvedValue({ value: true });
    const res = await wait({ selector: '#app', surfaceId: 's1' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('selector "#app" found');
    const [method, params] = mockSendRpc.mock.calls[0] as [string, { expression: string; workspaceId: string; surfaceId?: string }];
    expect(method).toBe('browser.evaluate');
    // Mirrors Playwright's default state:'visible' — attachment + visible box.
    expect(params.expression).toContain('querySelector("#app")');
    expect(params.expression).toContain('getBoundingClientRect');
    expect(params.expression).toContain('visibility');
    expect(params.workspaceId).toBe('ws-test');
    expect(params.surfaceId).toBe('s1');
  });

  it('polls text content over browser.evaluate', async () => {
    mockSendRpc.mockResolvedValue({ value: true });
    const res = await wait({ text: 'Ready' });
    expect(res.content[0].text).toContain('text "Ready" found');
    const expr = (mockSendRpc.mock.calls[0][1] as { expression: string }).expression;
    expect(expr).toContain('document.body.innerText.includes("Ready")');
  });

  it('coerces the custom predicate to a boolean in the page (truthy objects survive RPC)', async () => {
    mockSendRpc.mockResolvedValue({ value: true });
    const res = await wait({ fn: "document.querySelector('#app')" });
    expect(res.content[0].text).toContain('custom predicate satisfied');
    const expr = (mockSendRpc.mock.calls[0][1] as { expression: string }).expression;
    // !! wrapper means a truthy DOM node serializes as `true`, not `null`.
    expect(expr).toBe("!!(document.querySelector('#app'))");
  });

  it('matches a URL glob and waits for the load state (readyState complete)', async () => {
    mockSendRpc.mockImplementation(evalRouter({
      'location.href': 'https://example.com/dashboard/42',
      'document.readyState': 'complete',
    }));
    const res = await wait({ url: '**/dashboard/**' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('URL matched "**/dashboard/**"');
    const exprs = mockSendRpc.mock.calls.map((c) => (c[1] as { expression: string }).expression);
    expect(exprs).toContain('location.href');
    expect(exprs).toContain('document.readyState');
  });

  it('confines a single * to one path segment (glob parity with waitForURL)', async () => {
    // href has an extra segment, so single-* must NOT match -> times out.
    mockSendRpc.mockImplementation(evalRouter({
      'location.href': 'https://site.test/a/b/settings',
      'document.readyState': 'complete',
    }));
    const res = await wait({ url: 'https://site.test/*/settings', timeout: 60 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Timed out');
  });

  it('matches zero path segments for a double-star URL glob (**/ is optional subpath)', async () => {
    // `**/settings` must also match the zero-segment case `/settings`, like waitForURL.
    mockSendRpc.mockImplementation(evalRouter({
      'location.href': 'https://site.test/settings',
      'document.readyState': 'complete',
    }));
    const res = await wait({ url: 'https://site.test/**/settings', timeout: 1000 });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('URL matched');
  });

  it('calls a function-expression predicate instead of testing the function object', async () => {
    mockSendRpc.mockResolvedValue({ value: true });
    const res = await wait({ fn: '() => window.ready' });
    expect(res.content[0].text).toContain('custom predicate satisfied');
    const expr = (mockSendRpc.mock.calls[0][1] as { expression: string }).expression;
    // The arrow function is invoked, not coerced to a (truthy) function object.
    expect(expr).toBe('!!((() => window.ready)())');
  });

  it('treats timeout:0 as an unbounded wait, not an instant timeout', async () => {
    // First poll false, second true: with a 0ms deadline the old code would time
    // out immediately; now it keeps polling until the condition holds.
    mockSendRpc
      .mockResolvedValueOnce({ value: false })
      .mockResolvedValue({ value: true });
    const res = await wait({ selector: '#eventual', timeout: 0 });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('selector "#eventual" found');
    expect(mockSendRpc.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('approximates networkidle with document.readyState', async () => {
    mockSendRpc.mockResolvedValue({ value: 'complete' });
    const res = await wait({});
    expect(res.content[0].text).toContain('network idle');
    expect((mockSendRpc.mock.calls[0][1] as { expression: string }).expression).toBe('document.readyState');
  });

  it('times out with a clear message when the condition never holds', async () => {
    mockSendRpc.mockResolvedValue({ value: false });
    const res = await wait({ selector: '#never', timeout: 60 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Timed out after 60ms');
    expect(res.content[0].text).toContain('selector "#never"');
  });

  it('keeps polling through a transient evaluate error, then succeeds', async () => {
    mockSendRpc
      .mockRejectedValueOnce(new Error('Cannot read properties of null'))
      .mockResolvedValue({ value: true });
    const res = await wait({ selector: '#late', timeout: 2000 });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('selector "#late" found');
    expect(mockSendRpc.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a setup error immediately instead of timing out', async () => {
    mockSendRpc.mockRejectedValue(new Error('browser.evaluate: no webview target registered'));
    const res = await wait({ selector: '#app', timeout: 30000 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('no webview target registered');
    // Failed fast — did not burn the 30s deadline polling.
    expect(mockSendRpc.mock.calls.length).toBe(1);
  });

  it('uses the Playwright Page when one exists (no RPC)', async () => {
    const waitForSelector = vi.fn().mockResolvedValue(undefined);
    getPage.mockResolvedValue({ waitForSelector });
    const res = await wait({ selector: '#app' });
    expect(waitForSelector).toHaveBeenCalledWith('#app', { timeout: 30000 });
    expect(getPage).toHaveBeenCalledWith({ workspaceId: 'ws-test' });
    expect(mockSendRpc).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain('selector "#app" found');
  });

  it('acquires and releases an automation lease around a Page wait', async () => {
    mockLeaseRpc.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'browser.lease.acquire'
          ? { token: 'lease-1' }
          : {},
      ));
    const waitForSelector = vi.fn().mockResolvedValue(undefined);
    getPage.mockResolvedValue({ waitForSelector });

    await wait({ selector: '#app', surfaceId: 'surface-1' });

    // The lifecycle drain rides between acquire and the body — filter it out:
    // this test is about the lease bracket, not the drain.
    const leaseCalls = mockLeaseRpc.mock.calls.filter(
      (c) => c[0] !== 'browser.lifecycle.get',
    );
    expect(leaseCalls).toEqual([
      ['browser.lease.acquire', { workspaceId: 'ws-test', surfaceId: 'surface-1' }],
      ['browser.lease.release', { token: 'lease-1' }],
    ]);
  });
});
