import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage, resolveRef } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveRef: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    method.startsWith('browser.lease.') || method === 'browser.lifecycle.get'
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPageForScope: getPage }) },
}));

vi.mock('../snapshot', () => ({ resolveRef }));

import { registerFileTools } from '../tools/file';
import { UNKNOWN_EFFECT_ADVICE } from '../resultTrailer';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerFileTools(server as never, { resolveWorkspaceId: vi.fn(async () => 'ws-test') });
  return tools;
}

const tools = collectTools();

function tool(name: string): ToolHandler {
  const handler = tools.get(name);
  if (!handler) throw new Error(`${name} failed to register`);
  return handler;
}

const download = tool('browser_download');
const dialog = tool('browser_dialog');
const waitForDownload = tool('browser_wait_for_download');

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

const START_URL = 'https://app.test/report';

function makePage(opts: { noDownload?: boolean } = {}) {
  return {
    url: () => START_URL,
    once: vi.fn(),
    waitForEvent: vi.fn(async () => {
      if (opts.noDownload) {
        throw new Error('Timeout 30000ms exceeded while waiting for event "download"');
      }
      return {
        path: async () => 'C:\\Temp\\artifacts\\abc-123',
        suggestedFilename: () => 'report.csv',
        url: () => 'https://cdn.test/report.csv',
        saveAs: async () => undefined,
      };
    }),
  };
}

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  resolveRef.mockReset();
});

describe('browser_download effect trailer', () => {
  it('is committed when the download arrived', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRef.mockResolvedValue({ click: vi.fn(async () => undefined) });

    const result = await download({ ref: '5' });

    expect(result.isError).toBeUndefined();
    expect(text(result).endsWith('\n\neffect_state: committed')).toBe(true);
    expect(text(result)).toContain('suggestedFilename: report.csv');
  });

  it('is unknown when the click went out and no download followed in time', async () => {
    // The whole point of the contract: the click landed, so the page may have
    // acted on it, and a blind retry is a second click.
    getPage.mockResolvedValue(makePage({ noDownload: true }));
    resolveRef.mockResolvedValue({ click: vi.fn(async () => undefined) });

    const result = await download({ ref: '5' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(UNKNOWN_EFFECT_ADVICE);
    expect(text(result)).toContain('effect_state: unknown');
    expect(text(result)).toContain('error_code: timeout');
  });

  it('is none when the ref never resolved, so nothing was clicked', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRef.mockResolvedValue(null);

    const result = await download({ ref: '5' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('effect_state: none');
    expect(text(result)).toContain('error_code: ref_not_found');
  });

  it('is none when the backend handed over no page at all', async () => {
    getPage.mockResolvedValue(null);

    const result = await download({ ref: '5' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('effect_state: none');
    expect(text(result)).toContain('error_code: not_supported');
  });
});

describe('browser_dialog effect trailer', () => {
  it('reports the armed handler as committed', async () => {
    const page = makePage();
    getPage.mockResolvedValue(page);

    const result = await dialog({ accept: true });

    expect(text(result)).toBe(
      'Dialog handler set. Next dialog will be accepted.\n\neffect_state: committed',
    );
    expect(page.once).toHaveBeenCalledWith('dialog', expect.any(Function));
  });
});

describe('read-only tools carry no trailer', () => {
  it('browser_wait_for_download reports a download without any effect_state', async () => {
    getPage.mockResolvedValue(makePage());

    const result = await waitForDownload({});

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('report.csv');
    expect(text(result)).not.toContain('effect_state');
    expect(text(result)).not.toContain('error_code');
  });

  it('and reports its own timeout without one either — a wait mutates nothing', async () => {
    getPage.mockResolvedValue(makePage({ noDownload: true }));

    const result = await waitForDownload({ timeout: 1000 });

    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('effect_state');
  });
});
