// FanOutService port assembly — the ONE place the service is constructed.
//
// Two front doors now reach fan-out: the renderer IPC handler (fanout.handler,
// the GUI modal) and the pipe RPC handler (fanout.rpc, MCP clients). They MUST
// share one instance: the §2 G1 idempotency guarantee is an INSTANCE property
// (the key→result LRU and the in-flight set are instance fields), so a second
// instance means the same idempotency key is accepted twice and the fan-out
// runs twice — duplicate worktrees, duplicate workspaces, duplicate missions.
//
// The ports are the same two the service has always used: the daemon RPC port
// (task.mission.start/update/close, a2a.channel.invite) and the renderer spawn
// port (sendToRenderer('fanout.spawnWorkspace')).

import type { BrowserWindow } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import type { RpcMethod } from '../../shared/rpc';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { FanOutService } from './FanOutService';

type GetWindow = () => BrowserWindow | null;

/** Spawning can take seconds (PTY creation included), so the renderer spawn
 *  round-trip gets a generous deadline. */
const SPAWN_TIMEOUT_MS = 30000;

export function createFanOutService(
  getDaemonClient: () => DaemonClient | null,
  getWindow: GetWindow,
): FanOutService {
  return new FanOutService({
    daemon: {
      rpc: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        const dc = getDaemonClient();
        if (!dc) throw new Error('Daemon not connected');
        return dc.rpc(method as RpcMethod, params);
      },
    },
    renderer: {
      spawnWorkspace: async (p) => {
        const res = (await sendToRenderer(getWindow, 'fanout.spawnWorkspace', p, {
          timeoutMs: SPAWN_TIMEOUT_MS,
        })) as { workspaceId?: string; ptyId?: string; error?: string };
        if (res && typeof res.error === 'string') return { error: res.error };
        if (res && typeof res.workspaceId === 'string') {
          return { workspaceId: res.workspaceId, ...(res.ptyId ? { ptyId: res.ptyId } : {}) };
        }
        return { error: 'fanout.spawnWorkspace: renderer returned no workspaceId' };
      },
    },
  });
}
