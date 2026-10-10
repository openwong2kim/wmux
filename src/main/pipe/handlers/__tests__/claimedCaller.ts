import type { RpcRouter } from '../../RpcRouter';
import { claimTokenForPane, mintWorkspaceClaimToken } from '../../../workspace/workspaceClaimTrust';

/**
 * Browser calls take their workspace from a verified identity, never from the
 * request's `workspaceId`. Suites that test HANDLER behaviour (not the lane
 * table) send each request the way the pane MCP does: holding a claim on the
 * workspace it names, so the `workspaceId` in params only narrows that claim.
 *
 * A request that also names its pane (`callerPtyId`) holds a pane claim, the
 * way main mints one from its process-tree walk.
 *
 * A request that names no workspace is sent as the operator instead: the
 * renderer is the one caller that may still act without a workspace, so it is
 * how those suites keep reaching the unscoped code paths.
 *
 * Applies only to a request with no identity of its own (no token, no client
 * name, no dispatch options); anything a test sets explicitly is left alone —
 * `workspaceToken: undefined` sends a request with no identity at all.
 */
export function dispatchAsClaimedCaller(router: RpcRouter): RpcRouter {
  const dispatch = router.dispatch.bind(router);
  router.dispatch = ((request, opts) => {
    const req = request as unknown as Record<string, unknown>;
    const params = (req['params'] ?? {}) as Record<string, unknown>;
    const workspaceId = params['workspaceId'];
    if (opts !== undefined || 'workspaceToken' in req || 'clientName' in req) {
      return dispatch(request, opts);
    }
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return dispatch(request, { operator: true });
    }
    const pane = typeof req['callerPtyId'] === 'string' ? req['callerPtyId'] : undefined;
    return dispatch({ ...request, ...(pane ? paneClaimOn(workspaceId, pane) : claimOn(workspaceId)) } as typeof request);
  }) as RpcRouter['dispatch'];
  return router;
}

/** The envelope field for a caller holding a claim on `workspaceId`. */
export function claimOn(workspaceId: string): { workspaceToken: string } {
  const token = mintWorkspaceClaimToken(workspaceId);
  if (!token) throw new Error(`could not mint a claim on ${workspaceId}`);
  return { workspaceToken: token };
}

/** The envelope field for a caller holding a pane claim (workspace + pane). */
export function paneClaimOn(workspaceId: string, ptyId: string): { workspaceToken: string } {
  const token = claimTokenForPane(workspaceId, ptyId);
  if (!token) throw new Error(`could not mint a pane claim on ${workspaceId}/${ptyId}`);
  return { workspaceToken: token };
}
