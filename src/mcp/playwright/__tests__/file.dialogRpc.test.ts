import { beforeEach, describe, expect, it, vi } from 'vitest';

// browser_dialog on a builtin tab with no Playwright page: main answers that
// tab's dialogs, so the answer is armed there. With a page, or on another
// backend, nothing goes to main.

const { mockSendRpc, getPage, resolveWorkspaceBackend } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveWorkspaceBackend: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    method.startsWith('browser.lease.') || method === 'browser.lifecycle.get'
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPageForScope: getPage, resolveWorkspaceBackend }) },
}));

import { registerFileTools } from '../tools/file';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const tools = new Map<string, ToolHandler>();
registerFileTools(
  { tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => tools.set(name, handler) } as never,
  { resolveWorkspaceId: vi.fn(async () => 'ws-test') },
);
const dialog = tools.get('browser_dialog') as ToolHandler;
const armCalls = () => mockSendRpc.mock.calls.filter(([method]) => method === 'browser.dialog.arm');

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  resolveWorkspaceBackend.mockReset();
  resolveWorkspaceBackend.mockResolvedValue('builtin');
});

describe('browser_dialog with no Playwright page', () => {
  it('arms the answer in main on the builtin backend', async () => {
    getPage.mockResolvedValue(null);
    const result = await dialog({ accept: true, text: 'typed', surfaceId: 's1' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Next dialog will be accepted');
    expect(armCalls()).toHaveLength(1);
    expect(armCalls()[0][1]).toMatchObject({ accept: true, text: 'typed', surfaceId: 's1' });
  });

  it('does the same when the engine has no attach info at all', async () => {
    getPage.mockRejectedValue(new Error('browser.cdp.info did not disclose a usable CDP endpoint'));
    const result = await dialog({ accept: false, surfaceId: 's1' });
    expect(result.isError).toBeFalsy();
    expect(armCalls()[0][1]).toMatchObject({ accept: false });
    expect(armCalls()[0][1]).not.toHaveProperty('text');
  });

  it('fails on another backend rather than arming nothing', async () => {
    getPage.mockResolvedValue(null);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    const result = await dialog({ accept: true, surfaceId: 's1' });
    expect(result.isError).toBe(true);
    expect(armCalls()).toEqual([]);
  });

  it("says the armed answer doesn't apply to prompt on an in-app tab, and that its text answers nothing there", async () => {
    getPage.mockResolvedValue(null);
    const plain = await dialog({ accept: true, surfaceId: 's1' });
    expect(plain.content[0].text).toContain("This doesn't apply to prompt: it isn't available on in-app tabs; the page sees an error instead of a dialog.");
    const withText = await dialog({ accept: true, text: 'typed', surfaceId: 's1' });
    expect(withText.content[0].text).toContain("The text applies to nothing here: prompt isn't available on in-app tabs");
  });

  it('reports a refusal from main', async () => {
    getPage.mockResolvedValue(null);
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'browser.dialog.arm') throw new Error('paused by the user');
      return {};
    });
    const result = await dialog({ accept: true, surfaceId: 's1' });
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text).join('\n')).toContain('paused by the user');
  });
});
