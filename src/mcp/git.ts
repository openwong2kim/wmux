// ─── Read-only git/gh tools for a task worktree ─────────────────────────────
//
// A supervising agent had exactly one way to find out what a task had actually
// produced: read its pane's screen. Screens lie — they scroll, they are
// redrawn by full-screen TUIs, and they carry no structure. These three tools
// answer the same questions as data.
//
// Read-only by construction. There is no argument that becomes part of a git
// command line: the caller names a TASK, main resolves that to a worktree it
// has already checked the caller owns, and runs a fixed argv there. `git_log`'s
// limit is a number, clamped server-side.
//
// Failures come back as DATA, not as thrown errors: "there is no PR for this
// branch" and "gh is not installed" are answers a caller acts on.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';

/** Mirrors TASK_GIT_LOG_DEFAULT / TASK_GIT_LOG_MAX in
 *  src/main/pipe/handlers/worktask.rpc.ts. Restated rather than imported: this
 *  file is bundled into the MCP server, and importing from src/main would drag
 *  the whole main process into that bundle. The server clamps regardless, so a
 *  drift here costs a slightly wrong description, never a wrong result. */
const TASK_GIT_LOG_DEFAULT = 20;
const TASK_GIT_LOG_MAX = 50;

/** Identical injection contract to WorktaskToolDeps / FanOutToolDeps. */
export interface GitToolDeps {
  getSenderPtyId?: () => string;
  resolveWorkspaceId?: () => Promise<string>;
}

const TASK_ID = z
  .string()
  .min(1)
  .describe('The task id (wtask-…) whose worktree to read. Must be a task your workspace owns.');

async function callGit(
  method: string,
  params: Record<string, unknown>,
  deps: GitToolDeps,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  if (deps.resolveWorkspaceId) {
    try {
      await deps.resolveWorkspaceId();
    } catch {
      // main's refusal to make, with its own message.
    }
  }
  const pty = deps.getSenderPtyId?.() ?? '';
  const wire: Record<string, unknown> = { ...params };
  if (pty) wire['senderPtyId'] = pty;
  try {
    const result = (await sendRpc(method as unknown as RpcMethod, wire)) as { ok?: boolean } | undefined;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? {}, null, 2) }],
      ...(result && result.ok === false ? { isError: true as const } : {}),
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/** Register the read-only git tools on the given MCP server. */
export function registerGitTools(server: McpServer, deps: GitToolDeps): void {
  server.tool(
    'git_status',
    'Working-tree state of a task\'s worktree, as data: { branch, ahead, behind, clean, files: [{ status, path }] }. ' +
      'Use it before task_close (which refuses on a dirty or unpushed branch) and instead of reading a terminal screen to guess whether a worker has finished.',
    { task_id: TASK_ID },
    async ({ task_id }) => callGit('task.git.status', { taskId: task_id }, deps),
  );

  server.tool(
    'git_log',
    `Recent commits in a task's worktree: [{ hash, author, date, subject }], newest first. ` +
      `limit defaults to ${TASK_GIT_LOG_DEFAULT} and is clamped to ${TASK_GIT_LOG_MAX}; the limit that actually ran comes back in the result.`,
    {
      task_id: TASK_ID,
      limit: z
        .number()
        .int()
        .min(1)
        .max(TASK_GIT_LOG_MAX)
        .optional()
        .describe(`How many commits (default ${TASK_GIT_LOG_DEFAULT}, max ${TASK_GIT_LOG_MAX}).`),
    },
    async ({ task_id, limit }) =>
      callGit('task.git.log', { taskId: task_id, ...(limit !== undefined ? { limit } : {}) }, deps),
  );

  server.tool(
    'gh_pr_view',
    'The pull request for a task\'s branch, via the GitHub CLI: { number, title, state, url, isDraft, headRefName, mergeStateStatus }. ' +
      'Returns { ok: false, reason: "no-pr" } when there is none, when gh is missing, or when it is unauthenticated — all normal states, not call failures. Use it after task_pr to watch a PR, rather than opening a second one.',
    { task_id: TASK_ID },
    async ({ task_id }) => callGit('task.gh.prView', { taskId: task_id }, deps),
  );
}
