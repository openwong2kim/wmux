import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The RPC lane's own surface.
 *
 * Two lanes drive a browser: the Playwright page and the workspace-scoped
 * RPCs. The page lane resolves an unnamed surface per connection; the RPC lane
 * sent no surfaceId at all, and main answers that with the workspace's first
 * live session. Live dogfood on the builtin backend: agent A opened a tab,
 * agent B's `browser_navigate` (which never asks for a Page there) landed on
 * A's page, and A's first navigate — with no surface open anywhere — failed
 * with BROWSER_NO_TARGET instead of opening its own.
 *
 * These pin both halves: a caller never drives a surface it does not own, and
 * a caller with none gets one.
 */

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

const getPage = vi.fn();
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      getPageForScope: getPage,
      // Builtin: the navigate tool takes the RPC lane, never a Page.
      resolveWorkspaceBackend: async () => 'builtin',
      drainLocalLifecycle: () => [],
    }),
  },
}));

import { registerNavigationTools } from '../tools/navigation';
import { registerInteractionTools } from '../tools/interaction';
import type { BrowserToolDeps } from '../browserScope';
import { createConnectionScope, runInConnectionScope } from '../../connectionScope';
import { __resetSurfaceRoutingForTesting, getOpenerKey } from '../surfaceRouting';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function tools(): Map<string, ToolHandler> {
  const collected = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => collected.set(name, handler),
  };
  const deps: BrowserToolDeps = { resolveWorkspaceId: async () => 'ws-1' };
  registerNavigationTools(server as never, deps);
  registerInteractionTools(server as never, deps);
  return collected;
}

/**
 * A builtin main holding surfaces owned by `owners` (surfaceId → opener key),
 * which mints `newSurfaceId` when asked for a new tab. Records every call.
 */
function mainWith(
  owners: Record<string, string | undefined>,
  newSurfaceId = 'surf-new',
  // How many cdp.info answers a freshly opened surface stays INVISIBLE for.
  // A builtin pane registers its CDP target a moment after it is created, and
  // main refuses a call naming a surface it cannot see yet — the live dogfood
  // failure — so the lane has to wait for the registration rather than fire
  // into the gap.
  registerAfter = 0,
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const pending = new Map<string, number>();
  mockSendRpc.mockImplementation((method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (method === 'browser.cdp.info') {
      const callerKey = params.openerKey;
      return Promise.resolve({
        targetsScoped: true,
        workspaceBackend: 'builtin',
        targets: Object.entries(owners)
          .filter(([surfaceId]) => {
            const left = pending.get(surfaceId);
            if (left === undefined) return true;
            if (left <= 0) { pending.delete(surfaceId); return true; }
            pending.set(surfaceId, left - 1);
            return false;
          })
          .map(([surfaceId, owner]) => ({
            surfaceId,
            ...(owner !== undefined && { opener: owner === callerKey ? 'mine' : 'other' }),
          })),
      });
    }
    if (method === 'browser.tabs' && params.action === 'list') {
      return Promise.resolve({
        ok: true,
        action: 'list',
        tabs: Object.entries(owners).map(([surfaceId, owner]) => ({
          surfaceId,
          paneId: `pane-${surfaceId}`,
          url: '',
          title: '',
          selected: false,
          ...(owner !== undefined && { opener: 'other' }),
        })),
      });
    }
    if (method === 'browser.tabs' && params.action === 'new') {
      owners[newSurfaceId] = params.openerKey as string;
      if (registerAfter > 0) pending.set(newSurfaceId, registerAfter);
      return Promise.resolve({
        ok: true,
        action: 'new',
        tab: { surfaceId: newSurfaceId, paneId: 'pane-new', url: '', title: '', selected: false, opener: 'mine' },
      });
    }
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: null });
    if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
    if (method === 'browser.evaluate') return Promise.resolve({ value: 'https://b.test/' });
    return Promise.resolve({ ok: true });
  });
  return calls;
}

beforeEach(() => {
  mockSendRpc.mockReset();
  __resetSurfaceRoutingForTesting();
  getPage.mockReset();
  getPage.mockResolvedValue(null); // builtin RPC lane: no Page to be had
});

describe('browser_navigate on the builtin RPC lane', () => {
  it('opens its own surface instead of driving the one another agent opened', async () => {
    const a = createConnectionScope();
    const b = createConnectionScope();
    const openerA = runInConnectionScope(a, () => getOpenerKey());
    const calls = mainWith({ 'surf-a': openerA });

    const result = await runInConnectionScope(b, () =>
      tools().get('browser_navigate')!({ url: 'https://b.test/' }),
    );

    expect(result.isError).toBeUndefined();
    const navigate = calls.find((c) => c.method === 'browser.navigate');
    // The navigation names a surface, and it is NOT A's.
    expect(navigate?.params.surfaceId).toBe('surf-new');
    expect(navigate?.params.surfaceId).not.toBe('surf-a');
    // B's own surface was created for it rather than A's being taken.
    expect(calls.some((c) => c.method === 'browser.tabs' && c.params.action === 'new')).toBe(true);
  });

  it('opens one for a caller whose workspace has no surface at all', async () => {
    // The other half of the dogfood: this used to fail with BROWSER_NO_TARGET
    // because the RPC lane never auto-opened, while the page lane did.
    const calls = mainWith({});

    const result = await tools().get('browser_navigate')!({ url: 'https://a.test/' });

    expect(result.isError).toBeUndefined();
    expect(calls.find((c) => c.method === 'browser.navigate')?.params.surfaceId).toBe('surf-new');
  });

  it('stays on the surface it opened for every later call', async () => {
    const calls = mainWith({});
    const navigate = tools().get('browser_navigate')!;

    await navigate({ url: 'https://a.test/' });
    await navigate({ url: 'https://a.test/second' });

    const navigations = calls.filter((c) => c.method === 'browser.navigate');
    expect(navigations).toHaveLength(2);
    expect(navigations[1].params.surfaceId).toBe('surf-new');
    // One open, not one per call.
    expect(calls.filter((c) => c.method === 'browser.tabs' && c.params.action === 'new')).toHaveLength(1);
  });
});

