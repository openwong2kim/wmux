import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import type { BrowserBackendStore } from '../../../browser-session/BrowserBackendStore';
import type {
  BorrowApprovalOutcome,
  LiveTabOwner,
  LiveWriteScope,
} from '../../../../shared/liveWriteScope';

/**
 * Live Chrome, agent window: the main-lane half of the write gate.
 *
 * Reads keep today's full exposure — the workspace's live binding is that
 * consent — while every write is confined to the tabs the agent opened plus the
 * tabs the user lent it. The MCP Playwright lane enforces the same policy
 * separately (see PlaywrightEngine.liveWriteScope.test.ts); neither is a
 * substitute for the other, because many writes never reach main at all.
 */

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
const { validateResolvedNavigationUrlMock } = vi.hoisted(() => ({
  validateResolvedNavigationUrlMock: vi.fn(),
}));

// A guest that accepts listeners and answers CDP, so a call that PASSES the gate
// actually completes instead of failing for an unrelated reason.
const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  loadURL: vi.fn(async () => undefined),
  getURL: vi.fn(() => 'https://agent.test/'),
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    if (event === 'did-navigate') setTimeout(() => fn(), 0);
  }),
  off: vi.fn(),
  executeJavaScript: vi.fn(async () => 'ok'),
  debugger: {
    sendCommand: vi.fn(async (method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'evaluated', type: 'string' } };
      if (method === 'Network.getAllCookies') return { cookies: [{ name: 'a', value: 'b' }] };
      return {};
    }),
    isAttached: vi.fn(() => true),
    attach: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
};

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => mockWebContents) },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: validateResolvedNavigationUrlMock,
}));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const TARGET = {
  surfaceId: 'surface-1',
  webContentsId: 42,
  targetId: 'target-1',
  wsUrl: 'ws://127.0.0.1/devtools/page/target-1',
  workspaceId: 'ws-1',
};

/** The live tabs every test starts from: one the agent opened, one lent to it,
 *  one the user's own, and one another workspace opened. */
const LIVE_TABS = [
  { surfaceId: 'agent-tab', targetId: 'agent-tab', url: 'https://agent.test/', title: 'Agent' },
  { surfaceId: 'lent-tab', targetId: 'lent-tab', url: 'https://lent.test/', title: 'Lent' },
  { surfaceId: 'user-tab', targetId: 'user-tab', url: 'https://mail.example.com/x', title: 'Inbox (12)' },
  { surfaceId: 'other-ws-tab', targetId: 'other-ws-tab', url: 'https://b.test/', title: 'Theirs' },
];

/**
 * A LiveChromeClient stand-in. `writeScope` is what tells browser.rpc this is
 * live at all, so a fake without it is a fake dedicated instance — which is how
 * the "no gate on dedicated" case below is expressed.
 */
