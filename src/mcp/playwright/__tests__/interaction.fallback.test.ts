import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPageForScope: getPage }) },
}));

import { registerInteractionTools } from '../tools/interaction';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInteractionTools(server as never, browserToolDeps);
  return tools;
}

const fill = collectTools().get('browser_fill');
if (!fill) throw new Error('browser_fill failed to register');

beforeEach(() => {
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  getPage.mockResolvedValue(null);
});

describe('browser_fill RPC fallback workspace scope', () => {
  it('scopes click, select-all evaluation, and typing to the same target', async () => {
    const result = await fill({
      fields: [{ ref: 'field-1', value: 'new value' }],
      surfaceId: 'surface-1',
    });

    expect(getPage).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      surfaceId: 'surface-1',
    });
    expect(browserToolDeps.resolveWorkspaceId).toHaveBeenCalledTimes(1);
    // The password probe runs FIRST and on the same target: browser_fill has
    // to know whether a field is a credential before it fills it, because the
    // answer decides whether the value may be recorded. It is asserted here
    // rather than filtered out — a probe that quietly stopped running would
    // put passwords into the action cache.
    const calls = mockSendRpc.mock.calls;
    expect(calls[0][0]).toBe('browser.evaluate');
    expect(String(calls[0][1].expression)).toContain('isPasswordField');
    expect(calls[0][1]).toMatchObject({ workspaceId: 'ws-test', surfaceId: 'surface-1' });
    expect(calls[1]).toEqual([
      'browser.click.cdp', {
        selector: '[data-wmux-ref="field-1"]',
        workspaceId: 'ws-test',
        surfaceId: 'surface-1',
      },
    ]);
    // Between the click and the typing: did the click actually take focus?
    // `selectAll` and `Input.insertText` both act on the DOCUMENT's focused
    // node, so a selector naming something unfocusable would have overwritten
    // whichever field the page had focused instead.
    expect(calls[2][0]).toBe('browser.evaluate');
    expect(String(calls[2][1].expression)).toContain('activeElement');
    expect(calls[2][1]).toMatchObject({ workspaceId: 'ws-test', surfaceId: 'surface-1' });
    expect(calls.slice(3)).toEqual([
      ['browser.evaluate', {
        expression: "document.execCommand('selectAll')",
        workspaceId: 'ws-test',
        surfaceId: 'surface-1',
      }],
      ['browser.type.cdp', {
        text: 'new value',
        workspaceId: 'ws-test',
        surfaceId: 'surface-1',
      }],
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('Filled 1/1 field(s).');
  });

  it('types nothing when the click did not take focus, instead of overwriting another field', async () => {
    mockSendRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== 'browser.evaluate') return {};
      const expression = String(params.expression ?? '');
      if (expression.includes('isPasswordField')) return { value: 'no' };
      if (expression.includes('activeElement')) return { value: 'wmux-caret:lost' };
      return { value: '' };
    });

    const result = await fill({
      fields: [{ ref: 'field-1', value: 'new value' }],
      surfaceId: 'surface-1',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('did not take focus');
    // The two calls that act on the focused node are the ones that never ran.
    const sent = mockSendRpc.mock.calls.map(([method, params]) =>
      `${method}:${String((params as { expression?: string }).expression ?? '')}`);
    expect(sent.some((c) => c.includes('selectAll'))).toBe(false);
    expect(sent.some((c) => c.startsWith('browser.type.cdp'))).toBe(false);
  });
});
