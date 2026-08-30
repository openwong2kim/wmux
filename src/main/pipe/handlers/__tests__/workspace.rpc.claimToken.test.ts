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

describe('workspace.close — a REFUSED close must not retire the claim', () => {
  // The renderer reports a refusal as a resolved `{ error }` envelope, not a
  // rejection (#799), so awaiting the call proves nothing on its own. Revoking
  // unconditionally would kill the claim of a workspace that is STILL OPEN and
  // still the holder's — and under the lane that refuses a stale claim, that
  // holder is then locked out of its own live workspace, because re-claiming
  // mints a new workspace rather than re-binding the old one.
  //
  // It is reachable by someone else, too: ids come from `workspace.list`, so a
  // second caller can aim a close it knows will be refused at a claimant's
  // workspace and destroy only that claim.
  const claim = async (router: RpcRouter): Promise<string | undefined> => {
    sendToRendererMock.mockResolvedValue(CLAIM_RESULT);
    const res = await router.dispatch(
      { id: 'rc', method: 'mcp.claimWorkspace', params: {} },
      { externalWire: true },
    );
    return tokenFrom(res);
  };

  it.each([
    ['an unknown id', { error: 'workspace.close: no workspace with id "ws-claimed"' }],
    [
      'the last-workspace guard',
      { error: 'workspace.close: refusing to close "ws-claimed" — it is the only workspace' },
    ],
    [
      'a removal the store refused',
      { error: 'workspace.close: "ws-claimed" is still open — the removal was refused' },
    ],
  ])('keeps the claim alive when the close is refused by %s', async (_label, refusal) => {
    const router = setup();
    const token = await claim(router);

    sendToRendererMock.mockResolvedValue(refusal);
    const res = await router.dispatch({
      id: 'rc-close',
      method: 'workspace.close',
      params: { id: 'ws-claimed' },
    });

    // The refusal is passed through unchanged...
    expect((res as { result?: unknown }).result).toEqual(refusal);
    // ...and the workspace is still open, so the claim must still resolve.
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-claimed' });
  });

  it.each([
    ['a shape it does not recognise', { closed: true }],
    ['a bare string', 'closed'],
    ['null', null],
  ])('leaves the claim alone for %s — being wrong safely', async (_label, weird) => {
    // A positive `ok === true` check rather than "no error": an unrecognised
    // response should cost a stale binding at worst, never a live claimant's
    // access to its own workspace.
    const router = setup();
    const token = await claim(router);

    sendToRendererMock.mockResolvedValue(weird);
    await router.dispatch({ id: 'rc-weird', method: 'workspace.close', params: { id: 'ws-claimed' } });

    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-claimed' });
  });

  it('still retires the claim when the close actually succeeds', async () => {
    // The positive control: the fix must not turn revocation off altogether.
    const router = setup();
    const token = await claim(router);

    sendToRendererMock.mockResolvedValue({ ok: true });
    await router.dispatch({ id: 'rc-ok', method: 'workspace.close', params: { id: 'ws-claimed' } });

    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'stale' });
  });
});
