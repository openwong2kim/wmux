import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { collectingServer, type CollectedTool } from '../../playwright/toolCollector';

function fakeServer() {
  const calls: Array<{ method: string; name: string }> = [];
  const server = {
    tool: (name: string) => {
      calls.push({ method: 'tool', name });
      return { name };
    },
    registerTool: (name: string) => {
      calls.push({ method: 'registerTool', name });
      return { name };
    },
    isConnected: () => true,
  };
  return { server: server as unknown as McpServer, calls };
}

describe('collectingServer', () => {
  it('records the 4-arg tool() form and delegates to the real server', () => {
    const { server, calls } = fakeServer();
    const sink = new Map<string, CollectedTool>();
    const view = collectingServer(server, sink);
    const shape = { url: z.string() };
    const handler = async () => ({ content: [] });

    const returned = view.tool('browser_navigate', 'desc', shape, handler);

    expect(returned).toEqual({ name: 'browser_navigate' });
    expect(calls).toEqual([{ method: 'tool', name: 'browser_navigate' }]);
    expect(sink.get('browser_navigate')).toEqual({ name: 'browser_navigate', shape, handler });
  });

  it('records registerTool() by its inputSchema', () => {
    const { server } = fakeServer();
    const sink = new Map<string, CollectedTool>();
    const view = collectingServer(server, sink);
    const shape = { ms: z.number() };
    const handler = async () => ({ content: [] });

    view.registerTool('browser_wait', { description: 'd', inputSchema: shape }, handler);

    expect(sink.get('browser_wait')?.shape).toBe(shape);
    expect(sink.get('browser_wait')?.handler).toBe(handler);
  });

  it('delegates other arities without recording, and exposes the real server otherwise', () => {
    const { server, calls } = fakeServer();
    const sink = new Map<string, CollectedTool>();
    const view = collectingServer(server, sink);

    (view.tool as unknown as (...a: unknown[]) => unknown)('bare', async () => ({ content: [] }));

    expect(calls).toEqual([{ method: 'tool', name: 'bare' }]);
    expect(sink.size).toBe(0);
    expect(view.isConnected()).toBe(true);
  });
});
