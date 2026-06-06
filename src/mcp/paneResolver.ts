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
 * This module holds a process-lifetime "pinned ptyId" that external
 * callers claim on first use via the mcp.claimWorkspace RPC. The pin
 * survives for the MCP server process only; when the external Claude Code
 * exits, the subprocess dies and the pin disappears. The claimed workspace
 * and its pane are left intact so the user can inspect output afterwards.
 */

import type { RpcMethod } from '../shared/rpc';

export interface PaneResolverDeps {
  /** JSON-RPC sender (wmux-client.sendRpc, usually). */
  sendRpc: (method: RpcMethod, params?: Record<string, unknown>) => Promise<unknown>;
  /**
   * Verified identity resolver. Must return empty string when the MCP server
   * can't prove it is running inside a live wmux PTY. This resolver must not
   * trust user-supplied environment hints such as WMUX_WORKSPACE_ID.
   */
  resolveWorkspaceId: () => Promise<string>;
}

let pinnedPtyId: string | null = null;
let claimInFlight: Promise<string | null> | null = null;

/**
 * Resolve the default ptyId for terminal tools when the caller didn't
 * provide one explicitly.
 *
 * Returns:
 * - A pinned ptyId for external callers (first call triggers a claim RPC
 *   that creates a dedicated workspace + PTY).
 * - null for internal callers — signalling that the main process should
 *   fall back to the active pane (existing behavior).
 *
 * Concurrent first calls de-dupe through claimInFlight so we don't race
 * and spawn multiple claim workspaces.
 */
export async function resolveDefaultPtyId(deps: PaneResolverDeps): Promise<string | null> {
  if (pinnedPtyId) return pinnedPtyId;
  if (claimInFlight) return claimInFlight;

  claimInFlight = (async () => {
    const wsId = await deps.resolveWorkspaceId();
    if (wsId) return null;

    try {
      const result = await deps.sendRpc('mcp.claimWorkspace', { name: 'MCP' });
      const ptyId = (result as { ptyId?: string } | null)?.ptyId;
      if (typeof ptyId === 'string' && ptyId.length > 0) {
        pinnedPtyId = ptyId;
        return ptyId;
      }
      throw new Error('mcp.claimWorkspace returned no ptyId');
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
  pinnedPtyId = null;
  claimInFlight = null;
}
