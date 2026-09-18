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
    resolveWorkspaceBackend.mockResolvedValue('electron');
    const { page } = recordingPage(Buffer.alloc(8, 0));
    getPage.mockResolvedValue(page as unknown as Page);
    resolveRef.mockResolvedValue(el);

    const result = await screenshot!({ ref: '3' });

    expect(result.isError).toBeFalsy();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const opts of calls) expect(opts['animations']).toBe('disabled');
  });
});
