// The caller of a pipe method an agent uses on a task it sent to another PC
// (`a2a.remote.answer`, `a2a.remote.approve`). Identity is server-resolved,
// never taken from params: the caller's senderPtyId resolves to its
// workspace, and the daemon then takes the call only from the task's local
// party. A hosted caller (a plugin) acts only from a pane of its bound
// workspace; an unbound one from none. A caller main already binds to a
// workspace (a commander token, a workspace claim) acts only from a pane of
// that workspace, and a stale claim acts from none.

import type { BrowserWindow } from 'electron';
import { hostedBindingOf, isHostedCaller, type RpcContext } from '../../../shared/rpc';
import { HUMAN_WORKSPACE_ID } from '../../../shared/channels';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';

export type ResolveCaller = (senderPtyId: string) => Promise<{ workspaceId: string } | null>;
export type CallerDenial = { ok: false; error: { code: string; message: string } };

export function deny(code: string, message: string): CallerDenial {
  return { ok: false, error: { code, message } };
}

/** The mirror/renderer resolution; an unavailable renderer (early boot, a reload) resolves nothing. */
export function defaultResolveCaller(getWindow: () => BrowserWindow | null): ResolveCaller {
  return async (ptyId: string) => {
    try {
      const workspaceId = await resolvePtyOwnerWorkspace(getWindow, ptyId);
      return workspaceId ? { workspaceId } : null;
    } catch {
      return null;
    }
  };
}

/** The calling pane's workspace for `method`, or why the call is refused (fail closed). */
export async function remoteTaskCaller(
  method: string,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
  resolveCaller: ResolveCaller,
): Promise<{ ok: true; workspaceId: string } | CallerDenial> {
  if (ctx?.origin !== 'local') return deny('NOT_AUTHORIZED', `${method} is local-origin only`);
  const senderPtyId = typeof params['senderPtyId'] === 'string' ? params['senderPtyId'].trim() : '';
  const caller = senderPtyId ? await resolveCaller(senderPtyId) : null;
  if (!caller) return deny('NOT_AUTHORIZED', `${method} requires a verifiable caller (no resolvable senderPtyId): run it from the pane that sent the task`);
  if (caller.workspaceId === HUMAN_WORKSPACE_ID) return deny('NOT_AUTHORIZED', `'${HUMAN_WORKSPACE_ID}' cannot answer from the pipe`);
  if (isHostedCaller(ctx) && hostedBindingOf(ctx) !== caller.workspaceId) {
    return deny('NOT_AUTHORIZED', `${method}: a hosted caller answers only from a pane of its own workspace`);
  }
  const claim = ctx.workspaceClaim;
  if (claim?.kind === 'stale') return deny('NOT_AUTHORIZED', `${method}: the workspace you claimed is gone`);
  for (const bound of [claim?.kind === 'bound' ? claim.workspaceId : undefined, ctx.commanderWorkspace]) {
    // The words the MCP server drops a stale identity on (src/mcp/index.ts isStaleIdentityResult).
    if (bound && bound !== caller.workspaceId) return deny('NOT_AUTHORIZED', `${method}: the calling pane is not owned by workspace ${bound}`);
  }
  return { ok: true, workspaceId: caller.workspaceId };
}
