import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mockSendRpc = vi.fn();
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import {
  BROWSER_TABS_SHAPE,
  registerNavigationTools,
  type NavigationToolDeps,
} from '../tools/navigation';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function collectTools(deps: NavigationToolDeps): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerNavigationTools(server as never, deps);
  return tools;
}

describe('browser_tabs MCP workspace contract', () => {
  const resolveWorkspaceId = vi.fn(async () => 'ws-caller');
  let browserTabs: ToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveWorkspaceId.mockResolvedValue('ws-caller');
    const handler = collectTools({ resolveWorkspaceId }).get('browser_tabs');
    if (!handler) throw new Error('browser_tabs was not registered');
    browserTabs = handler;
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
