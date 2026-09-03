// ─── Task ledger tools for the bundled MCP server ───────────────────────────
//
// Two tools over the `ledger.*` pipe RPCs (src/main/pipe/handlers/ledger.rpc.ts):
//
//   ledger_update — every profile (full + core). A WORKER reports its own
//     task: identity is the server-resolved senderPtyId (same provenance rule
//     as the channel tools — walk-hit only, never the env hint), and the
//     ledger refuses anything but the worker-settable statuses on the task
//     whose workspace is the caller's. This is how "done" becomes a fact:
//     `review_requested` after the worker's own gate passed, `input_required`
//     on a blocker. A natural-language "done" in a channel is not completion.
//
//   ledger_list — COMMANDER-ONLY (registered through the commander-only lane
//     in src/mcp/index.ts, never in full/core). The brain reads the tasks its
//     workspace owns; the validated commander token on every outbound RPC is
//     the identity, so the tool sends no workspace at all.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';
import { WORKER_SETTABLE_STATUSES, LEDGER_STATUSES } from '../shared/ledger';

export interface LedgerToolDeps {
  /** The server's OWN verified senderPtyId (PID-map walk hit, '' on miss). */
  getSenderPtyId?: () => string;
  /** Warms the walk that populates the ptyId above (see fanout.ts). */
  resolveWorkspaceId?: () => Promise<string>;
}

const LEDGER_UPDATE_SHAPE = {
  task_id: z.string().min(1).describe('Your WorkTask id (wtask-…), from your fan-out prompt or mission channel.'),
  status: z
    .enum(WORKER_SETTABLE_STATUSES as [string, ...string[]])
    .describe('review_requested = done AND your own gate passed; input_required = blocked, say on what; failed = cannot finish; working = resumed.'),
  expected_rev: z.number().int().describe('The rev you last read (1 right after fan-out). A stale rev is refused: re-read and retry.'),
  summary: z.string().max(2000).optional().describe('One or two lines: what landed / what blocks you.'),
};

const LEDGER_LIST_SHAPE = {
  task_id: z.string().optional().describe('Only this task.'),
  open_only: z.boolean().optional().describe('Only working / input_required / review_requested.'),
};

function toResult(result: unknown): { content: { type: 'text'; text: string }[]; isError?: true } {
  const r = result as { ok?: boolean } | undefined;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result ?? {}, null, 2) }],
    ...(r && r.ok === false ? { isError: true as const } : {}),
  };
}

/** Register `ledger_update` (worker-scoped; full + core). */
export function registerLedgerUpdateTool(server: McpServer, deps: LedgerToolDeps): void {
  const resolveSenderPtyId = deps.getSenderPtyId ?? (() => '');
  server.tool(
    'ledger_update',
    'Record the state of YOUR fan-out task in the task ledger. Call it with status "review_requested" when the task is done and your own gate (tsc/lint/tests) passed, or "input_required" when you are blocked — a natural-language "done" is not completion. Only your own task, only these statuses; the brain marks completed.',
    LEDGER_UPDATE_SHAPE,
    async ({ task_id, status, expected_rev, summary }) => {
      if (deps.resolveWorkspaceId) {
        try {
          await deps.resolveWorkspaceId();
        } catch {
          // The handler refuses an unresolvable caller with its own message.
        }
      }
      const params: Record<string, unknown> = { taskId: task_id, status, expectedRev: expected_rev };
      if (summary !== undefined) params['summary'] = summary;
      const pty = resolveSenderPtyId();
      if (pty) params['senderPtyId'] = pty;
      try {
        return toResult(await sendRpc('ledger.update' as RpcMethod, params));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

/** Register `ledger_list` (commander-only). `register` is the UNFILTERED
 *  server.tool binding — the commander manifest filter would drop a name it
 *  does not list, and this one is deliberately outside that list. */
export function registerLedgerListTool(register: McpServer['tool']): void {
  register(
    'ledger_list',
    `List the task ledger for the tasks YOUR workspace owns: id, title, status (${LEDGER_STATUSES.join(' | ')}), rev, summary, gate, worker workspace. Read it before deciding a worker is done: review_requested with a summary is the worker's claim, completed is yours after the gate.`,
    LEDGER_LIST_SHAPE,
    async ({ task_id, open_only }) => {
      const params: Record<string, unknown> = {};
      if (task_id !== undefined) params['taskId'] = task_id;
      if (open_only !== undefined) params['openOnly'] = open_only;
      try {
        return toResult(await sendRpc('ledger.list' as RpcMethod, params));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
