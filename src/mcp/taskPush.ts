// ─── task_push — a worker publishes its own task branch ─────────────────────
//
// Every profile (full + core), worker-scoped: the `task.push` pipe RPC
// (src/main/pipe/handlers/taskPush.rpc.ts) resolves the caller's task from the
// server-verified senderPtyId and pushes that task's branch to origin itself.
// The tool takes no arguments: there is no branch, remote or refspec for a
// caller to name.
//
// task_fetch — the same caller and task: main fetches origin's default branch
// and the task branch into their remote-tracking refs (`task.fetch`), for a
// worker whose shell has no credentials for origin. Fetch only.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';

/** Mirrors main's TASK_PUSH_TIMEOUT_MS (worktask/taskPush.ts) plus headroom for
 *  the reads before it; restated, not imported (this file is bundled into the
 *  MCP server). */
const TASK_PUSH_RPC_TIMEOUT_MS = 150_000;

export interface TaskPushToolDeps {
  /** The server's OWN verified senderPtyId (PID-map walk hit, '' on miss). */
  getSenderPtyId?: () => string;
  /** Warms the walk that populates the ptyId above (see fanout.ts). */
  resolveWorkspaceId?: () => Promise<string>;
}

export function registerTaskPushTool(server: McpServer, deps: TaskPushToolDeps): void {
  const resolveSenderPtyId = deps.getSenderPtyId ?? (() => '');
  server.tool(
    'task_push',
    'Push YOUR fan-out task branch to origin (fast-forward only). Commit first. wmux pushes the branch of the task in your own workspace; there is nothing to name. Then open the PR with gh pr create --head <your branch>.',
    {},
    async () => {
      if (deps.resolveWorkspaceId) {
        try {
          await deps.resolveWorkspaceId();
        } catch {
          // The handler refuses an unresolvable caller with its own message.
        }
      }
      const params: Record<string, unknown> = {};
      const pty = resolveSenderPtyId();
      if (pty) params['senderPtyId'] = pty;
      try {
        // Outwait main's push (TASK_PUSH_TIMEOUT_MS, 120 s, plus its reads).
        const result = (await sendRpc('task.push' as RpcMethod, params, TASK_PUSH_RPC_TIMEOUT_MS)) as { ok?: boolean } | undefined;
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

/** Mirrors main's fetch timeout (the push's, worktask/taskPush.ts) plus headroom. */
const TASK_FETCH_RPC_TIMEOUT_MS = 150_000;

export function registerTaskFetchTool(server: McpServer, deps: TaskPushToolDeps): void {
  const resolveSenderPtyId = deps.getSenderPtyId ?? (() => '');
  server.tool(
    'task_fetch',
    'Fetch origin\'s default branch and YOUR task branch with wmux\'s credentials. It returns a `git fetch` line: run that line in your shell to bring them into origin/<name>, then git merge origin/<default>.',
    {},
    async () => {
      if (deps.resolveWorkspaceId) {
        try {
          await deps.resolveWorkspaceId();
        } catch {
          // The handler refuses an unresolvable caller with its own message.
        }
      }
      const params: Record<string, unknown> = {};
      const pty = resolveSenderPtyId();
      if (pty) params['senderPtyId'] = pty;
      try {
        const result = (await sendRpc('task.fetch' as RpcMethod, params, TASK_FETCH_RPC_TIMEOUT_MS)) as { ok?: boolean; fetchCommand?: unknown; fetchCommandWsl?: unknown } | undefined;
        // The fetch line first, verbatim, so the worker runs exactly it.
        const wsl = result && typeof result.fetchCommandWsl === 'string' ? `In a WSL shell, run this instead:\n${result.fetchCommandWsl}\n` : '';
        const line = result && typeof result.fetchCommand === 'string' ? `Run this in your shell, then \`git merge origin/<default>\`:\n${result.fetchCommand}\n${wsl}\n` : '';
        return {
          content: [{ type: 'text' as const, text: `${line}${JSON.stringify(result ?? {}, null, 2)}` }],
          ...(result && result.ok === false ? { isError: true as const } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
