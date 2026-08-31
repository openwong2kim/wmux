// ─── Fan-out tool for the bundled MCP server ────────────────────────────
//
// `fanout_start` exposes the `task.fanout.start` pipe RPC: one prompt → N
// isolated git worktrees, each with its own workspace, agent pane and mission
// channel. Until now fan-out was reachable only from the GUI modal, so an agent
// supervising a fleet could not open one.
//
// The tool schema deliberately has NO agent-command, workspace, member or
// repository input. Those are all derived server-side from the caller's
// verified identity (see src/main/pipe/handlers/fanout.rpc.ts); exposing them
// here would only invite callers to send values the handler rejects — or, for
// the agent command, would be arbitrary command execution.
//
// The call is accept-then-poll. A fan-out takes far longer than the client's
// RPC deadline, so the first call returns `accepted` and the work continues in
// the background. Re-sending the same idempotency_key reports the state:
// `awaiting_approval` while the user is being asked, then `running`, then
// `completed` with the full per-task result — or `denied`, with the reason, if
// nobody approved it.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';
import { FANOUT_MAX_TASKS, FANOUT_PROMPT_MAX_BYTES } from '../shared/workTask';
import { ORCH_ROLES } from '../shared/orchestratorRole';

/** Resolvers the parent module injects (mirrors ChannelToolDeps). */
export interface FanOutToolDeps {
  /** The MCP server's OWN verified senderPtyId (its PID-map-walked ptyId, or ''
   *  on miss). The main-side handler resolves this to the owning workspace and
   *  derives the fan-out identity + repository from it. Fan-out fails closed
   *  without a resolvable ptyId — there is no env-hint fallback, by design. */
  getSenderPtyId?: () => string;
  /**
   * Runs the identity resolution that POPULATES the ptyId above, and is the
   * reason this dep exists at all rather than just the getter.
   *
   * The walked ptyId is a side effect of the workspace lookup: nothing sets it
   * until something asks who the caller is. Every channel tool asks, so by the
   * time one of them reads the getter it is warm. fanout_start read the getter
   * alone — so as the FIRST tool called on a fresh server it sent no
   * senderPtyId at all and the handler refused it as NOT_AUTHORIZED. The tool
   * worked only if some unrelated tool had run first, which is not a property
   * anyone can rely on.
   *
   * The resolved workspace id itself is deliberately NOT forwarded: the handler
   * derives the owning workspace from the verified ptyId server-side and
   * rejects a caller-stated one.
   */
  resolveWorkspaceId?: () => Promise<string>;
}

const FANOUT_START_SHAPE = {
  idempotency_key: z
    .string()
    .min(1)
    .describe(
      'Required. Makes a retried start safe AND is the poll handle: re-send the same key for { status: "awaiting_approval" | "running" }, then { status: "completed", result }. Use a fresh key for a new fan-out.',
    ),
  titles: z
    .array(z.string().min(1).max(256))
    .min(1)
    .max(FANOUT_MAX_TASKS)
    .describe(
      `One title per task; the array length IS the task count (max ${FANOUT_MAX_TASKS}). Each title seeds the branch name (wtask/<slug>) and the mission channel topic.`,
    ),
  prompt: z
    .string()
    .optional()
    .describe(
      `Shared prompt sent to every task. Optional — with none, each task still gets its worktree, branch and agent pane to be typed into. Max ${FANOUT_PROMPT_MAX_BYTES} bytes.`,
    ),
  task_prompts: z
    .array(z.string())
    .max(FANOUT_MAX_TASKS)
    .optional()
    .describe(
      'Per-task prompts, index-aligned with titles. Each task gets shared prompt + "\\n\\n" + its own (empty side dropped). Use for N different jobs; omit for N attempts at one job.',
    ),
  roles: z
    .array(z.enum(ORCH_ROLES))
    .max(FANOUT_MAX_TASKS)
    .optional()
    .describe(
      // Kept terse on purpose: the commander tools/list payload is budgeted
      // (scripts/mcp-protocol-baseline.json), and the long form of this already
      // lives in the brain's `fanout` skill and the SDK system prompt.
      `Per-task role (${ORCH_ROLES.join(' | ')}), index-aligned with titles. Picks that task's agent CLI and model from the operator's bindings — your only agent control. Omit for the default.`,
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
    `Fan out one job into N isolated parallel tasks (max ${FANOUT_MAX_TASKS}). Each task gets its own git worktree on a fresh wtask/ branch, its own wmux workspace with an agent pane already launched on the prompt, and its own mission channel — so N attempts at one problem, or N independent jobs, never collide in one checkout. ` +
      // Deliberately NOT naming channel_mission_list here: that tool is outside
      // the commander surface, so pointing a brain at it names a tool its
      // tools/list does not contain. Every profile can see the mission channels
      // themselves, which is the same answer.
      'Returns { status: "accepted" } immediately: spawning outlasts one RPC, so poll with the SAME idempotency_key, or watch each mission channel appear in your channel list. ' +
      'The user must approve first and that prompt is never auto-approved; unanswered, a poll reports { status: "denied", reason: "timeout" } rather than leaving you waiting. ' +
      'Repository, owning workspace and agent command all come from your verified identity — fan-out runs in YOUR repository, the tasks are owned by you, and it is refused without that identity.',
    FANOUT_START_SHAPE,
    async ({ idempotency_key, titles, prompt, task_prompts, roles }) => {
      const params: Record<string, unknown> = {
        idempotencyKey: idempotency_key,
        titles,
      };
      if (prompt !== undefined) params['prompt'] = prompt;
      if (task_prompts !== undefined) params['taskPrompts'] = task_prompts;
      if (roles !== undefined) params['roles'] = roles;
      // The verified ptyId is the whole identity basis for this call — the
      // handler resolves it to the owning workspace and refuses without it.
      // Resolve identity FIRST: the walk that produces that ptyId is a side
      // effect of the workspace lookup, so reading the getter cold (this tool
      // called first on a fresh server) yields '' and the call is refused.
      // The resolved workspace id is discarded on purpose — the handler
      // derives the owner from the ptyId and rejects a caller-stated one.
      if (deps.resolveWorkspaceId) {
        try {
          await deps.resolveWorkspaceId();
        } catch {
          // Unresolvable identity is the handler's refusal to make, with its
          // own message. Fall through with whatever the getter has.
        }
      }
      const pty = resolveSenderPtyId();
      if (pty) params['senderPtyId'] = pty;

      try {
        const result = (await sendRpc('task.fanout.start' as RpcMethod, params)) as
          | { ok: true; [k: string]: unknown }
          | { ok: false; error: { code: string; message: string } }
          | undefined;
        // `ok: false` covers both a rejected request and a terminal outcome
        // (denied / expired); both are things the caller must stop polling on,
        // and `isError` is how it learns that. But the ENVELOPE goes back
        // whole: collapsing it to `Error [code]: message` discarded `status`,
        // `reason` and `idempotencyKey`, so an unattended caller could not tell
        // "the user declined" from "the 30s prompt expired with nobody at the
        // keyboard" from "this key already ran and its result aged out" — which
        // is half of what the async contract exists to report.
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? {}, null, 2) }],
          ...(result && result.ok === false ? { isError: true as const } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
