/**
 * Default-pane resolution for the wmux MCP server.
 *
 * Terminal tools (terminal_send, terminal_read, terminal_send_key,
 * terminal_read_events) accept an optional ptyId. When it's omitted, the
 * main process falls back to the currently-focused pane. That fallback is
 * fine for callers running INSIDE a wmux PTY (Claude Code in a wmux pane),
 * but wrong for external callers (Claude Code in cmd.exe / Windows
 * Terminal / VS Code terminal) — there the user almost always has live
 * work in the focused pane and keystrokes would hijack it.
 *
 * This module holds a process-lifetime "pinned route" (ptyId + owning
 * workspaceId) that external callers claim on first use via the
 * mcp.claimWorkspace RPC. The pin survives for the MCP server process
 * only; when the external Claude Code exits, the subprocess dies and the
 * pin disappears. The claimed workspace and its pane are left intact so
 * the user can inspect output afterwards.
 *
 * The workspaceId is pinned ALONGSIDE the ptyId (issue #163 Part 2): the
 * terminal RPCs carry workspaceId so the main process can assert PTY
 * ownership, and that id must come from the claim response — never from
 * the spoofable WMUX_WORKSPACE_ID env hint. A pin without a workspaceId
 * would force callers back onto the hint, reopening the bypass, so a
 * claim response missing either id fails closed.
 */

import type { RpcMethod } from '../shared/rpc';

export interface PinnedRoute {
  ptyId: string;
  workspaceId: string;
}

export interface ClaimDeps {
  /** JSON-RPC sender (wmux-client.sendRpc, usually). */
  sendRpc: (method: RpcMethod, params?: Record<string, unknown>) => Promise<unknown>;
}

let pinned: PinnedRoute | null = null;
let claimInFlight: Promise<PinnedRoute> | null = null;

/** The route claimed earlier in this process, or null before the first claim. */
export function getPinnedRoute(): PinnedRoute | null {
  return pinned;
}

/**
 * Claim a dedicated workspace + PTY for an external caller and pin both ids
 * for the rest of this process's lifetime.
 *
 * Concurrent first calls de-dupe through claimInFlight so we don't race
 * and spawn multiple claim workspaces. Failures throw (fail-closed) and do
 * NOT pin, so a later call retries instead of being permanently disabled.
 */
export async function claimPinnedRoute(deps: ClaimDeps): Promise<PinnedRoute> {
  if (pinned) return pinned;
  if (claimInFlight) return claimInFlight;

  claimInFlight = (async () => {
    try {
      const result = await deps.sendRpc('mcp.claimWorkspace', { name: 'MCP' });
      const ptyId = (result as { ptyId?: string } | null)?.ptyId;
      const workspaceId = (result as { workspaceId?: string } | null)?.workspaceId;
      if (typeof ptyId !== 'string' || ptyId.length === 0) {
        throw new Error('mcp.claimWorkspace returned no ptyId');
      }
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        // Pinning the ptyId without its owner would leave terminal RPCs with
        // no trustworthy workspaceId to assert against — fail closed instead.
        throw new Error('mcp.claimWorkspace returned no workspaceId');
      }
      pinned = { ptyId, workspaceId };
      return pinned;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[mcp] claimWorkspace failed:', message);
      throw new Error(`Unable to claim a dedicated MCP terminal workspace: ${message}`);
    }
  })();

  try {
    return await claimInFlight;
  } finally {
    claimInFlight = null;
  }
}

/** Test-only: clear module state so each test starts with an empty pin. */
export function __resetPaneResolverForTesting(): void {
  pinned = null;
  claimInFlight = null;
}
