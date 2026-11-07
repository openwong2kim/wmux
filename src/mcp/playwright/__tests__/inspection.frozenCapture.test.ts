import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * browser_screenshot freezes CSS animations/transitions on every
 * Playwright-lane capture — the first PNG, every JPEG downscale rung, and
 * both element (ref) captures — so a spinner or a fade caught mid-frame can
 * never make two shots of an unchanged page differ.
 */

const { mockSendRpc, getPage, resolveWorkspaceBackend, resolveRef } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveWorkspaceBackend: vi.fn(),
  resolveRef: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      getPageForScope: getPage,
      resolveWorkspaceBackend,
      drainLocalLifecycle: () => [],
    }),
  },
}));

// Only resolveRef is faked: the screenshot tool still needs the real
// browserScopeKey and friends from the same module.
vi.mock('../snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snapshot')>()),
  resolveRef,
}));

import { registerInspectionTools } from '../tools/inspection';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}>;

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInspectionTools(server as never, { resolveWorkspaceId: vi.fn(async () => 'ws-test') });
  return tools;
}

const screenshot = collectTools().get('browser_screenshot');
if (!screenshot) throw new Error('browser_screenshot failed to register');

interface FakePage extends EventEmitter {
  url: () => string;
  screenshot: (opts?: Record<string, unknown>) => Promise<Buffer>;
}

/** A capture that answers PNG with `png` and any JPEG rung with a small body. */
function recordingPage(png: Buffer): { page: FakePage; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const page = new EventEmitter() as FakePage;
  page.url = () => 'https://example.test/';
  page.screenshot = async (opts = {}) => {
    calls.push(opts);
    return opts['type'] === 'jpeg' ? Buffer.alloc(16 * 1024, 9) : png;
  };
  return { page, calls };
}

beforeEach(() => {
  mockSendRpc.mockReset();
  getPage.mockReset();
  getPage.mockResolvedValue(null);
  resolveWorkspaceBackend.mockReset();
  resolveRef.mockReset();
  mockSendRpc.mockImplementation(async (method: string) => {
    if (method === 'browser.cdp.info') return { targets: [] };
    return {};
  });
});

describe('browser_screenshot — animations are frozen for every Playwright capture', () => {
  it('page capture: the PNG and each JPEG downscale rung all disable animations', async () => {
    // 3 MiB of PNG forces at least one JPEG re-capture past the 2 MiB ceiling.
    const { page, calls } = recordingPage(Buffer.alloc(3 * 1024 * 1024, 7));
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    getPage.mockResolvedValue(page as unknown as Page);

    const result = await screenshot!({});

    expect(result.isError).toBeFalsy();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((opts) => opts['type'] === 'jpeg')).toBe(true);
    for (const opts of calls) expect(opts['animations']).toBe('disabled');
  });

  it('element capture: the first shot and the downscale rung both disable animations', async () => {
    const calls: Record<string, unknown>[] = [];
    const el = {
      screenshot: async (opts: Record<string, unknown> = {}) => {
        calls.push(opts);
        return opts['type'] === 'jpeg' ? Buffer.alloc(16 * 1024, 9) : Buffer.alloc(3 * 1024 * 1024, 7);
      },
    };
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    const { page } = recordingPage(Buffer.alloc(8, 0));
    getPage.mockResolvedValue(page as unknown as Page);
    resolveRef.mockResolvedValue(el);

    const result = await screenshot!({ ref: '3' });

    expect(result.isError).toBeFalsy();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const opts of calls) expect(opts['animations']).toBe('disabled');
  });

  it('fails a chrome-backend element capture with no page, rather than answering with the viewport', async () => {
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    getPage.mockResolvedValue(null);
    const result = await screenshot({ ref: 'e1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Could not capture ref="e1"');
    expect(mockSendRpc).not.toHaveBeenCalledWith('browser.screenshot', expect.anything());
  });
});

// A 1x1 transparent PNG.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('browser_screenshot ref on the builtin backend', () => {
  it('with no Playwright page, crops over RPC by the ref tag', async () => {
    resolveWorkspaceBackend.mockResolvedValue('builtin');
    getPage.mockResolvedValue(null);
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'browser.screenshot') return { data: TINY_PNG };
      return {};
    });

    const result = await screenshot({ ref: '3' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe('image');
    expect(result.content[1]?.text).toContain('ELEMENT-relative');
    const shots = mockSendRpc.mock.calls.filter(([method]) => method === 'browser.screenshot');
    expect(shots.length).toBeGreaterThan(0);
    for (const [, params] of shots) expect(params).toMatchObject({ selector: '[data-wmux-ref="3"]' });
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it('with a Playwright page, resolves the snapshot ref there and sends no RPC capture', async () => {
    // That snapshot minted accessibility refs and wrote no data-wmux-ref tags,
    // so a tag selector would match nothing, or a stale tag's element.
    resolveWorkspaceBackend.mockResolvedValue('builtin');
    const calls: Record<string, unknown>[] = [];
    const el = {
      screenshot: async (opts: Record<string, unknown> = {}) => {
        calls.push(opts);
        return Buffer.from(TINY_PNG, 'base64');
      },
    };
    const { page } = recordingPage(Buffer.alloc(8, 0));
    getPage.mockResolvedValue(page as unknown as Page);
    resolveRef.mockResolvedValue(el);

    const result = await screenshot({ ref: 'e12' });

    expect(result.isError).toBeFalsy();
    expect(resolveRef).toHaveBeenCalledWith(page, 'e12');
    expect(calls.length).toBe(1);
    expect(calls[0]?.['animations']).toBe('disabled');
    expect(mockSendRpc).not.toHaveBeenCalledWith('browser.screenshot', expect.anything(), expect.anything());
    expect(mockSendRpc.mock.calls.some(([method]) => method === 'browser.screenshot')).toBe(false);
  });

  it('goes over RPC when the page lookup is refused (CDP info withheld)', async () => {
    resolveWorkspaceBackend.mockRejectedValue(new Error('CDP remote debugging is unavailable'));
    getPage.mockRejectedValue(new Error('CDP remote debugging is unavailable'));
    mockSendRpc.mockImplementation(async (method: string) => (method === 'browser.screenshot' ? { data: TINY_PNG } : {}));

    const result = await screenshot({ ref: '4' });

    expect(result.isError).toBeFalsy();
    expect(mockSendRpc.mock.calls.some(([method]) => method === 'browser.screenshot')).toBe(true);
  });

  it('reports an unresolvable ref as an error and takes no viewport capture', async () => {
    resolveWorkspaceBackend.mockResolvedValue('builtin');
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'browser.screenshot') throw new Error('browser.screenshot: no element matches [data-wmux-ref="9"]');
      return {};
    });

    const result = await screenshot({ ref: '9' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no element matches');
    const shots = mockSendRpc.mock.calls.filter(([method]) => method === 'browser.screenshot');
    for (const [, params] of shots) expect(params).toHaveProperty('selector');
  });

  it('refuses a ref that is not a plain ref token before touching the page', async () => {
    resolveWorkspaceBackend.mockResolvedValue('builtin');

    const result = await screenshot({ ref: '3"] , body' });

    expect(result.isError).toBe(true);
    expect(mockSendRpc).not.toHaveBeenCalledWith('browser.screenshot', expect.anything());
  });
});
