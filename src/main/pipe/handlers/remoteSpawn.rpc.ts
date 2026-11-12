// ─── a2a.remote.spawn / a2a.remote.spawnStatus — ask another PC for an agent ──
//
// An agent pane (MCP `remote_spawn`, CLI `wmux remote spawn`) asks a paired
// PC to start an agent there; the replies come back to the caller's own pane
// over the link that start makes. Identity is server-resolved, never taken
// from params: the caller's senderPtyId resolves to its workspace and pane.
//
// Refused here: a remote caller, a caller with no pane (a brain or a bot: the
// reply end is a pane in this version), and a caller whose workspace is a
// fan-out task or was started by another PC (depth 1). Depth 1 damps loops;
// it is not a boundary (an unstamped pane of the same user can ask). What
// stops a chain of PCs is each PC's own opt-in and card.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { A2A_SPAWN_PIPE_RPC, REMOTE_SPAWN_LINEAGE_PREFIX } from '../../../shared/a2aSpawn';
import { isAgentSlug } from '../../../shared/agentIdentity';
import { HUMAN_WORKSPACE_ID } from '../../../shared/channels';
import type { DaemonClient } from '../../DaemonClient';
import { getFanOutGuards, lineageDepth, type FanOutGuards } from '../../worktask/fanoutGuards';
import { loadFanoutDepth } from '../../worktask/fanoutWorkerPolicy';
import { resolvePaneForPty, resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';

type GetWindow = () => BrowserWindow | null;

export interface RemoteSpawnRpcDeps {
  getDaemonClient: () => Pick<DaemonClient, 'isConnected' | 'a2aSpawnAsk' | 'a2aSpawnOutgoing'> | null;
  /** Injected in tests; default the fan-out lineage store. */
  guards?: Pick<FanOutGuards, 'fanoutOwnerOf'>;
  /** Injected in tests; default the mirror/renderer resolution. */
  resolveCaller?: (senderPtyId: string) => Promise<{ workspaceId: string; paneId: string } | null>;
}

function deny(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function registerRemoteSpawnRpc(router: RpcRouter, getWindow: GetWindow, deps: RemoteSpawnRpcDeps): void {
  const resolveCaller = deps.resolveCaller ?? (async (ptyId: string) => {
    try {
      const workspaceId = await resolvePtyOwnerWorkspace(getWindow, ptyId);
      if (!workspaceId) return null;
      const paneId = await resolvePaneForPty(getWindow, ptyId, workspaceId);
      return paneId ? { workspaceId, paneId } : null;
    } catch {
      // Renderer unavailable (early boot / reload): unresolvable, fail closed.
      return null;
    }
  });

  router.register(A2A_SPAWN_PIPE_RPC.spawn, async (params, ctx?: RpcContext) => {
    if (ctx?.origin !== 'local') return deny('NOT_AUTHORIZED', `${A2A_SPAWN_PIPE_RPC.spawn} is local-origin only`);
    if (ctx.commanderWorkspace || ctx.bot) {
      return deny('NOT_AUTHORIZED', 'the replies of an agent another PC starts go to a pane, so only an agent in a pane can ask');
    }
    const senderPtyId = str(params['senderPtyId']);
    const caller = senderPtyId ? await resolveCaller(senderPtyId) : null;
    if (!caller) return deny('NOT_AUTHORIZED', `${A2A_SPAWN_PIPE_RPC.spawn} requires a verifiable caller (no resolvable senderPtyId)`);
    if (caller.workspaceId === HUMAN_WORKSPACE_ID) return deny('NOT_AUTHORIZED', `'${HUMAN_WORKSPACE_ID}' cannot ask from the pipe`);
    // Depth: a fan-out task, or an agent another PC started, asks for more only
    // as deep as the fan-out depth setting allows (default 1: not at all).
    let owner: string | null;
    let depth = 0;
    try {
      const guards = deps.guards ?? getFanOutGuards();
      owner = guards.fanoutOwnerOf(caller.workspaceId);
      if (owner !== null) depth = lineageDepth((ws) => guards.fanoutOwnerOf(ws), caller.workspaceId);
    } catch (err) {
      return deny('FAILED_PRECONDITION', `the fan-out lineage store could not be read, so it cannot rule out that the caller was itself started for someone (${(err as Error).message})`);
    }
    if (owner !== null && depth >= loadFanoutDepth()) {
      const by = owner.startsWith(REMOTE_SPAWN_LINEAGE_PREFIX) ? 'another PC' : owner;
      return deny('NOT_AUTHORIZED', `workspace ${caller.workspaceId} was started by ${by}, and an agent started for someone asks another PC to start one only as deep as the fan-out depth setting allows (Settings › Roles & fan-out)`);
    }
    const agent = str(params['agent']);
    const root = str(params['root']);
    const prompt = typeof params['prompt'] === 'string' ? params['prompt'] : '';
    const expires = params['expiresInHours'];
    if (!str(params['pc']) || !isAgentSlug(agent) || !root || !prompt.trim() || (expires !== undefined && typeof expires !== 'number')) {
      return deny('INVALID_ARGUMENT', 'pc, agent, root and prompt are required (sub and expiresInHours are optional)');
    }
    const dc = deps.getDaemonClient();
    if (!dc?.isConnected) return deny('UNAVAILABLE', 'the background service is not connected');
    const sub = str(params['sub']);
    return dc.a2aSpawnAsk({
      pc: str(params['pc']),
      agent,
      folder: { root, ...(sub ? { sub } : {}) },
      text: prompt,
      ...(typeof expires === 'number' ? { expiresInHours: expires } : {}),
      from: { kind: 'pane', workspaceId: caller.workspaceId, paneId: caller.paneId },
      // The hourly limit is per pane: a new pty in the same pane counts with the old one.
      callerKey: caller.paneId,
    });
  });

  router.register(A2A_SPAWN_PIPE_RPC.status, async (params, ctx?: RpcContext) => {
    if (ctx?.origin !== 'local') return deny('NOT_AUTHORIZED', `${A2A_SPAWN_PIPE_RPC.status} is local-origin only`);
    const dc = deps.getDaemonClient();
    if (!dc?.isConnected) return deny('UNAVAILABLE', 'the background service is not connected');
    const spawnId = str(params['spawnId']);
    return dc.a2aSpawnOutgoing(spawnId || undefined);
  });
}
