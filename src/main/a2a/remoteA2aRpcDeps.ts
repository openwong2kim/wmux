import { A2A_REMOTE_RPC, type A2aRemoteTarget } from '../../shared/a2aRemoteDelivery';
import type { RemoteA2aRpcDeps } from '../pipe/handlers/a2a.rpc';

/**
 * The cross-host hooks of the a2a pipe handlers, backed by daemon RPCs
 * (`A2A_REMOTE_RPC`). No daemon: no targets (every alias takes the local
 * path), and every operation answers `unavailable`.
 */
export function daemonRemoteA2aRpcDeps(
  getDaemonClient: () => { rpc: (method: string, params: Record<string, unknown>) => Promise<unknown> } | null,
): RemoteA2aRpcDeps {
  const op = async (method: string, params: object): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> => {
    const dc = getDaemonClient();
    if (!dc) return { ok: false, error: 'unavailable' };
    const res = await dc.rpc(method, { ...params });
    if (isRecord(res) && res.ok === true && typeof res.taskId === 'string') return { ok: true, taskId: res.taskId };
    return { ok: false, error: isRecord(res) && typeof res.error === 'string' ? res.error : 'unavailable' };
  };
  return {
    listTargets: async () => {
      const dc = getDaemonClient();
      if (!dc) return [];
      const res = await dc.rpc(A2A_REMOTE_RPC.targets, {});
      return isRecord(res) && Array.isArray(res.targets) ? (res.targets as A2aRemoteTarget[]) : [];
    },
    sendTask: (input) => op(A2A_REMOTE_RPC.sendTask, input),
    reply: (input) => op(A2A_REMOTE_RPC.reply, input),
    state: (input) => op(A2A_REMOTE_RPC.state, input),
    read: async (input) => getDaemonClient()?.rpc(A2A_REMOTE_RPC.read, { ...input }),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
