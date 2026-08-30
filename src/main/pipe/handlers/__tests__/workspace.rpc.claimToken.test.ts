// #922 PR-A — issuing and retiring the workspace claim token, through the real
// router and the real handler.
//
// `mcp.claimWorkspace` is the one call where main CREATES a workspace for a
// specific caller, so the association it records is a fact main holds rather
// than one the caller asserts. What is pinned here:
//
//   - the token is minted and returned only for the external wire;
//   - it is bound to the workspace the claim actually produced;
//   - it rides ALONGSIDE the existing response fields, so no caller that
//     ignores it can notice this change;
//   - closing the workspace retires it.
//
// Nothing reads the token for an authorisation decision in PR-A. These tests
// therefore assert issuance and lifecycle only — the lane that consumes it is
// PR-B, and adding a consumer here would defeat the point of the split.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerWorkspaceRpc } from '../workspace.rpc';
import {
  __resetWorkspaceClaimTrustForTesting,
  lookupWorkspaceClaim,
} from '../../../workspace/workspaceClaimTrust';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerWorkspaceRpc(router, () => fakeWindow);
  return router;
}

/** The claim response the renderer really returns (paneResolver reads both ids). */
const CLAIM_RESULT = { ptyId: 'daemon-mcp', workspaceId: 'ws-claimed', workspaceName: 'MCP' };

function tokenFrom(response: unknown): string | undefined {
  const result = (response as { result?: Record<string, unknown> } | null)?.result;
  const token = result?.['workspaceToken'];
  return typeof token === 'string' ? token : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceClaimTrustForTesting();
  sendToRendererMock.mockResolvedValue(CLAIM_RESULT);
});

describe('mcp.claimWorkspace — token issuance', () => {
  it('mints a token bound to the workspace the claim created', async () => {
    const res = await setup().dispatch(
      { id: 'c1', method: 'mcp.claimWorkspace', params: { name: 'MCP' }, clientName: 'claude-code' },
      { externalWire: true },
    );

    const token = tokenFrom(res);
    expect(token).toBeTruthy();
    expect(lookupWorkspaceClaim(token)).toEqual({
      kind: 'bound',
      workspaceId: 'ws-claimed',
    });
  });

  it('leaves every existing response field untouched', async () => {
    // Additive by construction: a caller that never looks at the new key must
    // not be able to tell this shipped.
    const res = await setup().dispatch(
      { id: 'c2', method: 'mcp.claimWorkspace', params: {} },
      { externalWire: true },
    );

    const result = (res as { result?: Record<string, unknown> }).result!;
    expect(result).toMatchObject(CLAIM_RESULT);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'mcp.claimWorkspace',
      {},
    );
  });

  it('issues nothing to the in-process surfaces', async () => {
    // The renderer is the operator and the plugin host carries a
    // host-derived binding already (#941/#1097); neither needs a bearer
    // secret, and issuing one would only add a place for it to leak from.
    for (const opts of [
      { operator: true as const },
      { firstParty: true as const, hostedWorkspace: 'ws-host' },
    ]) {
      sendToRendererMock.mockResolvedValue(CLAIM_RESULT);
      const res = await setup().dispatch(
        { id: 'c3', method: 'mcp.claimWorkspace', params: {}, clientName: 'hello-panel' },
        opts,
      );
      expect(tokenFrom(res)).toBeUndefined();
      expect((res as { result?: Record<string, unknown> }).result).toMatchObject(CLAIM_RESULT);
    }
  });

  it.each([
    ['a renderer error envelope', { error: 'workspace limit reached' }],
    ['a response with no workspaceId', { ptyId: 'daemon-mcp' }],
    ['a blank workspaceId', { ptyId: 'daemon-mcp', workspaceId: '   ' }],
    ['a non-object result', 'nope'],
    ['null', null],
  ])('returns %s unchanged rather than failing the claim', async (_label, rendererResult) => {
    sendToRendererMock.mockResolvedValue(rendererResult);
    const res = await setup().dispatch(
      { id: 'c4', method: 'mcp.claimWorkspace', params: {} },
      { externalWire: true },
    );

    expect(res.ok).toBe(true);
    expect((res as { result?: unknown }).result).toEqual(rendererResult);
    expect(tokenFrom(res)).toBeUndefined();
  });
});

describe('workspace.close — token retirement', () => {
  it('turns the claim stale so a re-minted id cannot inherit it', async () => {
    const router = setup();
    const claim = await router.dispatch(
      { id: 'c5', method: 'mcp.claimWorkspace', params: {} },
      { externalWire: true },
    );
    const token = tokenFrom(claim);
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-claimed' });

    sendToRendererMock.mockResolvedValue({ ok: true });
    const closed = await router.dispatch({
      id: 'c6',
      method: 'workspace.close',
      params: { id: 'ws-claimed' },
    });

    expect(closed.ok).toBe(true);
    expect((closed as { result?: unknown }).result).toEqual({ ok: true });
    // Stale, NOT unclaimed: the holder presented something that no longer
    // resolves, and PR-B must be able to tell that from never having claimed.
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'stale' });
  });

  it('still rejects a close with no id, before touching the registry', async () => {
    const res = await setup().dispatch({ id: 'c7', method: 'workspace.close', params: {} });
    expect(res.ok).toBe(false);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('leaves an unrelated workspace\'s claim alone', async () => {
    const router = setup();
    const claim = await router.dispatch(
      { id: 'c8', method: 'mcp.claimWorkspace', params: {} },
      { externalWire: true },
    );
    const token = tokenFrom(claim);

    sendToRendererMock.mockResolvedValue({ ok: true });
    await router.dispatch({ id: 'c9', method: 'workspace.close', params: { id: 'ws-other' } });

    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-claimed' });
  });
});
