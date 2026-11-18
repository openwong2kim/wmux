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
import type { RpcContext } from '../../../shared/rpc';
import { A2A_ANSWER_RPC } from '../../../shared/a2aRemote';
import type { DaemonClient } from '../../DaemonClient';
import { defaultResolveCaller, deny, remoteTaskCaller, type ResolveCaller } from './remoteTaskCaller';

type GetWindow = () => BrowserWindow | null;

export interface RemoteAnswerRpcDeps {
  getDaemonClient: () => Pick<DaemonClient, 'isConnected' | 'a2aRemoteAnswer'> | null;
  /** Injected in tests; default the mirror/renderer resolution. */
  resolveCaller?: ResolveCaller;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function registerRemoteAnswerRpc(router: RpcRouter, getWindow: GetWindow, deps: RemoteAnswerRpcDeps): void {
  const resolveCaller = deps.resolveCaller ?? defaultResolveCaller(getWindow);

  router.register(A2A_ANSWER_RPC.ask, async (params, ctx?: RpcContext) => {
    const caller = await remoteTaskCaller(A2A_ANSWER_RPC.ask, params, ctx, resolveCaller);
    if (!caller.ok) return caller;
    const taskId = str(params['taskId']);
    const pickerId = str(params['pickerId']);
    const option = params['option'];
    if (!taskId || !pickerId || typeof option !== 'number') return deny('INVALID_ARGUMENT', 'taskId, pickerId and option are required');
    const dc = deps.getDaemonClient();
    if (!dc?.isConnected) return deny('UNAVAILABLE', 'the background service is not connected');
    return dc.a2aRemoteAnswer({ taskId, workspaceId: caller.workspaceId, pickerId, option });
  });
}
