// ─── Fan-out tool for the bundled MCP server ────────────────────────────
//
// `fanout_start` exposes the `task.fanout.start` pipe RPC: one prompt → N
// isolated git worktrees, each with its own workspace, agent pane and mission
// channel. Until now fan-out was reachable only from the GUI modal, so an agent
// supervising a fleet could not open one.
//
// The tool schema deliberately has NO agent-command, workspace or repository
// input. Those are all derived server-side from the caller's verified identity
// (see src/main/pipe/handlers/fanout.rpc.ts and
// plans/fanout-mcp-surface-design.md); exposing them here would only invite
// callers to send values that are ignored — or, for the agent command, would be
// arbitrary command execution.
//
// The call is accept-then-poll. A fan-out takes far longer than the client's
// RPC deadline, so the first call returns `accepted` and the work continues in
// the background. Re-sending the same idempotency_key reports `running`, then
// `completed` with the full per-task result.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';
import { FANOUT_MAX_TASKS, FANOUT_PROMPT_MAX_BYTES } from '../shared/workTask';

/** Resolver the parent module injects (mirrors ChannelToolDeps). */
export interface FanOutToolDeps {
  /** The MCP server's OWN verified senderPtyId (its PID-map-walked ptyId, or ''
   *  on miss). The main-side handler resolves this to the owning workspace and
   *  derives the fan-out identity + repository from it. Fan-out fails closed
   *  without a resolvable ptyId — there is no env-hint fallback, by design. */
  getSenderPtyId?: () => string;
}

const FANOUT_START_SHAPE = {
  idempotency_key: z
    .string()
    .min(1)
    .describe(
      'Required. Makes a retried start safe AND is the handle you poll this fan-out with: re-send the same key to get { status: "running" } and then { status: "completed", result }. Use a fresh key for a genuinely new fan-out.',
    ),
  titles: z
    .array(z.string().min(1).max(256))
    .min(1)
    .max(FANOUT_MAX_TASKS)
    .describe(
      `One title per task; the array length IS the task count (max ${FANOUT_MAX_TASKS}). Each title seeds that task's branch name (wtask/<slug>) and its mission channel topic.`,
    ),
  prompt: z
    .string()
    .optional()
    .describe(
      `Shared prompt sent to every task. Optional: with no prompt at all, each task still gets its worktree, branch and agent pane, and you (or a human) type into them. Max ${FANOUT_PROMPT_MAX_BYTES} bytes.`,
    ),
  task_prompts: z
    .array(z.string())
    .max(FANOUT_MAX_TASKS)
    .optional()
    .describe(
      'Per-task prompts, index-aligned with titles. Each task receives shared prompt + "\\n\\n" + its own prompt (empty side dropped). Use this for N different jobs; omit it for N attempts at the same job.',
    ),
  repo_path: z
    .string()
    .optional()
    .describe(
      'Optional and constrained: it may only name the repository your OWN workspace is already in (any subdirectory of it works). Omit it — the server uses your workspace repository regardless. A path in any other repository is rejected.',
    ),
};

/** Register the fan-out tool on the given MCP server. */
export function registerFanOutTools(server: McpServer, deps: FanOutToolDeps): void {
  // Captured per registration, not a module global: the broker hosts many
  // servers in one process, and a global would stamp every connection's
  // fan-out with the last-registered connection's identity.
  const resolveSenderPtyId = deps.getSenderPtyId ?? (() => '');

  server.tool(
    'fanout_start',
    'Fan out one job into N isolated parallel tasks. Each task gets its own git worktree on a fresh wtask/ branch, its own wmux workspace with an agent pane already launched on the prompt, and its own mission channel. Use it to race N attempts at the same problem, or to run N independent jobs without them colliding in one checkout. ' +
      `Up to ${FANOUT_MAX_TASKS} tasks per call. ` +
      'Returns immediately with { status: "accepted" } — spawning takes far longer than one RPC, so the work continues in the background. Poll it by calling again with the SAME idempotency_key ("running", then "completed" with a per-task result), or watch the tasks appear via channel_mission_list. ' +
      'The repository, the owning workspace and the agent command are all determined by the server from your verified identity: fan-out always runs in YOUR workspace\'s repository, and the tasks are owned by you. Fan-out is refused if your identity cannot be verified.',
    FANOUT_START_SHAPE,
    async ({ idempotency_key, titles, prompt, task_prompts, repo_path }) => {
      const params: Record<string, unknown> = {
        idempotencyKey: idempotency_key,
        titles,
      };
      if (prompt !== undefined) params['prompt'] = prompt;
      if (task_prompts !== undefined) params['taskPrompts'] = task_prompts;
      if (repo_path !== undefined) params['repoPath'] = repo_path;
      // The verified ptyId is the whole identity basis for this call — the
      // handler resolves it to the owning workspace and refuses without it.
      const pty = resolveSenderPtyId();
      if (pty) params['senderPtyId'] = pty;

      try {
        const result = (await sendRpc('task.fanout.start' as RpcMethod, params)) as
          | { ok: true; [k: string]: unknown }
          | { ok: false; error: { code: string; message: string } }
          | undefined;
        if (result && result.ok === false) {
          return {
            content: [{ type: 'text' as const, text: `Error [${result.error.code}]: ${result.error.message}` }],
            isError: true,
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? {}, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
