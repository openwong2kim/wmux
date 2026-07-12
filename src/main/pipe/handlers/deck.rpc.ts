// ─── Command Deck pipe RPC — commander pane-route resolution (P3b, M1.5) ────
//
// `deck.resolvePaneRoute` gives the commander brain's MCP subprocess the one
// thing external routing denies it: the true owning workspaceId of a pane, so
// its terminal_send/terminal_read can pass the ownership assert
// (assertWorkspaceOwnsPty) instead of being confined to a claimed "MCP"
// workspace. Auth is the per-spawn token main injected into that subprocess's
// env (commanderTrust.ts) — not the caller's pane identity — because the
// brain has none by construction.
//
// M1.5 (per-workspace orchestrator): resolution is CONFINED to the workspace
// the token was minted for. A pane owned by ANY OTHER workspace throws —
// a workspace's orchestrator structurally cannot target another workspace's
// panes (§4.0: the blast radius of a misjudging brain is its own workspace).
// Cross-workspace work is the operator's, via that workspace's own deck tab.
//
// Fail-closed: a missing/stale token, an unowned ptyId, or a pane outside the
// token's workspace throws; the MCP client then falls back to the ordinary
// (external) routing rules.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import { commanderTokenWorkspace } from '../../deck/commanderTrust';

type GetWindow = () => BrowserWindow | null;

export function registerDeckRpc(router: RpcRouter, getWindow: GetWindow): void {
  router.register('deck.resolvePaneRoute', async (params) => {
    const token = params['token'];
    const tokenWorkspaceId = commanderTokenWorkspace(token);
    if (!tokenWorkspaceId) {
      throw new Error('deck.resolvePaneRoute: not a live commander session');
    }
    const ptyId = params['ptyId'];
    if (typeof ptyId !== 'string' || ptyId.length === 0) {
      throw new Error('deck.resolvePaneRoute: missing required param "ptyId"');
    }
    // Same ownership oracle assertWorkspaceOwnsPty consults — the renderer's
    // live workspace tree.
    const result = await sendToRenderer(getWindow, 'input.findOwnerWorkspace', { ptyId });
    const owner =
      result && typeof result === 'object' && 'workspaceId' in result
        ? ((result as Record<string, unknown>)['workspaceId'] as string | null)
        : null;
    if (typeof owner !== 'string' || owner.length === 0) {
      throw new Error(`deck.resolvePaneRoute: no workspace owns PTY "${ptyId}"`);
    }
    if (owner !== tokenWorkspaceId) {
      throw new Error(
        `deck.resolvePaneRoute: PTY "${ptyId}" is outside this orchestrator's workspace`,
      );
    }
    return { workspaceId: owner };
  });

  // `deck.resolveCommanderWorkspace` gives the brain its OWN sender identity —
  // the home workspace its token is bound to — with no pane needed. The brain's
  // MCP subprocess has no pane ancestry and no WMUX_WORKSPACE_ID env hint, so
  // the A2A identity resolver (resolveWorkspaceId) otherwise misses on every
  // path and every A2A tool (send_message / a2a_task_send / a2a_broadcast …)
  // throws "Workspace identity unknown". Auth is the same per-spawn token as
  // resolvePaneRoute; a missing/stale token throws and the MCP client falls
  // through to the ordinary (external) resolution, so non-commander callers are
  // unchanged. Unlike resolvePaneRoute this needs no ptyId and no renderer
  // round-trip — it is a pure token→workspace lookup in main's trust registry.
  router.register('deck.resolveCommanderWorkspace', async (params) => {
    const tokenWorkspaceId = commanderTokenWorkspace(params['token']);
    if (!tokenWorkspaceId) {
      throw new Error('deck.resolveCommanderWorkspace: not a live commander session');
    }
    return { workspaceId: tokenWorkspaceId };
  });
}
