// ─── a2a.remote.approve — allow or deny a prompt a worker on another PC shows ─
//
// The agent that sent a task to another PC (MCP `remote_approve`, CLI `wmux
// remote approve`) allows or denies the permission prompt that task's worker
// shows there. Identity is server-resolved, never taken from params: the
// caller's senderPtyId resolves to its workspace, and the daemon then sends
// only for the task's local party, only a decision the task's latest status
// offers, and at most A2A_APPROVALS_SENT_PER_WINDOW per PC. A hosted caller
// (a plugin) answers only from a pane of its bound workspace.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { A2A_APPROVAL_RPC, A2A_REMOTE_PROMPT_ID_RE, type A2aApprovalSendResult } from '../../../shared/a2aRemote';
import type { DaemonClient } from '../../DaemonClient';
import { defaultResolveCaller, deny, remoteTaskCaller, type ResolveCaller } from './remoteTaskCaller';

type GetWindow = () => BrowserWindow | null;

export interface RemoteApprovalRpcDeps {
  getDaemonClient: () => Pick<DaemonClient, 'isConnected' | 'a2aRemoteApprove'> | null;
  /** Injected in tests; default the mirror/renderer resolution. */
  resolveCaller?: ResolveCaller;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The arguments as the daemon takes them, or why they are not: a task id, a
 * prompt id (16 hex characters) and `allow` or `deny`.
 */
export function approveArgs(params: Record<string, unknown>): { taskId: string; promptId: string; decision: 'allow' | 'deny' } | string {
  const taskId = str(params['taskId']);
  const promptId = str(params['promptId']);
  const decision = params['decision'];
  if (!taskId || !promptId) return 'taskId, promptId and decision are required';
  if (!A2A_REMOTE_PROMPT_ID_RE.test(promptId)) return 'promptId is 16 hex characters: detail.approval.promptId in the task\'s status';
  if (decision !== 'allow' && decision !== 'deny') return "decision must be 'allow' or 'deny'";
  return { taskId, promptId, decision };
}

export function registerRemoteApprovalRpc(router: RpcRouter, getWindow: GetWindow, deps: RemoteApprovalRpcDeps): void {
  const resolveCaller = deps.resolveCaller ?? defaultResolveCaller(getWindow);

  router.register(A2A_APPROVAL_RPC.ask, async (params, ctx?: RpcContext) => {
    const caller = await remoteTaskCaller(A2A_APPROVAL_RPC.ask, params, ctx, resolveCaller);
    if (!caller.ok) return caller;
    const args = approveArgs(params);
    if (typeof args === 'string') return deny('INVALID_ARGUMENT', args);
    const dc = deps.getDaemonClient();
    if (!dc?.isConnected) return deny('UNAVAILABLE', 'the background service is not connected');
    const result: A2aApprovalSendResult = await dc.a2aRemoteApprove({ ...args, workspaceId: caller.workspaceId });
    return result;
  });
}
