import { describe, expect, it, vi, beforeEach } from 'vitest';

// Packaged RPC fallback coverage for browser_wait (#114). On packaged builds
// engine.getPage() returns null and the tool must poll the condition over the
// browser.evaluate RPC channel instead of throwing "No browser page available".

vi.mock('../../wmux-client', () => ({ sendRpc: vi.fn() }));

const getPage = vi.fn();
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPage }) },
}));

import { sendRpc } from '../../wmux-client';
import { registerWaitTools } from '../tools/wait';

const mockSendRpc = sendRpc as unknown as ReturnType<typeof vi.fn>;

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerWaitTools(server as never);
  return tools;
}

const wait = collectTools().get('browser_wait')!;

beforeEach(() => {
  mockSendRpc.mockReset();
  getPage.mockReset();
  getPage.mockResolvedValue(null); // default: packaged (no Playwright Page)
});

describe('browser_wait RPC fallback', () => {
  it('polls selector presence over browser.evaluate', async () => {
    mockSendRpc.mockResolvedValue({ value: true });
    const res = await wait({ selector: '#app', surfaceId: 's1' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('selector "#app" found');
    const [method, params] = mockSendRpc.mock.calls[0] as [string, { expression: string; surfaceId?: string }];
    expect(method).toBe('browser.evaluate');
    expect(params.expression).toBe('!!document.querySelector("#app")');
    expect(params.surfaceId).toBe('s1');
  });

  it('polls text content over browser.evaluate', async () => {
    mockSendRpc.mockResolvedValue({ value: true });
    const res = await wait({ text: 'Ready' });
    expect(res.content[0].text).toContain('text "Ready" found');
    const expr = (mockSendRpc.mock.calls[0][1] as { expression: string }).expression;
    expect(expr).toContain('document.body.innerText.includes("Ready")');
  });

  it('evaluates a custom predicate expression', async () => {
    mockSendRpc.mockResolvedValue({ value: true });
    const res = await wait({ fn: "window.__ready === 'yes'" });
    expect(res.content[0].text).toContain('custom predicate satisfied');
    const expr = (mockSendRpc.mock.calls[0][1] as { expression: string }).expression;
    expect(expr).toBe("(window.__ready === 'yes')");
  });

  it('matches a URL glob against location.href', async () => {
    mockSendRpc.mockResolvedValue({ value: 'https://example.com/dashboard/42' });
    const res = await wait({ url: '**/dashboard/**' });
    expect(res.content[0].text).toContain('URL matched "**/dashboard/**"');
    expect((mockSendRpc.mock.calls[0][1] as { expression: string }).expression).toBe('location.href');
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

  it('uses the Playwright Page when one exists (no RPC)', async () => {
    const waitForSelector = vi.fn().mockResolvedValue(undefined);
    getPage.mockResolvedValue({ waitForSelector });
    const res = await wait({ selector: '#app' });
    expect(waitForSelector).toHaveBeenCalledWith('#app', { timeout: 30000 });
    expect(mockSendRpc).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain('selector "#app" found');
  });
});
