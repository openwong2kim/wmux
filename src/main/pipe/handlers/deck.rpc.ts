// ─── Command Deck pipe RPC — commander pane-route resolution (P3b) ──────────
//
// `deck.resolvePaneRoute` gives the commander brain's MCP subprocess the one
// thing external routing denies it: the true owning workspaceId of an
// arbitrary pane, so its terminal_send/terminal_read can pass the ownership
// assert (assertWorkspaceOwnsPty) instead of being confined to a claimed
// "MCP" workspace. Auth is the per-spawn token main injected into that
// subprocess's env (commanderTrust.ts) — not the caller's pane identity —
// because the brain has none by construction.
//
// Fail-closed: a missing/stale token or an unowned ptyId throws; the MCP
// client then falls back to the ordinary (external) routing rules.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import { isCommanderToken } from '../../deck/commanderTrust';

type GetWindow = () => BrowserWindow | null;

export function registerDeckRpc(router: RpcRouter, getWindow: GetWindow): void {
  router.register('deck.resolvePaneRoute', async (params) => {
    const token = params['token'];
    if (!isCommanderToken(token)) {
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
    return { workspaceId: owner };
  });
}