function makeFakeLive(options: { withScope?: boolean } = {}) {
  const owners = new Map<string, string>([
    ['agent-tab', 'ws-1'],
    ['other-ws-tab', 'ws-2'],
  ]);
  const borrowed = new Map<string, string>([['lent-tab', 'ws-1']]);
  const pending = new Map<string, string>();
  const ownerOf = (surfaceId: string, workspaceId: string | undefined): LiveTabOwner => {
    if (owners.get(surfaceId) === workspaceId) return 'agent';
    if (workspaceId !== undefined && borrowed.get(surfaceId) === workspaceId) return 'borrowed';
    return 'user';
  };
  const writeScope = {
    ownerOf: vi.fn(ownerOf),
    beginBorrow: vi.fn((surfaceId: string, workspaceId: string) => {
      if (pending.has(surfaceId)) return false;
      pending.set(surfaceId, workspaceId);
      return true;
    }),
    settleBorrow: vi.fn((surfaceId: string, workspaceId: string, granted: boolean) => {
      pending.delete(surfaceId);
      if (granted) borrowed.set(surfaceId, workspaceId);
    }),
    returnBorrow: vi.fn((surfaceId: string, workspaceId: string) => {
      if (borrowed.get(surfaceId) !== workspaceId) return false;
      borrowed.delete(surfaceId);
      return true;
    }),
    clearBorrows: vi.fn(),
    agentWindowFor: vi.fn(() => 7),
  };
  return {
    owners,
    borrowed,
    scope: writeScope,
    ...(options.withScope === false ? {} : { writeScope }),
    endpoint: vi.fn(async () => ({ wsEndpoint: 'ws://127.0.0.1:9333/devtools/browser/abc' })),
    cdpInfoTargets: vi.fn(async (workspaceId?: string) =>
      LIVE_TABS.filter((t) => ownerOf(t.surfaceId, workspaceId) !== 'user').map((t) => ({
        ...t,
        workspaceId,
        owner: ownerOf(t.surfaceId, workspaceId),
      })),
    ),
    // Full exposure by design: every live tab is listed, whoever owns it.
    listTargets: vi.fn(async () => LIVE_TABS.map((t) => ({ ...t }))),
    openTab: vi.fn(async (url: string, workspaceId?: string) => {
      owners.set('new-tab', workspaceId ?? '');
      return { surfaceId: 'new-tab', targetId: 'new-tab', url };
    }),
    closeSurface: vi.fn(async () => true),
    selectSurface: vi.fn(async () => true),
    hasSurface: vi.fn(() => true),
    dispose: vi.fn(),
  };
}

