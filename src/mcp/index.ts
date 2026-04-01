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
import { readFileSync } from 'fs';
import { join } from 'path';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const server = new McpServer({
  name: 'wmux',
  version: getVersion(),
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

// === A2A (Agent-to-Agent) tools ===

const MY_WORKSPACE_ID = process.env.WMUX_WORKSPACE_ID || '';

// 1. a2a_whoami — Identify this workspace
server.tool(
  'a2a_whoami',
  'Identify this workspace — returns workspace ID, name, and metadata.',
  {},
  async () => callRpc('a2a.whoami', { workspaceId: MY_WORKSPACE_ID }),
);

// 2. a2a_discover — Agent Card discovery
server.tool(
  'a2a_discover',
  'Discover available agents and their capabilities (skills, status). Use before sending tasks to find the right agent.',
  {},
  async () => callRpc('a2a.discover'),
);

// 3. a2a_task_send — Send new task or reply to existing task
server.tool(
  'a2a_task_send',
  'Send a task to another agent, or reply to an existing task. Omit task_id to create a new task; include task_id to add a message to an existing task.',
  {
    to: z.string().optional().describe('Target workspace name or ID (required for new tasks, ignored for replies)'),
    title: z.string().optional().describe('Task title/summary (required for new tasks)'),
    task_id: z.string().optional().describe('Existing task ID to reply to'),
    message: z.string().describe('Message content (text)'),
    data: z.record(z.string(), z.unknown()).optional().describe('Optional structured data payload (JSON)'),
    data_mime_type: z.string().optional().describe('MIME type for data payload (default: application/json)'),
  },
  async ({ to, title, task_id, message, data, data_mime_type }) => {
    const params: Record<string, unknown> = {
      workspaceId: MY_WORKSPACE_ID,
      message,
    };
    if (task_id) params.taskId = task_id;
    if (to) params.to = to;
    if (title) params.title = title;
    if (data) {
      params.data = data;
      params.dataMimeType = data_mime_type || 'application/json';
    }
    return callRpc('a2a.task.send', params);
  },
);

// 4. a2a_task_query — Query tasks by status/role
server.tool(
  'a2a_task_query',
  'Query tasks assigned to you or sent by you. Filter by status and role.',
  {
    status: z.enum(['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled']).optional().describe('Filter by task status'),
    role: z.enum(['sender', 'receiver']).optional().describe('Filter: "sender" = tasks you sent, "receiver" = tasks assigned to you'),
  },
  async ({ status, role }) => callRpc('a2a.task.query', { workspaceId: MY_WORKSPACE_ID, status, role }),
);

// 5. a2a_task_update — Update task status
server.tool(
  'a2a_task_update',
  'Update a task\'s status. Only the receiver can change to working/completed/failed/input-required. Optionally attach artifacts on completion.',
  {
    task_id: z.string().describe('Task ID to update'),
    status: z.enum(['working', 'completed', 'failed', 'input-required']).describe('New status'),
    message: z.string().optional().describe('Optional status message'),
    artifact_name: z.string().optional().describe('Artifact name (for completed tasks)'),
    artifact_data: z.record(z.string(), z.unknown()).optional().describe('Artifact data payload'),
  },
  async ({ task_id, status, message, artifact_name, artifact_data }) => {
    const params: Record<string, unknown> = { workspaceId: MY_WORKSPACE_ID, taskId: task_id, status };
    if (message) params.message = message;
    if (artifact_name) {
      params.artifact = {
        name: artifact_name,
        parts: artifact_data ? [{ type: 'data', mimeType: 'application/json', data: artifact_data }] : [],
      };
    }
    return callRpc('a2a.task.update', params);
  },
);

// 6. a2a_task_cancel — Cancel a task you sent
server.tool(
  'a2a_task_cancel',
  'Cancel a task you previously sent. Only the original sender can cancel.',
  {
    task_id: z.string().describe('Task ID to cancel'),
    reason: z.string().optional().describe('Cancellation reason'),
  },
  async ({ task_id, reason }) => callRpc('a2a.task.cancel', { workspaceId: MY_WORKSPACE_ID, taskId: task_id, reason }),
);

// 7. a2a_broadcast — Broadcast notification to all workspaces
server.tool(
  'a2a_broadcast',
  'Broadcast a notification to ALL other workspaces. Use sparingly — not for task delegation.',
  {
    message: z.string().describe('Broadcast message'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Priority level'),
  },
  async ({ message, priority }) => callRpc('a2a.broadcast', { message, priority: priority || 'normal', workspaceId: MY_WORKSPACE_ID }),
);

// 8. a2a_set_skills — Register agent capabilities
server.tool(
  'a2a_set_skills',
  'Register your agent capabilities/skills so other agents can discover you via a2a_discover.',
  {
    skills: z.array(z.string()).describe('List of skill tags (e.g., ["frontend", "testing", "devops"])'),
    description: z.string().optional().describe('Short description of what this agent does'),
  },
  async ({ skills, description }) => callRpc('meta.setSkills', { workspaceId: MY_WORKSPACE_ID, skills, description }),
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
