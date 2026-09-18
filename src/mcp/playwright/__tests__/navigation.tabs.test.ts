import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mockSendRpc = vi.fn();
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import {
  BROWSER_TABS_SHAPE,
  registerNavigationTools,
} from '../tools/navigation';
import type { BrowserToolDeps } from '../browserScope';
import { BORROW_APPROVAL_DEADLINE_MS } from '../../../shared/liveWriteScope';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * The trailer every mutating browser result now ends with (resultTrailer.ts).
 * Spelled out here rather than imported: these assertions are exact on purpose,
 * and the trailer is part of what they pin.
 */
const COMMITTED = '\n\neffect_state: committed';

function collectTools(deps: BrowserToolDeps): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerNavigationTools(server as never, deps);
  return tools;
}

describe('browser navigation MCP workspace contract', () => {
  const resolveWorkspaceId = vi.fn(async () => 'ws-caller');
  let browserTabs: ToolHandler;
  let browserNavigate: ToolHandler;
  let browserNavigateBack: ToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveWorkspaceId.mockResolvedValue('ws-caller');
    const tools = collectTools({ resolveWorkspaceId });
    const tabsHandler = tools.get('browser_tabs');
    const navigateHandler = tools.get('browser_navigate');
    const backHandler = tools.get('browser_navigate_back');
    if (!tabsHandler || !navigateHandler || !backHandler) {
      throw new Error('browser navigation tools were not registered');
    }
    browserTabs = tabsHandler;
    browserNavigate = navigateHandler;
    browserNavigateBack = backHandler;
  });

  /** Leased-router helper: navigate/back now run inside withAutomationLease
   *  (#1063 follow-up), so the mock must answer lease + lifecycle traffic.
   *  `lifecycleQueue` models the ring's destructive drain. */
  function leasedRouter(
    lifecycleQueue: unknown[],
    extra?: (method: string, params?: unknown) => unknown | undefined,
  ) {
    return (method: string, params?: unknown) => {
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
      if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: lifecycleQueue.splice(0) });
      const handled = extra?.(method, params);
      return Promise.resolve(handled === undefined ? {} : handled);
    };
  }

  it('routes navigate through the calling workspace', async () => {
    mockSendRpc.mockImplementation(leasedRouter([]));

    const result = await browserNavigate({
      url: 'https://example.com/',
      surfaceId: 'surface-a',
    });

    expect(result.isError).toBeUndefined();
    expect(resolveWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockSendRpc).toHaveBeenCalledWith('browser.navigate', {
      url: 'https://example.com/',
      workspaceId: 'ws-caller',
      surfaceId: 'surface-a',
    });
  });

  it('reuses one workspace identity for goBack and its URL read', async () => {
    mockSendRpc.mockImplementation(
      leasedRouter([], (method) =>
        method === 'browser.evaluate' ? { value: 'https://example.com/previous' } : undefined,
      ),
    );

    const result = await browserNavigateBack({ surfaceId: 'surface-a' });

    expect(result.isError).toBeUndefined();
    expect(resolveWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockSendRpc.mock.calls).toEqual([
      // Lease bracket with pre/post lifecycle drains (#1063 follow-up)
      // wraps the whole body.
      ['browser.lease.acquire', { workspaceId: 'ws-caller', surfaceId: 'surface-a' }],
      ['browser.lifecycle.get', { workspaceId: 'ws-caller', surfaceId: 'surface-a' }],
      // Backend resolution (chrome fork, dogfood P2) precedes the RPC lane.
      ['browser.cdp.info', { workspaceId: 'ws-caller' }],
      ['browser.goBack', { workspaceId: 'ws-caller', surfaceId: 'surface-a' }],
      [
        'browser.evaluate',
        {
          expression: 'location.href',
          workspaceId: 'ws-caller',
          surfaceId: 'surface-a',
        },
      ],
      ['browser.lifecycle.get', { workspaceId: 'ws-caller', surfaceId: 'surface-a' }],
      ['browser.lease.release', { token: 'lease-1' }],
    ]);
  });

  it('attributes the navigation to the navigate result, suppressing only the self-echo', async () => {
    // The ring reports the redirect hop AND the final page; the final entry
    // duplicates what the result text already says, so only it is dropped.
    const queue: unknown[] = [];
    mockSendRpc.mockImplementation(
      leasedRouter(queue, (method) => {
        if (method === 'browser.navigate') {
          queue.push({ type: 'navigated', url: 'https://example.com/redirect-hop', ts: Date.now() });
          queue.push({ type: 'navigated', url: 'https://example.com/', ts: Date.now() });
          return { ok: true };
        }
        // Final-URL read after the settle: the page landed past the redirect.
        if (method === 'browser.evaluate') return { value: 'https://example.com/' };
        return undefined;
      }),
    );

    const result = await browserNavigate({ url: 'https://example.com/start', surfaceId: 'surface-a' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain('[browser events]');
    expect(result.content[0].text).toContain('https://example.com/redirect-hop');
    expect(result.content[0].text).not.toContain('- navigated: https://example.com/ (');
    expect(result.content[1].text).toBe('Navigated to https://example.com/' + COMMITTED);
  });

  it('a plain navigation carries no events block — the lone self-echo is suppressed', async () => {
    const queue: unknown[] = [];
    mockSendRpc.mockImplementation(
      leasedRouter(queue, (method) => {
        if (method === 'browser.navigate') {
          queue.push({ type: 'navigated', url: 'https://example.com/', ts: Date.now() });
          return { ok: true };
        }
        if (method === 'browser.evaluate') return { value: 'https://example.com/' };
        return undefined;
      }),
    );

    const result = await browserNavigate({ url: 'https://example.com/', surfaceId: 'surface-a' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('Navigated to https://example.com/' + COMMITTED);
  });

  it('does not issue a navigation RPC when workspace identity fails', async () => {
    resolveWorkspaceId.mockRejectedValue(new Error('Workspace identity unknown.'));

    const result = await browserNavigate({ url: 'https://example.com/' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Workspace identity unknown.');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('lists through the workspace-exact RPC and returns JSON without the internal ok flag', async () => {
    mockSendRpc.mockResolvedValue({
      ok: true,
      action: 'list',
      internal: 'must-not-cross-the-tool-boundary',
      tabs: [
        {
          surfaceId: 'surface-a',
          paneId: 'pane-a',
          url: 'https://a.example/',
          title: 'Browser',
          selected: true,
          workspaceId: 'ws-caller',
          targetId: 'cdp-secret',
        },
      ],
    });

    const result = await browserTabs({});

    expect(mockSendRpc).toHaveBeenCalledWith('browser.tabs', {
      action: 'list',
      workspaceId: 'ws-caller',
      openerKey: expect.any(String),
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      action: 'list',
      tabs: [
        {
          surfaceId: 'surface-a',
          paneId: 'pane-a',
          url: 'https://a.example/',
          title: 'Browser',
          selected: true,
          // Nobody claims this surface, so it stays available as the fallback
          // default target for a caller that has opened nothing.
          mine: 'unknown',
        },
      ],
    });
    expect(result.isError).toBeUndefined();
  });

  it.each([
    ['list', { action: 'list' }],
    ['new', { action: 'new' }],
    ['select', { action: 'select', surfaceId: 'surface-a' }],
    ['close', { action: 'close', surfaceId: 'surface-a' }],
  ])('fails %s closed before RPC when caller identity cannot be resolved', async (_action, input) => {
    resolveWorkspaceId.mockRejectedValue(new Error('identity unavailable'));

    const result = await browserTabs(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[BROWSER_TABS_WORKSPACE_UNRESOLVED]');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('addresses select by stable surfaceId, never by list position', async () => {
    mockSendRpc.mockResolvedValue({
      ok: true,
      action: 'select',
      tab: {
        surfaceId: 'surface-a',
        paneId: 'pane-a',
        url: 'https://a.example/',
        title: 'Browser',
        selected: true,
      },
    });

    await browserTabs({ action: 'select', surfaceId: 'surface-a' });

    expect(mockSendRpc).toHaveBeenCalledWith('browser.tabs', {
      action: 'select',
      workspaceId: 'ws-caller',
      surfaceId: 'surface-a',
      openerKey: expect.any(String),
    });
  });

  it('rejects the removed numeric tabId at the schema, and never reaches the RPC', async () => {
    // Pin the rejection to the tabId tombstone itself. Asserting only
    // `success === false` would still pass if someone deleted `tabId:
    // z.never()`, because zod would then strip the unknown key and the call
    // would fail later for an unrelated reason.
    const parsed = z.object(BROWSER_TABS_SHAPE).safeParse({ action: 'list', tabId: 0 });
    expect(parsed.success).toBe(false);
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.path[0]),
    ).toContain('tabId');

    // Belt and braces: a caller that bypassed the schema still finds no index
    // shim to reach — tabId is never treated as an address.
    const result = await browserTabs({ action: 'select', tabId: 0 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[BROWSER_TABS_INVALID_ARGUMENT]');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('surfaces scoped foreign/missing errors without rewriting their code', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: {
        code: 'BROWSER_TAB_NOT_FOUND',
        message: 'Browser tab was not found in the calling workspace.',
      },
    });

    const result = await browserTabs({ action: 'close', surfaceId: 'surface-foreign' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Error [BROWSER_TAB_NOT_FOUND]: Browser tab was not found in the calling workspace.',
        },
      ],
      isError: true,
    });
  });

  it('rejects unsafe new URLs before identity resolution or RPC', async () => {
    const result = await browserTabs({ action: 'new', url: 'file:///etc/passwd' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[BROWSER_TAB_URL_BLOCKED]');
    expect(resolveWorkspaceId).not.toHaveBeenCalled();
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  // #1359 — one URL, one verdict.
  //
  // `browser_tabs new` and `browser_navigate` must never disagree about a URL:
  // the dogfood hit a tab that refused an intranet host the open tab was
  // already showing. Both tools read the same policy function, so this pins
  // that they keep reading it — and that the refusal names the way out.
  describe('URL policy parity between tabs new and navigate', () => {
    async function verdicts(url: string) {
      mockSendRpc.mockImplementation(
        leasedRouter([], (method) =>
          method === 'browser.evaluate' ? { value: url } : undefined,
        ),
      );
      const tabs = await browserTabs({ action: 'new', url });
      mockSendRpc.mockClear();
      const navigate = await browserNavigate({ url });
      return {
        tabsBlocked: tabs.isError === true && tabs.content[0].text.includes('BROWSER_TAB_URL_BLOCKED'),
        navigateBlocked:
          navigate.isError === true && navigate.content[0].text.includes('URL blocked:'),
        tabsText: tabs.content[0].text,
        navigateText: navigate.content[0].text,
      };
    }

    it.each([
      ['http://10.0.0.1/', true],
      ['http://172.16.0.1/', true],
      ['http://192.168.1.1/', true],
      ['http://169.254.1.1/', true],
      ['http://localhost/', false],
    ])('%s is blocked=%s for both tools', async (url, blocked) => {
      const result = await verdicts(url);

      expect(result.tabsBlocked).toBe(blocked);
      expect(result.navigateBlocked).toBe(blocked);
    });

    it.each([
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
    ])('tells the caller how to allow %s, in both tools', async (url) => {
      const result = await verdicts(url);

      expect(result.tabsText).toContain('WMUX_ALLOW_PRIVATE_NETWORK=1');
      expect(result.navigateText).toContain('WMUX_ALLOW_PRIVATE_NETWORK=1');
    });
  });

  it('reports an older main as unsupported instead of falling back to global enumeration', async () => {
    mockSendRpc.mockRejectedValue(new Error('Unknown method: browser.tabs'));

    const result = await browserTabs({ action: 'list' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[BROWSER_TABS_UNSUPPORTED]');
  });

  it('rejects malformed renderer results instead of treating partial data as scoped', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, action: 'list' });

    const result = await browserTabs({ action: 'list' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[BROWSER_TABS_UNAVAILABLE]');
  });

  it('maps transport failures to a stable error without exposing internals', async () => {
    mockSendRpc.mockRejectedValue(new Error('pipe secret detail'));

    const result = await browserTabs({ action: 'list' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[BROWSER_TABS_UNAVAILABLE]');
    expect(result.content[0].text).not.toContain('pipe secret detail');
  });

  it('rejects fields that do not belong to the selected action', async () => {
    const listWithUrl = await browserTabs({ action: 'list', url: 'https://example.com/' });
    const newWithSurface = await browserTabs({ action: 'new', surfaceId: 'surface-a' });

    expect(listWithUrl.content[0].text).toContain('[BROWSER_TABS_INVALID_ARGUMENT]');
    expect(newWithSurface.content[0].text).toContain('[BROWSER_TABS_INVALID_ARGUMENT]');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  // ── Live-Chrome agent window: borrow / return / scope ────────────────────
  //
  // The policy is enforced in main (and again in the Playwright lane); what the
  // tool owns is the argument contract and rendering the answer, including the
  // owner label a row now carries.

  it('a list row reports who may WRITE to the tab, not only who opened it', async () => {
    mockSendRpc.mockResolvedValue({
      ok: true,
      action: 'list',
      tabs: [
        {
          surfaceId: 'user-tab',
          paneId: 'chrome:user-tab',
          url: 'https://mail.example.com/',
          title: 'Inbox',
          selected: false,
          owner: 'user',
        },
      ],
    });

    const result = await browserTabs({ action: 'list' });

    expect(JSON.parse(result.content[0].text)).toEqual({
      action: 'list',
      tabs: [
        {
          surfaceId: 'user-tab',
          paneId: 'chrome:user-tab',
          url: 'https://mail.example.com/',
          title: 'Inbox',
          selected: false,
          owner: 'user',
          mine: 'unknown',
        },
      ],
    });
  });

  it('passes the list scope through to main', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, action: 'list', tabs: [] });

    await browserTabs({ action: 'list', scope: 'agent' });

    expect(mockSendRpc).toHaveBeenCalledWith('browser.tabs', {
      action: 'list',
      workspaceId: 'ws-caller',
      scope: 'agent',
      openerKey: expect.any(String),
    });
  });

  it('scope belongs to list alone, and is refused before the RPC elsewhere', async () => {
    const result = await browserTabs({ action: 'close', surfaceId: 'surface-a', scope: 'agent' });

    expect(result.content[0].text).toContain('[BROWSER_TABS_INVALID_ARGUMENT]');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('gives borrow a deadline longer than the prompt it is waiting on', async () => {
    // sendRpc's 10 s default would have expired while the user was still reading
    // a 60 s prompt: the tool reported "temporarily unavailable" for a question
    // still on screen, and a retry inside the window came back borrow_pending.
    mockSendRpc.mockResolvedValue({
      ok: true,
      action: 'borrow',
      result: 'borrowed',
      tab: {
        surfaceId: 'user-tab',
        paneId: 'chrome:user-tab',
        url: 'https://mail.example.com/',
        title: 'Inbox',
        selected: false,
        owner: 'borrowed',
      },
    });

    await browserTabs({ action: 'borrow', surfaceId: 'user-tab' });

    const [, , timeoutMs] = mockSendRpc.mock.calls[0] as [string, unknown, number];
    expect(timeoutMs).toBeGreaterThan(BORROW_APPROVAL_DEADLINE_MS);
  });

  it('every other action keeps the default deadline, argument for argument', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, action: 'list', tabs: [] });

    await browserTabs({ action: 'list' });

    // Not "passes undefined": the call shape itself is unchanged.
    expect(mockSendRpc.mock.calls[0]).toHaveLength(2);
  });

  it('renders a granted borrow with the tab now marked borrowed', async () => {
    mockSendRpc.mockResolvedValue({
      ok: true,
      action: 'borrow',
      result: 'borrowed',
      tab: {
        surfaceId: 'user-tab',
        paneId: 'chrome:user-tab',
        url: 'https://mail.example.com/',
        title: 'Inbox',
        selected: false,
        owner: 'borrowed',
      },
    });

    const result = await browserTabs({ action: 'borrow', surfaceId: 'user-tab' });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      action: 'borrow',
      result: 'borrowed',
      tab: { surfaceId: 'user-tab', owner: 'borrowed' },
    });
  });

  it.each([
    ['user_denied', 'user_denied: the user did not lend "user-tab".'],
    ['borrow_timeout', 'borrow_timeout: nobody answered within the deadline.'],
    ['borrow_pending', 'borrow_pending: the user is already being asked about "user-tab".'],
  ])('surfaces a %s refusal verbatim, so the agent can tell them apart', async (_kind, message) => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'BROWSER_TAB_BORROW_REFUSED', message },
    });

    const result = await browserTabs({ action: 'borrow', surfaceId: 'user-tab' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[BROWSER_TAB_BORROW_REFUSED]');
    expect(result.content[0].text).toContain(message);
  });

  it('renders a return, including the no-op case', async () => {
    mockSendRpc.mockResolvedValue({
      ok: true,
      action: 'return',
      surfaceId: 'user-tab',
      returned: false,
    });

    const result = await browserTabs({ action: 'return', surfaceId: 'user-tab' });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      action: 'return',
      surfaceId: 'user-tab',
      returned: false,
    });
  });

  it.each([['borrow'], ['return']])(
    '%s without a surfaceId is refused before the RPC',
    async (action) => {
      const result = await browserTabs({ action });

      expect(result.content[0].text).toContain('[BROWSER_TABS_INVALID_ARGUMENT]');
      expect(mockSendRpc).not.toHaveBeenCalled();
    },
  );

  // #922 PR-C — the scope refusal must survive the catch-all.
  //
  // Folding browser.tabs into the caller-scope table changed how a refusal
  // arrives: main now THROWS `BROWSER_SCOPE_REFUSED` instead of returning a
  // structured tabs error. The catch below relabels anything it does not
  // recognise as "temporarily unavailable", which would turn a TERMINAL
  // refusal into a transient one — the agent retries forever and never sees
  // the one sentence telling it what to change. That is exactly what
  // `scopeRefusalError`'s contract ("name it, say it is terminal, say what to
  // do instead") exists to prevent, so it is pinned here.
  it('surfaces a scope refusal verbatim instead of calling it unavailable', async () => {
    mockSendRpc.mockRejectedValue(
      new Error(
        'browser.tabs: BROWSER_SCOPE_REFUSED: omit workspaceId and this resolves ' +
          'to the workspace you claimed. Do not retry unchanged.',
      ),
    );

    const result = await browserTabs({ action: 'list' });
    const text = result.content.map((c) => c.text).join('\n');

    expect(result.isError).toBe(true);
    // The code says terminal, not transient.
    expect(text).toContain('BROWSER_TABS_SCOPE_REFUSED');
    expect(text).not.toContain('BROWSER_TABS_UNAVAILABLE');
    expect(text).not.toContain('temporarily unavailable');
    // And the remedy actually reaches the agent.
    expect(text).toContain('omit workspaceId');
    expect(text).toContain('Do not retry unchanged');
  });

  it('still reports a genuinely transient failure as unavailable', async () => {
    // The other half: relabelling must not swallow real transients either.
    mockSendRpc.mockRejectedValue(new Error('socket hang up'));

    const result = await browserTabs({ action: 'list' });
    const text = result.content.map((c) => c.text).join('\n');

    expect(text).toContain('BROWSER_TABS_UNAVAILABLE');
    expect(text).not.toContain('BROWSER_TABS_SCOPE_REFUSED');
  });

  it('still reports an old main process as unsupported', async () => {
    mockSendRpc.mockRejectedValue(new Error('Unknown method: browser.tabs'));

    const result = await browserTabs({ action: 'list' });
    const text = result.content.map((c) => c.text).join('\n');

    expect(text).toContain('BROWSER_TABS_UNSUPPORTED');
  });
});
