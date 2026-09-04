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

/** Statuses the BRAIN variant of ledger_update offers: everything the table
 *  allows an owner to set. `completed` is still refused server-side without a
 *  system-recorded passing gate or force + reason. */
const BRAIN_SETTABLE_STATUSES = LEDGER_STATUSES;

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

const LEDGER_BRAIN_UPDATE_SHAPE = {
  task_id: z.string().min(1).describe('A task you own (from ledger_list).'),
  status: z
    .enum(BRAIN_SETTABLE_STATUSES as unknown as [string, ...string[]])
    .describe('completed = review_requested + a passing gate the gate runner recorded (or force + reason); input_required = bounce back with a question; working = resumed; failed / cancelled = closed without completion.'),
  expected_rev: z.number().int().describe('The rev from ledger_list. A stale rev is refused: re-read and retry.'),
  summary: z.string().max(2000).optional().describe('What you verified / why.'),
  force: z.boolean().optional().describe('completed without a passing recorded gate. Requires reason; the reason is logged on the entry.'),
  reason: z.string().max(500).optional().describe('Why force is justified.'),
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

/** Register the BRAIN variant of `ledger_update` (commander-only). Same
 *  name as the worker tool, wider status enum, force override; identity is
 *  the commander token on the RPC and authz is the ledger's (owner rows). */
export function registerLedgerBrainUpdateTool(register: McpServer['tool']): void {
  register(
    'ledger_update',
    'Move one of YOUR tasks in the task ledger. Transitions — worker: working → review_requested | input_required; brain: review_requested → completed; system: gate records. So completed is reachable only from review_requested, which is the WORKER\'s move: mark completed after review_requested AND a passing gate recorded by the gate runner (task_gate_run). force: { reason } is the ONLY brain-side exit when the worker cannot report it itself (the reason is logged on the entry). Bounce a review back with input_required, or close a task as failed / cancelled. Carry the rev you read.',
    LEDGER_BRAIN_UPDATE_SHAPE,
    async ({ task_id, status, expected_rev, summary, force, reason }) => {
      const params: Record<string, unknown> = { taskId: task_id, status, expectedRev: expected_rev };
      if (summary !== undefined) params['summary'] = summary;
      if (force === true) params['force'] = true;
      if (reason !== undefined) params['reason'] = reason;
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
