#!/usr/bin/env node
/**
 * wmux-company — Company-mode Agent-to-Agent MCP Server
 *
 * Provides structured inter-agent communication for wmux Company Mode.
 * Agents use MCP tool calls instead of text pattern matching.
 *
 * Tools (all prefixed with `company_a2a_` to avoid collision with the
 * workspace-level A2A tools hosted by the main wmux MCP server):
 *   company_a2a_whoami    — Identify this agent (workspace → member)
 *   company_a2a_send      — Send a message to another agent by name
 *   company_a2a_broadcast — Broadcast to all agents
 *   company_a2a_inbox     — Read incoming messages (poll)
 *   company_a2a_ack       — Acknowledge (mark read) inbox messages
 *   company_a2a_status    — Get company-wide agent status
 *
 * The main wmux MCP server re-exposes the same `company_a2a_*` tool names,
 * so agents connected to either server get identical behaviour. Standalone
 * launch of this server remains supported as a lightweight alternative.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendRpc } from '../../mcp/wmux-client';
import type { RpcMethod } from '../../shared/rpc';
import { classifyWorkspaceListResult, type WorkspaceLiveness } from '../../mcp/workspaceIdentity';
import { readFileSync } from 'fs';
import { join } from 'path';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Workspace identity. The PTY env var (WMUX_WORKSPACE_ID) is a HINT only — it
// is frozen at PTY-create time and goes stale when the workspace id is
// re-minted (daemon respawn / session restore). We resolve the CURRENT owner
// via a2a.resolve.identity (PID → live workspace) and use the env hint only as
// a last resort. See src/mcp/index.ts for the full rationale.
const ENV_WORKSPACE_HINT = process.env.WMUX_WORKSPACE_ID || '';
let MY_WORKSPACE_ID = '';
let workspaceResolved = false;

const server = new McpServer({
  name: 'wmux-company',
  version: getVersion(),
});

// Detect an RPC outcome that means our cached workspace identity is stale.
function isStaleIdentityResult(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /no workspace found|not owned by workspace/i.test(text);
}

async function callRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<{ content: { type: 'text'; text: string }[] }> {
  try {
    const result = await sendRpc(method, params);
    if (isStaleIdentityResult(result)) invalidateWorkspaceId();
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (isStaleIdentityResult(err instanceof Error ? err.message : String(err))) {
      invalidateWorkspaceId();
    }
    throw err;
  }
}

function invalidateWorkspaceId(): void {
  workspaceResolved = false;
}

/**
 * Classify whether `wsId` exists right now (kept in lockstep with src/mcp's
 * isLiveWorkspace). Gates the env-hint fallback so a re-minted ghost id can't
 * leak through after a daemon respawn / session restore. 'absent' = confirmed
 * gone (drop the hint); 'unknown' = workspace.list unavailable (keep the hint
 * rather than turning a transient condition into a hard failure).
 */
async function isLiveWorkspace(wsId: string): Promise<WorkspaceLiveness> {
  try {
    const result = await sendRpc('workspace.list' as RpcMethod, {});
    return classifyWorkspaceListResult(result, wsId);
  } catch {
    return 'unknown';
  }
}

async function resolveWorkspaceId(opts?: { force?: boolean }): Promise<string> {
  if (workspaceResolved && MY_WORKSPACE_ID && !opts?.force) return MY_WORKSPACE_ID;

  try {
    const result = await sendRpc('a2a.resolve.identity' as RpcMethod, {});
    const { mappings } = result as { mappings: Record<string, string> };
    if (mappings && Object.keys(mappings).length > 0) {
      const knownPids = new Map<number, string>();
      for (const [pidStr, wsId] of Object.entries(mappings)) {
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid)) knownPids.set(pid, wsId);
      }

      let currentPid = process.ppid;
      for (let depth = 0; depth < 10; depth++) {
        const wsId = knownPids.get(currentPid);
        if (wsId) {
          MY_WORKSPACE_ID = wsId;
          workspaceResolved = true;
          return MY_WORKSPACE_ID;
        }
        const parentPid = await getParentPid(currentPid);
        if (!parentPid || parentPid === currentPid || parentPid <= 1) break;
        currentPid = parentPid;
      }
    }
  } catch { /* resolve failed, fall through to env hint */ }

  // Drop the frozen env hint only on positive proof it names a dead workspace
  // ('absent'); keep it on 'unknown' (workspace.list transiently unavailable).
  // Mirrors src/mcp/index.ts so both MCP surfaces reject ghost ids identically.
  if (ENV_WORKSPACE_HINT) {
    if ((await isLiveWorkspace(ENV_WORKSPACE_HINT)) !== 'absent') return ENV_WORKSPACE_HINT;
  }
  // Last-resort cached identity. invalidateWorkspaceId clears workspaceResolved
  // but not MY_WORKSPACE_ID, so gate the cached fallback on liveness too: drop a
  // confirmed-dead ('absent') id (and clear the cache so the next call
  // re-resolves clean), keep it on 'unknown' (workspace.list transiently down).
  // Mirrors src/mcp/index.ts so both surfaces close the ghost loop identically.
  if (MY_WORKSPACE_ID && (await isLiveWorkspace(MY_WORKSPACE_ID)) === 'absent') {
    MY_WORKSPACE_ID = '';
    workspaceResolved = false;
  }
  return MY_WORKSPACE_ID;
}

