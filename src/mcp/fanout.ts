// ─── Fan-out tool for the bundled MCP server ────────────────────────────
//
// `fanout_start` exposes the `task.fanout.start` pipe RPC: one prompt → N
// isolated git worktrees, each with its own workspace, agent pane and mission
// channel. Until now fan-out was reachable only from the GUI modal, so an agent
// supervising a fleet could not open one.
//
// The tool schema deliberately has NO agent-command, workspace, member or
// repository input. The CLI is chosen by NAME only — `agents[].agent` is a slug
// from a closed table and `preset` names operator data — never by command. Those are all derived server-side from the caller's
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
import { FANOUT_MODEL_RE } from '../shared/fanoutPreset';
import { EFFORT_TOKEN_RE } from '../shared/agentLaunchOptions';
import { BOT_SECRET_LIMITS } from '../shared/botSecret';

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
  /** List `pc` and `root` (tasks on another PC). Only a pane caller may use
   *  them, so a bot or commander surface does not list them. */
  remotePc?: boolean;
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
      `Per-task role (${ORCH_ROLES.join(' | ')}), index-aligned with titles. Picks that task's agent CLI and model from the operator's bindings. Omit for the default.`,
    ),
  // Fixed text on purpose: the operator's preset NAMES are never inlined here —
  // tools/list is pinned per profile (scripts/mcp-protocol-baseline.json), and
  // an unknown name is answered with the list instead.
  preset: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Operator preset name (Settings). Task k runs on its row k; unknown names return the list.'),
  agents: z
    .array(
      z
        .object({
          agent: z.string().min(1).max(48),
          model: z.string().regex(FANOUT_MODEL_RE).max(64).optional(),
          effort: z.string().regex(EFFORT_TOKEN_RE, 'effort must be one lowercase word, e.g. low, medium, high').optional(),
        })
        .strict(),
    )
    .max(FANOUT_MAX_TASKS)
    .optional()
    .describe(
      'Per-task agent CLI slug (+ model, + effort), one per title. Effort overrides the CLI default; an agent without an effort flag ignores it with a warning. At most one of roles, preset, agents.',
    ),
  files: z
    .array(z.array(z.string().min(1).max(256)).max(32))
    .max(FANOUT_MAX_TASKS)
    .optional()
    .describe('Per-task write scope (repo-relative globs), one non-empty list per title. Overlap is refused unless one task depends on the other.'),
  depends_on: z
    .array(z.array(z.number().int().min(0)).max(FANOUT_MAX_TASKS))
    .max(FANOUT_MAX_TASKS)
    .optional()
    .describe('Per-task 0-based indices of tasks that must reach review_requested/completed before this one is spawned from a fresh origin commit.'),
  cancel_pending: z.boolean().optional().describe('With an existing key: drop its tasks still waiting on depends_on.'),
  checkout: z
    .object({
      sha: z.string().regex(/^[0-9a-f]{40}$/),
      fetch_ref: z.string().regex(/^(?:pull|merge-requests)\/[1-9][0-9]{0,8}\/head$/).optional(),
    })
    .strict()
    .optional()
    .describe('Verifier bot, preset "verify": the PR head to check out detached (fetch_ref fetches it first: pull/<n>/head on GitHub, merge-requests/<n>/head on GitLab).'),
  secret_names: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/))
    .min(1)
    .max(BOT_SECRET_LIMITS.NAMES_PER_FANOUT)
    .optional()
    .describe('Bot: stored secret names (secret_list) each worker gets as env vars.'),
  connectors: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/))
    .min(1)
    .max(8)
    .optional()
    .describe('Bot: connections (MCP servers) from your wake prompt that each worker loads; their output is outside text, so the task is never merged without the owner.'),
  thread_id: z.string().min(1).max(240).optional().describe('Bot: the room thread the tasks report in (default: your wake\'s).'),
};

/** fanout_start's tasks on another PC (pane callers only). */
const FANOUT_REMOTE_SHAPE = {
  pc: z.string().max(256).optional().describe('Run every task on this paired PC (Claude only; needs root). remote_spawn with no pc lists PCs.'),
  root: z.string().max(64).optional().describe('With pc: a folder id it allows (same list).'),
};

