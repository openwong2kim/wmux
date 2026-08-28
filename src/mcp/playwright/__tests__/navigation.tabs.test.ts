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

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

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
        return undefined;
      }),
    );

    const result = await browserNavigate({ url: 'https://example.com/', surfaceId: 'surface-a' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain('[browser events]');
    expect(result.content[0].text).toContain('https://example.com/redirect-hop');
    expect(result.content[0].text).not.toContain('- navigated: https://example.com/ (');
    expect(result.content[1].text).toBe('Navigated to https://example.com/');
  });

  it('a plain navigation carries no events block — the lone self-echo is suppressed', async () => {
    const queue: unknown[] = [];
    mockSendRpc.mockImplementation(
      leasedRouter(queue, (method) => {
        if (method === 'browser.navigate') {
          queue.push({ type: 'navigated', url: 'https://example.com/', ts: Date.now() });
          return { ok: true };
        }
        return undefined;
      }),
    );

    const result = await browserNavigate({ url: 'https://example.com/', surfaceId: 'surface-a' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('Navigated to https://example.com/');
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
});