async function getParentPid(pid: number): Promise<number | null> {
  try {
    const { execFileSync } = await import('child_process');
    if (process.platform === 'win32') {
      const path = await import('path');
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const out = execFileSync(ps, [
        '-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const parsed = parseInt(out.trim(), 10);
      return isNaN(parsed) ? null : parsed;
    } else {
      const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
      return parseInt(out.trim(), 10) || null;
    }
  } catch {
    return null;
  }
}

async function requireWorkspaceId(): Promise<string> {
  const wsId = await resolveWorkspaceId();
  if (!wsId) {
    throw new Error(
      'Workspace identity unknown. Make sure you are running inside a wmux terminal workspace.'
    );
  }
  return wsId;
}

// ── company_a2a_whoami ──────────────────────────────────────────────────────

server.tool(
  'company_a2a_whoami',
  'Identify who you are in the company hierarchy. Returns your name, role, department, and status.',
  {},
  async () => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.whoami', { workspaceId: wsId });
  },
);

// ── company_a2a_send ────────────────────────────────────────────────────────

server.tool(
  'company_a2a_send',
  'Send a structured message to another agent by name. ' +
  'Resolves target by: department name → lead, exact member name, or "CEO". ' +
  'Returns delivery status (delivered/queued).',
  {
    to: z.string().describe('Target agent name, department name, or "CEO"'),
    message: z.string().describe('Message content'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Message priority (default: normal)'),
  },
  async ({ to, message, priority }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.send', {
      to,
      message,
      priority: priority || 'normal',
      workspaceId: wsId,
    });
  },
);

// ── company_a2a_broadcast ───────────────────────────────────────────────────

server.tool(
  'company_a2a_broadcast',
  'Broadcast a message to ALL agents in the company. Use sparingly.',
  {
    message: z.string().describe('Broadcast message content'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Message priority'),
  },
  async ({ message, priority }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.broadcast', {
      message,
      priority: priority || 'normal',
      workspaceId: wsId,
    });
  },
);

// ── company_a2a_inbox ───────────────────────────────────────────────────────

server.tool(
  'company_a2a_inbox',
  'Check your inbox for incoming messages from other agents. ' +
  'Returns messages with IDs — use company_a2a_ack to mark them as read. ' +
  'This is the canonical A2A delivery channel (inbox/ack pattern) rather than PTY paste.',
  {
    unread_only: z.boolean().optional().describe('Only return unread messages (default: true)'),
  },
  async ({ unread_only }) =>
    callRpc('company.a2a.inbox', {
      workspaceId: await requireWorkspaceId(),
      unreadOnly: unread_only !== false,
    }),
);

// ── company_a2a_ack ─────────────────────────────────────────────────────────

server.tool(
  'company_a2a_ack',
  'Acknowledge (mark as read) inbox messages by their IDs.',
  {
    message_ids: z.array(z.string()).describe('Array of message IDs to acknowledge'),
  },
  async ({ message_ids }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.ack', {
      workspaceId: wsId,
      messageIds: message_ids,
    });
  },
);

// ── company_a2a_status ──────────────────────────────────────────────────────

server.tool(
  'company_a2a_status',
  'Get the current company status: all departments, members, their roles, and online status. ' +
  'Use this to discover who you can communicate with.',
  {},
  async () => callRpc('company.a2a.status'),
);

// ── Start server ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => { process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('wmux-a2a MCP server failed to start:', err);
  process.exit(1);
});