/** Register the fan-out tool on the given MCP server. */
/** The accept's `warnings`, defensively: an unknown shape yields none. */
function readWarnings(result: unknown): string[] {
  const w = (result as { warnings?: unknown } | null | undefined)?.warnings;
  if (!Array.isArray(w)) return [];
  return w.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

export function registerFanOutTools(server: McpServer, deps: FanOutToolDeps): void {
  // Captured per registration, not a module global: the broker hosts many
  // servers in one process, and a global would stamp every connection's
  // fan-out with the last-registered connection's identity.
  const resolveSenderPtyId = deps.getSenderPtyId ?? (() => '');

  server.tool(
    'fanout_start',
    `Fan out one job into N parallel tasks (max ${FANOUT_MAX_TASKS}), each with its own git worktree on a fresh wtask/ branch, its own workspace with an agent pane launched on the prompt, and its own mission channel. ` +
      // Deliberately NOT naming channel_mission_list here: that tool is outside
      // the commander surface, so pointing a brain at it names a tool its
      // tools/list does not contain. Every profile can see the mission channels
      // themselves, which is the same answer.
      'Returns { status: "accepted", ownerWorkspaceId } immediately. ownerWorkspaceId (and its deprecated alias workspaceId) is YOUR workspace, never a task\'s — never close it; each task\'s own workspaceId is in the completed poll\'s result.tasks[]. Poll with the SAME idempotency_key, or watch your channel list for the mission channels. ' +
      'No approval prompt unless the user turned it on (unanswered: denied/timeout). A task cannot fan out again; a live or hourly cap the user set refuses it. ' +
      'Repository and owner come from your verified identity: fan-out runs in YOUR repository and is refused without it. A preset may skip the worktree (each task gets its own folder). ' +
      'An accept or completed poll may carry `warnings` (also as WARNING lines): it ran, but its reports may not reach you or the tasks did not start from a fresh origin commit — act on it.',
    deps.remotePc ? { ...FANOUT_START_SHAPE, ...FANOUT_REMOTE_SHAPE } : FANOUT_START_SHAPE,
    async ({ idempotency_key, titles, prompt, task_prompts, roles, preset, agents, files, depends_on, cancel_pending, checkout, secret_names, connectors, thread_id, ...rest }) => {
      const params: Record<string, unknown> = {
        idempotencyKey: idempotency_key,
        titles,
      };
      if (prompt !== undefined) params['prompt'] = prompt;
      if (task_prompts !== undefined) params['taskPrompts'] = task_prompts;
      if (roles !== undefined) params['roles'] = roles;
      if (preset !== undefined) params['preset'] = preset;
      if (agents !== undefined) params['agents'] = agents;
      if (files !== undefined) params['files'] = files;
      if (depends_on !== undefined) params['dependsOn'] = depends_on;
      if (cancel_pending === true) params['cancelPending'] = true;
      if (checkout !== undefined) {
        params['checkout'] = { sha: checkout.sha, ...(checkout.fetch_ref !== undefined ? { fetchRef: checkout.fetch_ref } : {}) };
      }
      if (secret_names !== undefined) params['secretNames'] = secret_names;
      if (connectors !== undefined) params['connectors'] = connectors;
      if (thread_id !== undefined) params['threadId'] = thread_id;
      const { pc, root } = rest as { pc?: string; root?: string };
      if (pc !== undefined) params['pc'] = pc;
      if (root !== undefined) params['root'] = root;
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
        // A warning is not a refusal — the fan-out IS running — but it names a
        // condition that will break the loop it started (an unanswered decision
        // on the owner workspace holds every worker report). A JSON key is
        // skippable; a first line is not, so it is surfaced as its own content
        // block ahead of the untouched envelope.
        const warnings = readWarnings(result);
        return {
          content: [
            ...warnings.map((w) => ({ type: 'text' as const, text: `WARNING: ${w}` })),
            { type: 'text' as const, text: JSON.stringify(result ?? {}, null, 2) },
          ],
          ...(result && result.ok === false ? { isError: true as const } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  // Bringing back a task another PC ran: only where tasks on another PC can be started (a pane caller).
  if (!deps.remotePc) return;
  server.tool(
    'fanout_bring_back',
    'After fanout_start with pc: import that task\'s committed work into your repository as branch wmux/returned/<spawn_id>, nothing checked out. ' +
      'Returns the branch and sha; while it answers "asking", call again.',
    {
      spawn_id: z.string().max(64).describe('The task\'s sp-<uuid> (its row\'s remote.spawnId).'),
      cancel: z.boolean().optional().describe('Stop one under way.'),
    },
    async ({ spawn_id, cancel }) => {
      if (deps.resolveWorkspaceId) {
        try {
          await deps.resolveWorkspaceId();
        } catch {
          // The handler refuses an unverifiable caller with its own words.
        }
      }
      const params: Record<string, unknown> = { spawnId: spawn_id };
      if (cancel === true) params['cancel'] = true;
      const pty = resolveSenderPtyId();
      if (pty) params['senderPtyId'] = pty;
      try {
        // Waits for the other PC up to 15 s, then a local import: well past the default deadline.
        const result = (await sendRpc('task.fanout.bringBack', params, BRING_BACK_RPC_TIMEOUT_MS)) as
          | { ok: true; text?: unknown }
          | { ok: false; error: { code: string; message: string } }
          | undefined;
        if (!result || result.ok !== true) {
          const e = result && result.ok === false ? result.error : { code: 'UNAVAILABLE', message: 'no answer' };
          return { content: [{ type: 'text' as const, text: `Error [${e.code}]: ${e.message}` }], isError: true };
        }
        // Main's fixed words, a sha and a branch name only.
        return { content: [{ type: 'text' as const, text: typeof result.text === 'string' ? result.text : JSON.stringify(result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

/** A bring-back call's deadline: the 15 s wait for the other PC plus the import's git (up to 120 s). */
const BRING_BACK_RPC_TIMEOUT_MS = 180_000;
