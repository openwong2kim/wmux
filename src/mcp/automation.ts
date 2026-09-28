// ─── Scheduled runs for agents: draft, never enable ───────────────────────
//
// automation_propose drafts a schedule; the pipe handler
// (src/main/pipe/handlers/automation.rpc.ts) stores it DISABLED and in
// approval mode and queues it for the human, who reviews and enables it in
// wmux. There is no MCP path that enables, grants or runs a schedule.
// automation_list / automation_runs are redacted reads (no prompt, folder,
// account or session ids).
//
// sendRpc is injected so automation.test.ts can assert the RPC mapping.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RpcMethod } from '../shared/rpc';
import {
  defineWmuxTool,
  registerWmuxTools,
  type RegisterWmuxToolsOptions,
} from './toolCatalog';

export interface AutomationToolDeps {
  sendRpc: (method: RpcMethod, params?: Record<string, unknown>) => Promise<unknown>;
}

const PROPOSE_SHAPE = {
  name: z.string().describe('Short title.'),
  cwd: z.string().describe('Absolute folder the agent runs in.'),
  agent: z.enum(['claude', 'codex']),
  prompt: z.string().describe('What the agent is told to do.'),
  weekdays: z.array(z.number().int()).describe('0=Sun … 6=Sat.'),
  time: z.string().describe('Local 24h HH:MM.'),
  graceMinutes: z.number().int().optional().describe('Late-fire window (default 180).'),
};

const RUNS_SHAPE = {
  automationId: z.string().optional(),
};

async function toResult(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await run();
    const failed = !!result && typeof result === 'object' && (result as { ok?: unknown }).ok === false;
    return {
      content: [{ type: 'text', text: JSON.stringify(result ?? {}, null, 2) }],
      ...(failed ? { isError: true } : {}),
    };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function createAutomationToolCatalog(deps: AutomationToolDeps) {
  return Object.freeze([
    defineWmuxTool({
      name: 'automation_propose',
      description:
        'Draft a scheduled agent run. Saved disabled; a human must review and enable it in wmux. Cannot enable or set permissions.',
      inputSchema: PROPOSE_SHAPE,
      strictInput: true,
      profiles: ['full', 'core'],
      invoke: (input) => toResult(() => deps.sendRpc('automation.propose', { ...input })),
    }),
    defineWmuxTool({
      name: 'automation_list',
      description: 'List schedules: name, days/time, enabled, proposed, permission mode, next and last run.',
      inputSchema: {},
      profiles: ['full', 'core'],
      invoke: () => toResult(() => deps.sendRpc('automation.list', {})),
    }),
    defineWmuxTool({
      name: 'automation_runs',
      description: 'Recent scheduled-run states, newest first. All schedules unless automationId.',
      inputSchema: RUNS_SHAPE,
      profiles: ['full', 'core'],
      invoke: ({ automationId }) =>
        toResult(() => deps.sendRpc('automation.runs', automationId !== undefined ? { automationId } : {})),
    }),
  ]);
}

export function registerAutomationTools(
  server: McpServer,
  deps: AutomationToolDeps,
  options: RegisterWmuxToolsOptions,
): void {
  registerWmuxTools(server, createAutomationToolCatalog(deps), options);
}
