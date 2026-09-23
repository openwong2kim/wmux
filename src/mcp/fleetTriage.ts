// ─── fleet_triage — the Fleet attention board for agents ─────────────────
//
// "Which agents need me right now?" without scraping terminals. The renderer
// answers with the same selector the Fleet overlay renders (selectFleetBoard),
// so an agent and the human looking at Fleet see one truth.
//
// Scope: the whole fleet by default. An explicit workspaceId narrows it; it is
// NOT resolved to the caller's own workspace when omitted, because the question
// is fleet-wide. Each row carries agent-authored text (the pending question,
// last message or tool activity), remote host labels and mission titles, which
// pane_list does not, so a third-party plugin needs terminal.read for it (see
// methodCapabilityMap); an unknown workspaceId is an error, never an empty
// "all clear" board.
//
// callRpc is injected so fleetTriage.test.ts can assert the RPC mapping against
// a mock (same pattern as paneLifecycle.ts).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RpcMethod } from '../shared/rpc';
import {
  defineWmuxTool,
  registerWmuxTools,
  type RegisterWmuxToolsOptions,
} from './toolCatalog';

export interface FleetTriageDeps {
  callRpc: (
    method: RpcMethod,
    params?: Record<string, unknown>,
  ) => Promise<{ content: { type: 'text'; text: string }[] }>;
}

const FLEET_TRIAGE_SHAPE = {
  workspaceId: z.string().optional().describe('Only this workspace. Omit for all.'),
  includeIdle: z.boolean().optional().describe('Also list idle rows (default: count only).'),
};

export function createFleetTriageToolCatalog(deps: FleetTriageDeps) {
  const { callRpc } = deps;
  return Object.freeze([
    defineWmuxTool({
      name: 'fleet_triage',
      description:
        'Which agents need you: the Fleet board as needsYou / running / idle rows with status, detail, idle time. ptyId is the tab to act on. All workspaces unless workspaceId.',
      inputSchema: FLEET_TRIAGE_SHAPE,
      profiles: ['full', 'core', 'commander'],
      invoke: async ({ workspaceId, includeIdle }) => callRpc('fleet.triage', {
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(includeIdle !== undefined ? { includeIdle } : {}),
      }),
    }),
  ]);
}

export function registerFleetTriageTools(
  server: McpServer,
  deps: FleetTriageDeps,
  options: RegisterWmuxToolsOptions,
): void {
  registerWmuxTools(server, createFleetTriageToolCatalog(deps), options);
}
