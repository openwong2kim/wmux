// ─── remote_spawn — ask a paired PC to start an agent ───────────────────────
//
// One tool, two uses: with `pc` it asks (main resolves the caller's own pane
// from its verified ptyId, refuses a caller that was itself started for
// someone, and the daemon queues the request); with `spawn_id` alone it reads
// that request's state. The other PC decides on its own card or rule, so the
// answer comes later: the started agent's replies arrive as a task in the
// caller's ledger (a2a_task_query).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';
import { A2A_SPAWN_PIPE_RPC } from '../shared/a2aSpawn';
import { A2A_ANSWER_RPC } from '../shared/a2aRemote';

export interface RemoteSpawnToolDeps {
  /** The verified (PID-walk) ptyId; never the env hint. */
  getSenderPtyId: () => string;
  /** Warms the walk that fills the ptyId (see fanout.ts). */
  resolveWorkspaceId?: () => Promise<string>;
}

const SHAPE = {
  pc: z.string().max(256).optional().describe('The paired PC: its name here or its host id. Omit to read requests.'),
  agent: z.string().max(64).optional().describe('An agent the other PC allows, e.g. claude or codex.'),
  root: z.string().max(64).optional().describe('A folder id the other PC allows (remote_spawn with no pc lists them).'),
  sub: z.string().max(512).optional().describe('A relative path under that folder.'),
  prompt: z.string().optional().describe('The first instruction.'),
  expires_in_hours: z.number().int().min(1).max(72).optional().describe('How long it may wait for that PC (default 24).'),
  spawn_id: z.string().max(64).optional().describe('Read this request (never asks). With neither pc nor spawn_id, lists every request and what each PC allows.'),
};

const ANSWER_SHAPE = {
  task_id: z.string(),
  picker_id: z.string(),
  option: z.number().int().min(1).max(9),
};

/**
 * remote_answer — the agent that sent a task to another PC answers the
 * single-choice menu that task's (headless) worker shows there, by number.
 * Main resolves the caller's pane from the verified ptyId and the daemon
 * takes it only from the task's sender; how it went comes back in the task's
 * status (`remoteStatus.detail.answers`).
 */
export function registerRemoteAnswerTool(server: McpServer, deps: RemoteSpawnToolDeps): void {
  server.tool(
    'remote_answer',
    'Answer the single-choice menu the worker on a task you sent to another PC shows (remoteStatus.detail.pickerId, optionCount in a2a_task_query). The outcome shows in detail.answers.',
    ANSWER_SHAPE,
    async ({ task_id, picker_id, option }) => {
      try {
        if (deps.resolveWorkspaceId) {
          try {
            await deps.resolveWorkspaceId();
          } catch {
            // An unresolvable caller is the handler's refusal to make.
          }
        }
        const params: Record<string, unknown> = { taskId: task_id, pickerId: picker_id, option };
        const pty = deps.getSenderPtyId();
        if (pty) params['senderPtyId'] = pty;
        const result = await sendRpc(A2A_ANSWER_RPC.ask as RpcMethod, params);
        const failed = typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? {}, null, 2) }],
          ...(failed ? { isError: true as const } : {}),
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true as const };
      }
    },
  );
}

export function registerRemoteSpawnTools(server: McpServer, deps: RemoteSpawnToolDeps): void {
  server.tool(
    'remote_spawn',
    'Ask a paired PC to start an agent there in a folder it allows, with a first prompt; its replies come to your pane as a task. ' +
      'That PC decides (its card or rule); if it is off, the request waits until it is on. With spawn_id (or no pc), read requests and what each PC allows instead.',
    SHAPE,
    async ({ pc, agent, root, sub, prompt, expires_in_hours, spawn_id }) => {
      try {
        let result: unknown;
        // spawn_id reads, whatever else is given: a read never sends a request.
        if (spawn_id || !pc) {
          result = await sendRpc(A2A_SPAWN_PIPE_RPC.status as RpcMethod, spawn_id ? { spawnId: spawn_id } : {});
        } else {
          if (deps.resolveWorkspaceId) {
            try {
              await deps.resolveWorkspaceId();
            } catch {
              // An unresolvable caller is the handler's refusal to make.
            }
          }
          const params: Record<string, unknown> = { pc, agent, root, prompt };
          if (sub !== undefined) params['sub'] = sub;
          if (expires_in_hours !== undefined) params['expiresInHours'] = expires_in_hours;
          const pty = deps.getSenderPtyId();
          if (pty) params['senderPtyId'] = pty;
          result = await sendRpc(A2A_SPAWN_PIPE_RPC.spawn as RpcMethod, params);
        }
        const failed = typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? {}, null, 2) }],
          ...(failed ? { isError: true as const } : {}),
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true as const };
      }
    },
  );
}