function register(options: {
  live?: ReturnType<typeof makeFakeLive>;
  hasTarget?: boolean;
  writeScopeSetting?: LiveWriteScope;
  borrow?: (request: unknown) => Promise<BorrowApprovalOutcome>;
}) {
  const live = options.live ?? makeFakeLive();
  const hasTarget = options.hasTarget ?? true;
  const router = new RpcRouter();
  const cdp = {
    // Answers any lookup with the ONE builtin surface it has (surface-1), the
    // way the real manager answers a default-target lookup. None of the live
    // tab ids below match it, which is what keeps the mixed-mode escape hatch
    // out of these cases — it has its own test.
    getTarget: vi.fn(() => (hasTarget ? TARGET : null)),
    listTargets: vi.fn(() => (hasTarget ? [TARGET] : [])),
    // One surface id models a builtin guest the renderer has unmounted.
    isDiscarded: vi.fn((surfaceId: string) => surfaceId === 'discarded-pane'),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn(() => 'lease-1'),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  const store = {
    get: () => 'chrome' as const,
    set: vi.fn(),
    liveWriteScope: () => options.writeScopeSetting ?? ('agent' as LiveWriteScope),
  };
  const registry = {
    forWorkspace: vi.fn(() => live),
    forProfile: vi.fn(() => live),
    ownerOfSurface: vi.fn(() => null),
    disposeAll: vi.fn(),
  };
  registerBrowserRpc(
    router,
    () => null as unknown as BrowserWindow,
    cdp as never,
    store as unknown as BrowserBackendStore,
    undefined,
    undefined,
    registry as never,
    undefined,
    undefined,
    (options.borrow ?? (async () => 'approved')) as never,
  );
  return { router, live };
}

async function dispatch(router: RpcRouter, method: string, params: Record<string, unknown> = {}) {
  const response = await router.dispatch({ id: '1', method, params } as never);
  if (response.ok) return { result: (response as { result?: unknown }).result };
  return { error: String((response as { error?: unknown }).error ?? '') };
}

/** Every write RPC in the gated set, with params valid enough to reach a page. */
const WRITE_CALLS: Array<[string, Record<string, unknown>]> = [
  ['browser.navigate', { url: 'https://evil.test/' }],
  ['browser.goBack', {}],
  ['browser.click.cdp', { x: 10, y: 10 }],
  ['browser.type.cdp', { text: 'hello' }],
  ['browser.press.cdp', { key: 'Enter' }],
  ['browser.hover.cdp', { x: 10, y: 10 }],
  ['browser.drag.cdp', { fromX: 1, fromY: 1, toX: 9, toY: 9 }],
  ['browser.evaluate', { expression: '1 + 1' }],
  ['browser.cookies', { action: 'set', cookies: [{ name: 'a', value: 'b' }] }],
  ['browser.cookies', { action: 'clear' }],
  ['browser.emulate', { offline: true }],
  ['browser.resize', { width: 800, height: 600 }],
  ['browser.close', {}],
];

beforeEach(() => {
  vi.clearAllMocks();
  validateResolvedNavigationUrlMock.mockResolvedValue({ valid: true });
  sendToRendererMock.mockResolvedValue({ ok: true });
});

describe('live write gate: every write RPC', () => {
  for (const [method, params] of WRITE_CALLS) {
    const label = `${method}${params['action'] ? ` (${String(params['action'])})` : ''}`;

    it(`${label} on a USER tab is refused with agent_window_scope, before any dispatch`, async () => {
      const { router } = register({});
      const { error } = await dispatch(router, method, {
        ...params,
        surfaceId: 'user-tab',
        workspaceId: 'ws-1',
      });
      expect(error).toMatch(/^agent_window_scope:/);
      expect(error).toContain('borrow it first: browser_tabs action:"borrow" surfaceId:"user-tab"');
      // Nothing was driven: no CDP command, no navigation, no renderer bridge.
      expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();
      expect(mockWebContents.loadURL).not.toHaveBeenCalled();
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it(`${label} on a tab ANOTHER workspace opened is refused too`, async () => {
      // Exact ownership: an agent tab belonging to ws-2 is, from ws-1, the same
      // thing as a stranger's tab.
      const { router } = register({});
      const { error } = await dispatch(router, method, {
        ...params,
        surfaceId: 'other-ws-tab',
        workspaceId: 'ws-1',
      });
      expect(error).toMatch(/^agent_window_scope:/);
    });

    it(`${label} on the workspace OWN tab reaches the handler`, async () => {
      const { router } = register({});
      const res = await dispatch(router, method, {
        ...params,
        surfaceId: 'agent-tab',
        workspaceId: 'ws-1',
      });
      expect(res.error ?? '').not.toMatch(/agent_window_scope/);
    });

    it(`${label} on a BORROWED tab reaches the handler`, async () => {
      const { router } = register({});
      const res = await dispatch(router, method, {
        ...params,
        surfaceId: 'lent-tab',
        workspaceId: 'ws-1',
      });
      expect(res.error ?? '').not.toMatch(/agent_window_scope/);
    });
  }
});

describe('live write gate: what it does NOT touch', () => {
  it('a read on the user own tab still works - that exposure is the live binding', async () => {
    const { router } = register({});
    const { result, error } = await dispatch(router, 'browser.evaluate', {
      expression: 'document.title',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
      // browser.evaluate is in the write set: running arbitrary JS in a page is
      // a write however it is used. The reads below are the ones that stay open.
    });
    expect(error).toMatch(/^agent_window_scope:/);
    expect(result).toBeUndefined();

    const read = await dispatch(router, 'browser.console.get', {
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(read.error ?? '').not.toMatch(/agent_window_scope/);

    const cookies = await dispatch(router, 'browser.cookies', {
      action: 'get',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    // A cookie READ on a user tab is exactly as open as it was before: the
    // method is gated, the action decides.
    expect(cookies.error ?? '').not.toMatch(/agent_window_scope/);
    expect(cookies.result).toEqual({ cookies: [{ name: 'a', value: 'b' }] });
  });

  it('a write with NO surfaceId is not gated - it cannot be pointed at a user tab', async () => {
    // The only thing main does with an unnamed write on this backend is open a
    // fresh tab, and a tab wmux just opened is agent-owned.
    const { router, live } = register({ hasTarget: false });
    const { result } = await dispatch(router, 'browser.navigate', {
      url: 'https://a.test/',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({ ok: true, backend: 'chrome', surfaceId: 'new-tab' });
    expect(live.openTab).toHaveBeenCalledWith('https://a.test/', 'ws-1');
  });

  it("liveWriteScope 'all' restores full write exposure", async () => {
    const { router } = register({ writeScopeSetting: 'all' });
    const res = await dispatch(router, 'browser.click.cdp', {
      x: 5,
      y: 5,
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(res.error ?? '').not.toMatch(/agent_window_scope/);
  });

  it('a builtin surface is never gated: a manual pane under this backend is not a live tab', async () => {
    // Mixed mode. The user opened a wmux browser pane while the workspace is
    // bound to Live Chrome; its surface is a webview, and the live ownership map
    // has never heard of it. Refusing it would break a pane they opened
    // themselves.
    const { router } = register({});
    const res = await dispatch(router, 'browser.click.cdp', {
      x: 5,
      y: 5,
      surfaceId: TARGET.surfaceId,
      workspaceId: 'ws-1',
    });
    expect(res.error ?? '').not.toMatch(/agent_window_scope/);
  });

  it('a DISCARDED builtin surface is not gated either (the handler wakes it)', async () => {
    const live = makeFakeLive();
    const { router } = register({ live, hasTarget: false });
    // hasTarget:false models the discard: getTarget answers nothing until the
    // guest remounts, and only isDiscarded still knows the surface is builtin.
    const res = await dispatch(router, 'browser.click.cdp', {
      x: 5,
      y: 5,
      surfaceId: 'discarded-pane',
      workspaceId: 'ws-1',
    });
    // Without the isDiscarded check this refused with agent_window_scope; the
    // honest answer is the chrome contract error (no live builtin target).
    expect(res.error ?? '').not.toMatch(/agent_window_scope/);
  });

  it('a DEDICATED chrome instance is never gated (every tab there is one wmux opened)', async () => {
    const dedicated = makeFakeLive({ withScope: false });
    const { router } = register({ live: dedicated });
    const res = await dispatch(router, 'browser.click.cdp', {
      x: 5,
      y: 5,
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(res.error ?? '').not.toMatch(/agent_window_scope/);
  });
});

describe('browser_tabs list scope + owner labels', () => {
  it('list defaults to every tab, each labelled with who may write to it', async () => {
    const { router } = register({});
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'list',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({ ok: true, action: 'list' });
    expect((result as { tabs: Array<{ surfaceId: string; owner: string }> }).tabs).toEqual([
      expect.objectContaining({ surfaceId: 'agent-tab', owner: 'agent' }),
      expect.objectContaining({ surfaceId: 'lent-tab', owner: 'borrowed' }),
      expect.objectContaining({ surfaceId: 'user-tab', owner: 'user' }),
      expect.objectContaining({ surfaceId: 'other-ws-tab', owner: 'user' }),
    ]);
  });

  it("scope 'agent' lists what this workspace may write to - its own plus the lent one", async () => {
    const { router } = register({});
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'list',
      scope: 'agent',
      workspaceId: 'ws-1',
    });
    expect((result as { tabs: Array<{ surfaceId: string }> }).tabs.map((t) => t.surfaceId)).toEqual([
      'agent-tab',
      'lent-tab',
    ]);
  });

  it("scope 'user' lists the rest of the browser", async () => {
    const { router } = register({});
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'list',
      scope: 'user',
      workspaceId: 'ws-1',
    });
    expect((result as { tabs: Array<{ surfaceId: string }> }).tabs.map((t) => t.surfaceId)).toEqual([
      'user-tab',
      'other-ws-tab',
    ]);
  });

  it('an unknown scope is an argument error, not a silent "all"', async () => {
    const { router } = register({});
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'list',
      scope: 'everything',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'BROWSER_TABS_INVALID_ARGUMENT' },
    });
  });

  it('browser_tabs close refuses a user tab, like every other write', async () => {
    const { router, live } = register({});
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'close',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'BROWSER_TABS_SCOPE_REFUSED' } });
    expect((result as { error: { message: string } }).error.message).toMatch(/^agent_window_scope:/);
    expect(live.closeSurface).not.toHaveBeenCalled();
  });
});

describe('browser_tabs borrow / return', () => {
  it('approve lends the tab and every write to it then passes', async () => {
    const borrow = vi.fn(async () => 'approved' as BorrowApprovalOutcome);
    const { router } = register({ borrow });
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'borrow',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({
      ok: true,
      action: 'borrow',
      result: 'borrowed',
      tab: expect.objectContaining({ surfaceId: 'user-tab', owner: 'borrowed' }),
    });
    // The human saw the tab's own title and origin, not an opaque id.
    expect(borrow).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      surfaceId: 'user-tab',
      title: 'Inbox (12)',
      origin: 'https://mail.example.com',
    });

    const write = await dispatch(router, 'browser.click.cdp', {
      x: 1,
      y: 1,
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(write.error ?? '').not.toMatch(/agent_window_scope/);
  });

  it('deny keeps the tab the user own and says user_denied', async () => {
    const { router } = register({ borrow: async () => 'denied' });
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'borrow',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'BROWSER_TAB_BORROW_REFUSED' } });
    expect((result as { error: { message: string } }).error.message).toMatch(/^user_denied:/);

    const write = await dispatch(router, 'browser.click.cdp', {
      x: 1,
      y: 1,
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(write.error).toMatch(/^agent_window_scope:/);
  });

  it('a deadline nobody answered is a refusal that says borrow_timeout', async () => {
    const { router } = register({ borrow: async () => 'timeout' });
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'borrow',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect((result as { error: { message: string } }).error.message).toMatch(/^borrow_timeout:/);
  });

  it('a second request while one is on screen is refused with borrow_pending', async () => {
    const releases: Array<(outcome: BorrowApprovalOutcome) => void> = [];
    const borrow = vi.fn(
      () => new Promise<BorrowApprovalOutcome>((resolve) => releases.push(resolve)),
    );
    const { router } = register({ borrow });

    const first = dispatch(router, 'browser.tabs', {
      action: 'borrow',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    // Let the first request reach the prompt before the second arrives.
    await new Promise((r) => setTimeout(r, 0));
    const second = await dispatch(router, 'browser.tabs', {
      action: 'borrow',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });

    expect((second.result as { error: { message: string } }).error.message).toMatch(
      /^borrow_pending:/,
    );
    // Exactly one question reached the human.
    expect(borrow).toHaveBeenCalledTimes(1);

    releases[0]('approved');
    expect((await first).result).toMatchObject({ ok: true, action: 'borrow' });
  });

  it("under the 'all' opt-out nothing is asked: the tab is already writable", async () => {
    // A prompt here would ask permission the operator already granted in the
    // settings file, which trains the user to click Approve.
    const borrow = vi.fn(async () => 'approved' as BorrowApprovalOutcome);
    const { router } = register({ borrow, writeScopeSetting: 'all' });
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'borrow',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({ ok: true, action: 'borrow', result: 'borrowed' });
    expect(borrow).not.toHaveBeenCalled();
  });

  it("under the 'all' opt-out scope:'agent' hides nothing — everything is writable", async () => {
    const { router } = register({ writeScopeSetting: 'all' });
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'list',
      scope: 'agent',
      workspaceId: 'ws-1',
    });
    // The labels still report who opened what; the FILTER would otherwise
    // announce a narrower write set than the policy actually grants.
    expect((result as { tabs: Array<{ surfaceId: string }> }).tabs.map((t) => t.surfaceId)).toEqual([
      'agent-tab',
      'lent-tab',
      'user-tab',
      'other-ws-tab',
    ]);
  });

  it("under the 'all' opt-out browser_tabs close is not refused", async () => {
    const { router, live } = register({ writeScopeSetting: 'all' });
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'close',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({ ok: true, action: 'close' });
    expect(live.closeSurface).toHaveBeenCalledWith('user-tab');
  });

  it('borrowing a tab the workspace already owns asks nobody', async () => {
    const borrow = vi.fn(async () => 'approved' as BorrowApprovalOutcome);
    const { router } = register({ borrow });
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'borrow',
      surfaceId: 'agent-tab',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({ ok: true, action: 'borrow', result: 'borrowed' });
    expect(borrow).not.toHaveBeenCalled();
  });

  it('return hands the tab back, and the next write is refused again', async () => {
    const { router } = register({});
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'return',
      surfaceId: 'lent-tab',
      workspaceId: 'ws-1',
    });
    expect(result).toEqual({ ok: true, action: 'return', surfaceId: 'lent-tab', returned: true });

    const write = await dispatch(router, 'browser.click.cdp', {
      x: 1,
      y: 1,
      surfaceId: 'lent-tab',
      workspaceId: 'ws-1',
    });
    expect(write.error).toMatch(/^agent_window_scope:/);
  });

  it('returning a tab the workspace never held is reported, not an error', async () => {
    const { router } = register({});
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'return',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(result).toEqual({ ok: true, action: 'return', surfaceId: 'user-tab', returned: false });
  });

  it('borrow without a surfaceId is an argument error', async () => {
    const { router } = register({});
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'borrow',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'BROWSER_TABS_INVALID_ARGUMENT' },
    });
  });

  it('borrow on a DEDICATED chrome instance is unsupported, not a silent grant', async () => {
    const { router } = register({ live: makeFakeLive({ withScope: false }) });
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'borrow',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'BROWSER_TAB_BORROW_UNSUPPORTED' },
    });
  });

  it('with no way to ask the human, borrow refuses rather than granting', async () => {
    const router = new RpcRouter();
    const live = makeFakeLive();
    const cdp = {
      getTarget: vi.fn(() => TARGET),
      listTargets: vi.fn(() => [TARGET]),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      setCaptureAttach: vi.fn(),
      withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };
    registerBrowserRpc(
      router,
      () => null as unknown as BrowserWindow,
      cdp as never,
      { get: () => 'chrome', set: vi.fn() } as unknown as BrowserBackendStore,
      undefined,
      undefined,
      {
        forWorkspace: () => live,
        forProfile: () => live,
        ownerOfSurface: () => null,
        disposeAll: vi.fn(),
      } as never,
      // …and no borrow requester wired at all.
    );
    const { result } = await dispatch(router, 'browser.tabs', {
      action: 'borrow',
      surfaceId: 'user-tab',
      workspaceId: 'ws-1',
    });
    expect((result as { error: { message: string } }).error.message).toMatch(/^user_denied:/);
  });
});

describe('browser.cdp.info reports the policy and the owner of each seeded tab', () => {
  it('carries liveWriteScope and labels the rows the MCP lane will check', async () => {
    const { router } = register({});
    const { result } = await dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-1' });
    const info = result as {
      liveWriteScope?: string;
      targets: Array<{ surfaceId: string; owner?: string }>;
    };
    // Disclosed unconditionally (unlike wsEndpoint): a lane that cannot read the
    // policy would silently skip the gate.
    expect(info.liveWriteScope).toBe('agent');
    expect(info.targets).toEqual([
      expect.objectContaining({ surfaceId: 'agent-tab', owner: 'agent' }),
      expect.objectContaining({ surfaceId: 'lent-tab', owner: 'borrowed' }),
    ]);
  });

  it("reports 'all' when the operator has opted out", async () => {
    const { router } = register({ writeScopeSetting: 'all' });
    const { result } = await dispatch(router, 'browser.cdp.info', { workspaceId: 'ws-1' });
    expect((result as { liveWriteScope?: string }).liveWriteScope).toBe('all');
  });
});
