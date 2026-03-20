#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';

const server = new McpServer({
  name: 'wmux',
  version: '1.0.0',
});

// Helper: wrap an RPC call as an MCP tool result
async function callRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const result = await sendRpc(method, params);
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: 'text', text }] };
}

// Optional surfaceId schema used by browser and terminal tools
const optionalSurfaceId = z.string().optional().describe(
  'Target a specific surface by ID. Omit to use the active surface.',
);

// === Browser tools ===

server.tool(
  'browser_open',
  'Open a new browser panel in the active pane. Use this when no browser surface exists yet.',
  {
    url: z.string().optional().describe('Initial URL to load (defaults to google.com)'),
  },
  async ({ url }) =>
    callRpc('browser.open', url ? { url } : {}),
);

server.tool(
  'browser_navigate',
  'Navigate the wmux browser panel to a URL',
  {
    url: z.string().describe('The URL to navigate to'),
    surfaceId: optionalSurfaceId,
  },
  async ({ url, surfaceId }) =>
    callRpc('browser.navigate', { url, ...(surfaceId && { surfaceId }) }),
);

server.tool(
  'browser_snapshot',
  'Get the full HTML content of the current page in the wmux browser panel',
  { surfaceId: optionalSurfaceId },
  async ({ surfaceId }) =>
    callRpc('browser.snapshot', surfaceId ? { surfaceId } : {}),
);

server.tool(
  'browser_click',
  'Click an element in the wmux browser panel by CSS selector',
  {
    selector: z.string().describe('CSS selector of the element to click'),
    surfaceId: optionalSurfaceId,
  },
  async ({ selector, surfaceId }) =>
    callRpc('browser.click', { selector, ...(surfaceId && { surfaceId }) }),
);

server.tool(
  'browser_fill',
  'Fill an input field in the wmux browser panel by CSS selector',
  {
    selector: z.string().describe('CSS selector of the input element'),
    text: z.string().describe('Text to fill into the input'),
    surfaceId: optionalSurfaceId,
  },
  async ({ selector, text, surfaceId }) =>
    callRpc('browser.fill', { selector, text, ...(surfaceId && { surfaceId }) }),
);

server.tool(
  'browser_eval',
  'Execute JavaScript in the wmux browser panel and return the result',
  {
    code: z.string().describe('JavaScript code to execute in the browser context'),
    surfaceId: optionalSurfaceId,
  },
  async ({ code, surfaceId }) =>
    callRpc('browser.eval', { code, ...(surfaceId && { surfaceId }) }),
);

// === Terminal tools ===

server.tool(
  'terminal_read',
  'Read the current visible text from the active terminal in wmux',
  {},
  async () => callRpc('input.readScreen'),
);

server.tool(
  'terminal_send',
  'Send text to the active terminal in wmux',
  { text: z.string().describe('Text to send to the terminal') },
  async ({ text }) => callRpc('input.send', { text }),
);

server.tool(
  'terminal_send_key',
  'Send a named key to the active terminal (enter, tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l, escape, up, down, right, left)',
  {
    key: z.string().describe(
      'Key name: enter, tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l, escape, up, down, right, left',
    ),
  },
  async ({ key }) => callRpc('input.sendKey', { key }),
);

// === Workspace tools ===

server.tool(
  'workspace_list',
  'List all workspaces in wmux',
  {},
  async () => callRpc('workspace.list'),
);

server.tool(
  'surface_list',
  'List all surfaces (terminals and browsers) in the active workspace',
  {},
  async () => callRpc('surface.list'),
);

server.tool(
  'pane_list',
  'List all panes in the current workspace',
  {},
  async () => callRpc('pane.list'),
);

// === Start server ===

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('wmux MCP server failed to start:', err);
  process.exit(1);
});