describe('another RPC-lane tool', () => {
  it('sends browser_type to this caller\'s own surface, never the other agent\'s', async () => {
    const a = createConnectionScope();
    const b = createConnectionScope();
    const openerA = runInConnectionScope(a, () => getOpenerKey());
    const calls = mainWith({ 'surf-a': openerA });

    await runInConnectionScope(b, () =>
      tools().get('browser_type')!({ selector: '#q', text: 'hello' }),
    );

    // Whatever the tool reached for, it named a surface and it was not A's.
    const targeted = calls.filter(
      (c) => c.method.startsWith('browser.') && 'surfaceId' in c.params,
    );
    expect(targeted.length).toBeGreaterThan(0);
    for (const call of targeted) expect(call.params.surfaceId).not.toBe('surf-a');
  });

  it('never drains another connection\'s lifecycle ring', async () => {
    // The drain is DESTRUCTIVE on main's side: an unnamed one would take A's
    // events out of A's next result and report them in B's.
    const a = createConnectionScope();
    const openerA = runInConnectionScope(a, () => getOpenerKey());
    const calls = mainWith({ 'surf-a': openerA }, 'surf-b');

    // A connection with no surface of its own and no way to open one.
    mockSendRpc.mockImplementationOnce((method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return Promise.resolve({
        targetsScoped: true,
        workspaceBackend: 'builtin',
        targets: [{ surfaceId: 'surf-a', opener: 'other' }],
      });
    });

    const b = createConnectionScope();
    await runInConnectionScope(b, () => tools().get('browser_navigate')!({ url: 'https://b.test/' }));

    for (const drain of calls.filter((c) => c.method === 'browser.lifecycle.get')) {
      expect(drain.params.surfaceId).not.toBe('surf-a');
      expect(drain.params.surfaceId).toBeDefined();
    }
  });
});

describe('a surface that is not addressable yet', () => {
  it('waits for the new pane to register before naming it', async () => {
    // The live dogfood failure: the pane is created, the navigate fires a
    // millisecond later, and main answers "no browser surface is open in this
    // workspace" because the guest has not registered its target yet.
    const calls = mainWith({}, 'surf-new', 2);

    const result = await tools().get('browser_navigate')!({ url: 'https://a.test/' });

    expect(result.isError).toBeUndefined();
    const navigate = calls.find((c) => c.method === 'browser.navigate');
    expect(navigate?.params.surfaceId).toBe('surf-new');
    // It asked again rather than firing into the gap.
    const infoAfterOpen = calls
      .slice(calls.findIndex((c) => c.method === 'browser.tabs' && c.params.action === 'new'))
      .filter((c) => c.method === 'browser.cdp.info');
    expect(infoAfterOpen.length).toBeGreaterThan(1);
  });

  it('refuses with what is actually true when no surface can be opened', async () => {
    const a = createConnectionScope();
    const openerA = runInConnectionScope(a, () => getOpenerKey());
    mockSendRpc.mockImplementation((method: string, params: Record<string, unknown> = {}) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({
          targetsScoped: true,
          workspaceBackend: 'builtin',
          targets: [
            { surfaceId: 'surf-a1', opener: params.openerKey === openerA ? 'mine' : 'other' },
            { surfaceId: 'surf-a2', opener: params.openerKey === openerA ? 'mine' : 'other' },
          ],
        });
      }
      if (method === 'browser.tabs' && params.action === 'list') {
        return Promise.resolve({ ok: true, action: 'list', tabs: [{ surfaceId: 'surf-a1', opener: 'other' }] });
      }
      // Nothing can be created: the workspace is at its pane cap.
      if (method === 'browser.tabs') return Promise.resolve({ ok: false, error: { code: 'BROWSER_TAB_CREATE_FAILED', message: 'pane cap' } });
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: null });
      if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
      return Promise.resolve({});
    });

    const b = createConnectionScope();
    const result = await runInConnectionScope(b, () =>
      tools().get('browser_navigate')!({ url: 'https://b.test/' }),
    );

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('BROWSER_NO_OWN_SURFACE');
    // Not "nothing is open here": surfaces ARE open, they are other agents'.
    expect(text).toContain('2 browser surface(s) in this workspace belong to other agents');
    expect(text).toContain('browser_tabs list');
    expect(text).not.toContain('no browser surface is open in this workspace');
  });
});
