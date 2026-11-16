// ─── a2a.remote.answer — answer the question a worker on another PC shows ──
//
// The agent that sent a task to another PC (CLI `wmux remote answer`) types
// one of the choices of the one-question picker that task's worker shows
// there. Identity is server-resolved, never taken from params: the caller's
// senderPtyId resolves to its workspace, and the daemon then accepts the
// answer only from the task's local party (the same check as a reply). A
// hosted caller (a plugin) answers only from a pane of its bound workspace.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { hostedBindingOf, isHostedCaller, type RpcContext } from '../../../shared/rpc';
import { A2A_ANSWER_RPC } from '../../../shared/a2aRemote';
import { HUMAN_WORKSPACE_ID } from '../../../shared/channels';
import type { DaemonClient } from '../../DaemonClient';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';

type GetWindow = () => BrowserWindow | null;

export interface RemoteAnswerRpcDeps {
  getDaemonClient: () => Pick<DaemonClient, 'isConnected' | 'a2aRemoteAnswer'> | null;
  /** Injected in tests; default the mirror/renderer resolution. */
  resolveCaller?: (senderPtyId: string) => Promise<{ workspaceId: string } | null>;
}

function deny(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function registerRemoteAnswerRpc(router: RpcRouter, getWindow: GetWindow, deps: RemoteAnswerRpcDeps): void {
  const resolveCaller = deps.resolveCaller ?? (async (ptyId: string) => {
    try {
      const workspaceId = await resolvePtyOwnerWorkspace(getWindow, ptyId);
      return workspaceId ? { workspaceId } : null;
    } catch {
      // Renderer unavailable (early boot / reload): unresolvable, fail closed.
      return null;
    }
  });

  router.register(A2A_ANSWER_RPC.ask, async (params, ctx?: RpcContext) => {
    if (ctx?.origin !== 'local') return deny('NOT_AUTHORIZED', `${A2A_ANSWER_RPC.ask} is local-origin only`);
    const senderPtyId = str(params['senderPtyId']);
    const caller = senderPtyId ? await resolveCaller(senderPtyId) : null;
    if (!caller) return deny('NOT_AUTHORIZED', `${A2A_ANSWER_RPC.ask} requires a verifiable caller (no resolvable senderPtyId): run it from the pane that sent the task`);
    if (caller.workspaceId === HUMAN_WORKSPACE_ID) return deny('NOT_AUTHORIZED', `'${HUMAN_WORKSPACE_ID}' cannot answer from the pipe`);
    // A plugin bound to one workspace never answers for a pane of another; unbound, it answers for none.
    if (isHostedCaller(ctx) && hostedBindingOf(ctx) !== caller.workspaceId) {
      return deny('NOT_AUTHORIZED', `${A2A_ANSWER_RPC.ask}: a hosted caller answers only from a pane of its own workspace`);
    }
    const taskId = str(params['taskId']);
    const pickerId = str(params['pickerId']);
    const option = params['option'];
    if (!taskId || !pickerId || typeof option !== 'number') return deny('INVALID_ARGUMENT', 'taskId, pickerId and option are required');
    const dc = deps.getDaemonClient();
    if (!dc?.isConnected) return deny('UNAVAILABLE', 'the background service is not connected');
    return dc.a2aRemoteAnswer({ taskId, workspaceId: caller.workspaceId, pickerId, option });
  });
}
