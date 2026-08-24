// ─── Pane + surface lifecycle tools for the bundled MCP server ───────────
//
// Five MCP tools that expose the pane/surface lifecycle pipe-RPC surface to
// first-party MCP clients (Claude Code, Codex CLI), so an external supervisor
// agent can spawn and reap its own panes/surfaces through the official MCP
// instead of a hand-written daemon JSON-RPC client. Issue #285 — a follow-up
// to the #236 workspace-scoping family (#238 pane.split, #256 pane.close /
// surface.new, #257 pane.focus / surface.focus).
//
// Design notes:
//  - Tool names follow `pane_*` / `surface_*` (mirrors pane_list / surface_list
//    / pane_set_metadata already in index.ts).
//  - Two param contracts, matching the underlying RPCs EXACTLY:
//      * CREATE family (pane_split, surface_new) takes an explicit, OPTIONAL
//        `workspaceId`. Omitted ⇒ the caller's OWN workspace is resolved
//        (resolveCallerWorkspaceId, the fail-soft read resolver) and
//        forwarded; on a true identity miss ('') nothing is forwarded and the
//        renderer falls back to the active workspace (human-keybind / CLI
//        parity). The renderer fails CLOSED on an explicit-but-unknown id.
//      * ADDRESS family (pane_close, pane_focus, surface_close) takes a single
//        globally-unique id and the renderer resolves it across ALL
//        workspaces — no workspaceId, no MCP-layer ownership re-check. The
//        first-party permission model is method-level, not workspace-scoped,
//        so a workspaceId param would be a false boundary; ids are unguessable
//        UUIDs and the OS-user account is the trust ceiling (issue #113 /
//        trust-root epic). This mirrors the daemon RPC contract 1:1.
//  - pane_focus is NON-YANK: it marks a background pane active without moving
//    the on-screen workspace. workspace.focus is the screen-switch RPC.
//  - callRpc + resolveCallerWorkspaceId are INJECTED (not imported) so the
//    behavioral test can capture each handler and assert its RPC mapping
//    against a mock, without booting the PID-map walk (mirrors channels.ts).
//
// Capability + allowlist: pane.* are pane.create / pane.read; surface.* are
// wmux.internal (reserved). All five are gated upstream in RpcRouter via
// methodCapabilityMap.ts and granted to the bundled server through
// FIRST_PARTY_METHODS (firstParty.ts) — the surface.* reserved entries also
// require ALLOWED_RESERVED_FIRST_PARTY (firstParty.test.ts); see the security
// review in plans/issue-285-pane-lifecycle-mcp-tools.md §6. The MCP tool layer
// does not re-check capability.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RpcMethod } from '../shared/rpc';
import {
  defineWmuxTool,
  registerWmuxTools,
  type RegisterWmuxToolsOptions,
} from './toolCatalog';

/** Resolvers/helpers the parent module injects so the behavioral test can
 *  capture each tool handler and assert its RPC mapping without booting the
 *  PID-map walk (src/mcp/index.ts wires its own callRpc + read resolver). */
export interface PaneLifecycleDeps {
  /** index.ts's callRpc: issues the pipe RPC and wraps the result as an MCP
   *  tool result (with stale-identity self-heal). */
  callRpc: (
    method: RpcMethod,
    params?: Record<string, unknown>,
  ) => Promise<{ content: { type: 'text'; text: string }[] }>;
  /** Fail-soft caller-own-workspace resolver for the CREATE family
   *  (= resolveScopedReadWorkspaceId): returns the caller's verified workspace
   *  id, or '' on a true identity miss (never throws — a create degrades to
   *  the renderer's active-ws fallback, matching pane_list / surface_list). */
  resolveCallerWorkspaceId: () => Promise<string>;
}

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects. The
// shapes carry no per-call state — the handlers (which close over `deps`) are
// created by createPaneLifecycleToolCatalog.
const PANE_SPLIT_SHAPE = {
  workspaceId: z
    .string()
    .optional()
    .describe("Target workspace by id. Omit to use your own (the caller's) workspace."),
  direction: z
    .enum(['horizontal', 'vertical'])
    .optional()
    .describe('Split direction. Default: horizontal.'),
};

const PANE_CLOSE_SHAPE = {
  paneId: z.string().describe('Leaf pane id to close (from pane_list).'),
};

const PANE_FOCUS_SHAPE = {
  paneId: z.string().describe('Leaf pane id to focus (from pane_list).'),
};

const SURFACE_NEW_SHAPE = {
  workspaceId: z
    .string()
    .optional()
    .describe("Target workspace by id. Omit to use your own (the caller's) workspace."),
  shell: z.string().optional().describe('Shell override. Omit for the workspace default.'),
  cwd: z.string().optional().describe('Working directory. Omit for the workspace default.'),
};

const SURFACE_CLOSE_SHAPE = {
  surfaceId: z.string().describe('Surface id to close (from surface_list).'),
};

const PANE_STASH_SHAPE = {
  paneId: z.string().describe('Leaf pane id to stash (from pane_list).'),
};

const PANE_UNSTASH_SHAPE = {
  paneId: z
    .string()
    .describe('Stashed pane id to bring back (from pane_list({ includeStashed: true }), or from the recovery payload of a PANE_STASHED error).'),
};

/**
 * Build the first typed-catalog domain. The ordering is the public MCP ordering
 * and must remain stable: the raw protocol probe pins it for both profiles.
 */
