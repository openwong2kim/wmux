#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';
import { PlaywrightEngine } from './playwright/PlaywrightEngine';
import { registerNavigationTools } from './playwright/tools/navigation';
import { registerInteractionTools } from './playwright/tools/interaction';
import { registerInspectionTools } from './playwright/tools/inspection';
import { registerStateTools } from './playwright/tools/state';
import { registerWaitTools } from './playwright/tools/wait';
import { registerFileTools } from './playwright/tools/file';
import { registerUtilityTools } from './playwright/tools/utility';
import { registerExtractionTools } from './playwright/tools/extraction';

const server = new McpServer({
  name: 'wmux',
  version: '2.0.0',
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

// === Browser tools (RPC-based: surface management stays in main process) ===

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
  'browser_close',
  'Close the browser panel in the active pane',
  {
    surfaceId: z.string().optional().describe('Target a specific surface by ID. Omit to use the active surface.'),
  },
  async ({ surfaceId }) => callRpc('browser.close', surfaceId ? { surfaceId } : {}),
);

// === Playwright browser tools ===
registerNavigationTools(server);
registerInteractionTools(server);
registerInspectionTools(server);
registerStateTools(server);
registerWaitTools(server);
registerFileTools(server);
registerUtilityTools(server);
registerExtractionTools(server);

// === Browser session tools ===

server.tool(
  'browser_session_start',
  'Start a browser session with the specified profile',
  {
    profile: z.string().optional().describe('Profile name to use (defaults to "default")'),
  },
  async ({ profile }) =>
    callRpc('browser.session.start', profile ? { profile } : {}),
);

server.tool(
  'browser_session_stop',
  'Stop the current browser session',
  {},
  async () => callRpc('browser.session.stop'),
);

server.tool(
  'browser_session_status',
  'Get current browser session status',
  {},
  async () => callRpc('browser.session.status'),
);

server.tool(
  'browser_session_list',
  'List available browser profiles',
  {},
  async () => callRpc('browser.session.list'),
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

  // Clean up Playwright connection when transport closes
  transport.onclose = async () => {
    console.log('[wmux-mcp] Transport closed, disconnecting Playwright');
    await PlaywrightEngine.getInstance().disconnect();
  };

  // Graceful shutdown
  const shutdown = async () => {
    await PlaywrightEngine.getInstance().disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('wmux MCP server failed to start:', err);
  process.exit(1);
});
