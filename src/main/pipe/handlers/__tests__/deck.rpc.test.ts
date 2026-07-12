// Unit tests for deck.resolvePaneRoute (P3b codex P1, M1.5 confinement) —
// the commander brain's route resolution. Token-gated: only a live commander
// token (minted by main for the brain subprocess) may resolve a pane's
// owning workspace, and ONLY for panes inside the token's own workspace;
// everything else fails closed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerDeckRpc } from '../deck.rpc';
import {
  mintCommanderToken,
  __resetCommanderTrustForTesting,
} from '../../../deck/commanderTrust';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerDeckRpc(router, () => fakeWindow);
  return router;
}

describe('deck.resolvePaneRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCommanderTrustForTesting();
  });

  it('resolves a pane owned by the token workspace', async () => {
    const token = mintCommanderToken('ws-owner');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-owner' });

    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-9' },
    });

    expect(res.ok).toBe(true);
    expect((res as { result: unknown }).result).toEqual({ workspaceId: 'ws-owner' });
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      { ptyId: 'pty-9' },
    );
  });

  it("fails closed on a pane owned by ANOTHER workspace (M1.5 confinement)", async () => {
    const token = mintCommanderToken('ws-mine');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-other' });

    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-9' },
    });

    expect(res.ok).toBe(false);
  });

  it('fails closed for a token minted with an empty workspace binding', async () => {
    const token = mintCommanderToken('');
    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-9' },
    });
    expect(res.ok).toBe(false);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('rejects a missing/unknown token BEFORE consulting the renderer', async () => {
    mintCommanderToken('ws-1'); // a live token exists, but the caller presents another
    const router = setup();

    for (const params of [
      { ptyId: 'pty-9' },
      { token: 'guessed', ptyId: 'pty-9' },
      { token: 42, ptyId: 'pty-9' },
    ]) {
      const res = await router.dispatch({
        id: 'x',
        method: 'deck.resolvePaneRoute',
        params: params as Record<string, unknown>,
      });
      expect(res.ok).toBe(false);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('fails closed on a missing ptyId and on an unowned pane', async () => {
    const token = mintCommanderToken('ws-1');
    const router = setup();

    const noPty = await router.dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token },
    });
    expect(noPty.ok).toBe(false);

    sendToRendererMock.mockResolvedValue({ workspaceId: null });
    const unowned = await router.dispatch({
      id: '2',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-ghost' },
    });
    expect(unowned.ok).toBe(false);
  });
});

// deck.resolveCommanderWorkspace — the brain's OWN sender identity (token→home
// workspace, no pane). This is what unblocks A2A tools for the orchestrator,
// which otherwise threw "Workspace identity unknown". Pure token lookup in
// main's trust registry: no renderer round-trip, fails closed without a live
// token.
describe('deck.resolveCommanderWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCommanderTrustForTesting();
  });

  it('returns the home workspace a live token is bound to, without touching the renderer', async () => {
    const token = mintCommanderToken('ws-home');
    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolveCommanderWorkspace',
      params: { token },
    });
    expect(res.ok).toBe(true);
    expect((res as { result: unknown }).result).toEqual({ workspaceId: 'ws-home' });
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('fails closed for a missing, unknown, or non-string token', async () => {
    mintCommanderToken('ws-1'); // a live token exists; callers below present others
    const router = setup();
    for (const params of [{}, { token: 'guessed' }, { token: 42 }]) {
      const res = await router.dispatch({
        id: 'x',
        method: 'deck.resolveCommanderWorkspace',
        params: params as Record<string, unknown>,
      });
      expect(res.ok).toBe(false);
    }
  });

  it('fails closed for a token minted with an empty workspace binding', async () => {
    const token = mintCommanderToken('');
    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolveCommanderWorkspace',
      params: { token },
    });
    expect(res.ok).toBe(false);
  });

  it('stops resolving a token after it is revoked (dead brain cannot replay)', async () => {
    const { mintCommanderToken: mint, revokeCommanderToken } = await import(
      '../../../deck/commanderTrust'
    );
    const token = mint('ws-home');
    revokeCommanderToken(token);
    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolveCommanderWorkspace',
      params: { token },
    });
    expect(res.ok).toBe(false);
  });
});