export function createPaneLifecycleToolCatalog(
  deps: PaneLifecycleDeps,
) {
  const { callRpc, resolveCallerWorkspaceId } = deps;

  return Object.freeze([
    // ── pane_split (CREATE family) ──────────────────────────────────
    defineWmuxTool({
      name: 'pane_split',
      description:
        'Split a leaf pane, creating a new sibling pane. Returns the new paneId (and a ptyWarning if a background PTY could not be pre-spawned). Omit workspaceId to split inside your own (the caller\'s) workspace; pass it to target a specific one — an unknown id is rejected, never silently redirected to the on-screen workspace.',
      inputSchema: PANE_SPLIT_SHAPE,
      profiles: ['full', 'commander'],
      invoke: async ({ workspaceId, direction }) => {
        const resolved = workspaceId || (await resolveCallerWorkspaceId());
        const params: Record<string, unknown> = { direction: direction ?? 'horizontal' };
        if (resolved) params['workspaceId'] = resolved;
        return callRpc('pane.split', params);
      },
    }),

    // ── pane_close (ADDRESS family) ─────────────────────────────────
    defineWmuxTool({
      name: 'pane_close',
      description:
        'Close a leaf pane and dispose its surfaces\' PTYs. paneId is globally unique and resolved across all workspaces, so a supervisor can reap a worker pane it created in a background workspace. Rejects branch (non-leaf) panes and the root pane.',
      inputSchema: PANE_CLOSE_SHAPE,
      profiles: ['full'],
      invoke: async ({ paneId }) => callRpc('pane.close', { id: paneId }),
    }),

    // ── pane_focus (ADDRESS family, non-yank) ───────────────────────
    defineWmuxTool({
      name: 'pane_focus',
      description:
        'Focus a leaf pane. Does NOT switch the on-screen workspace (non-yank): focusing a pane in a background workspace marks it active there without stealing the user\'s screen. Use workspace.focus to switch screens. paneId is resolved across all workspaces.',
      inputSchema: PANE_FOCUS_SHAPE,
      profiles: ['full', 'commander'],
      invoke: async ({ paneId }) => callRpc('pane.focus', { id: paneId }),
    }),

    // ── surface_new (CREATE family) ─────────────────────────────────
    defineWmuxTool({
      name: 'surface_new',
      description:
        'Open a new surface (terminal) in the active pane of a workspace. Returns the new surfaceId + ptyId. Omit workspaceId to open in your own (the caller\'s) workspace; an explicit unknown id is rejected.',
      inputSchema: SURFACE_NEW_SHAPE,
      profiles: ['full', 'commander'],
      invoke: async ({ workspaceId, shell, cwd }) => {
        const resolved = workspaceId || (await resolveCallerWorkspaceId());
        const params: Record<string, unknown> = {};
        if (resolved) params['workspaceId'] = resolved;
        if (shell !== undefined) params['shell'] = shell;
        if (cwd !== undefined) params['cwd'] = cwd;
        return callRpc('surface.new', params);
      },
    }),

    // ── surface_close (ADDRESS family) ──────────────────────────────
    defineWmuxTool({
      name: 'surface_close',
      description:
        'Close a surface and dispose its PTY. surfaceId is globally unique and resolved across all workspaces.',
      inputSchema: SURFACE_CLOSE_SHAPE,
      profiles: ['full'],
      invoke: async ({ surfaceId }) => callRpc('surface.close', { id: surfaceId }),
    }),

    // ── pane_stash / pane_unstash (LAYOUT family, #977) ──────────────
    // Appended after the original five so the public ordering stays a stable
    // prefix. Neither destroys anything, which is why both are in the commander
    // profile alongside pane_split while pane_close is not: they move a pane
    // between the layout and the workspace's stash, and the session runs either
    // way.
    defineWmuxTool({
      name: 'pane_stash',
      description:
        'Take a leaf pane OUT of the layout without killing it. The session keeps running in the daemon, so terminal_send / terminal_read / pane_close / A2A delivery all keep working against the pane while it is stashed; pane_focus is refused with a PANE_STASHED error naming pane_unstash. Refused when the pane is the only visible one, when it is empty (no session to keep), when the daemon is not connected (nothing would hold the session), or when the pane holds an editor/diff tab whose unsaved state cannot be replayed.',
      inputSchema: PANE_STASH_SHAPE,
      profiles: ['full', 'commander'],
      invoke: async ({ paneId }) => callRpc('pane.stash', { id: paneId }),
    }),

    defineWmuxTool({
      name: 'pane_unstash',
      description:
        'Put a stashed pane back into the layout, next to its former neighbour (or next to the active pane when that neighbour is gone). Idempotent: a pane that is already visible is a success, not an error — so the retry a PANE_STASHED error asks for is always safe to run.',
      inputSchema: PANE_UNSTASH_SHAPE,
      profiles: ['full', 'commander'],
      invoke: async ({ paneId }) => callRpc('pane.unstash', { id: paneId }),
    }),
  ]);
}

/** Register the five pane/surface lifecycle tools on the selected surface. */
export function registerPaneLifecycleTools(
  server: McpServer,
  deps: PaneLifecycleDeps,
  options: RegisterWmuxToolsOptions,
): void {
  registerWmuxTools(server, createPaneLifecycleToolCatalog(deps), options);
}
