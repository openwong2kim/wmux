// FanOutService port assembly — the ONE place the service is constructed.
//
// Two front doors now reach fan-out: the renderer IPC handler (fanout.handler,
// the GUI modal) and the pipe RPC handler (fanout.rpc, MCP clients). They MUST
// share one instance. Two pieces of state break when duplicated:
//
//   - the §2 G1 idempotency LRU (key → result) and the in-flight set, which are
//     instance fields — a second instance accepts the same key twice and the
//     fan-out runs twice (duplicate worktrees, workspaces, missions);
//   - the TaskWorktreeManager serial queue, which is what keeps two concurrent
//     `git worktree add` calls off the same repository.
//
// The ports are the same two the service has always used: the daemon RPC port
// (task.mission.start/update/close, a2a.channel.invite) and the renderer spawn
// port (sendToRenderer('fanout.spawnWorkspace')).

import type { BrowserWindow } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import type { RpcMethod } from '../../shared/rpc';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { getProjectConfigStore } from '../project/ProjectConfigStore';
import { FanOutService } from './FanOutService';

type GetWindow = () => BrowserWindow | null;

/** 스폰은 몇 초 걸릴 수 있으니 렌더러 spawn 타임아웃을 넉넉히(PTY 생성 포함). */
const SPAWN_TIMEOUT_MS = 30000;

/** A-1 — a first-run screen is a whole boxed dialog; a short tail would cut its
 *  headline off and the detector would never match. */
const FIRST_RUN_READ_LINES = 40;

/** A viewport we cannot get quickly is a poll we skip, not a spawn we stall. */
const FIRST_RUN_READ_TIMEOUT_MS = 1_000;

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
        })) as { workspaceId?: string; ptyId?: string; initialCommand?: string; error?: string };
        if (res && typeof res.error === 'string') return { error: res.error };
        if (res && typeof res.workspaceId === 'string') {
          return {
            workspaceId: res.workspaceId,
            ...(res.ptyId ? { ptyId: res.ptyId } : {}),
            // The post-role-binding command (see FanOutRendererPort).
            ...(typeof res.initialCommand === 'string' && res.initialCommand
              ? { initialCommand: res.initialCommand }
              : {}),
          };
        }
        return { error: 'fanout.spawnWorkspace: renderer returned no workspaceId' };
      },
    },
    // T2 — the per-project wmux.json reader. The SAME store instance the
    // supervised-pane funnel uses, so a fan-out setup hook is gated by exactly
    // the trust decision the user already made for this repo.
    project: {
      getState: (cwd: string) => getProjectConfigStore().getState(cwd),
    },
    // A-1 — viewport + keystroke for the first-run watch. The viewport is the
    // renderer's (the same read every other main-side screen check uses); the
    // keystroke goes through the daemon, which owns the session. With no daemon
    // there is no way to press, and the watch reports `stuck` rather than
    // pretending it dismissed anything.
    firstRun: {
      readScreen: async (ptyId: string): Promise<string> => {
        const res = (await sendToRenderer(
          getWindow,
          'input.readScreen',
          { ptyId, tail_lines: FIRST_RUN_READ_LINES, timeoutMs: FIRST_RUN_READ_TIMEOUT_MS },
          { timeoutMs: FIRST_RUN_READ_TIMEOUT_MS },
        )) as { text?: unknown } | null;
        const text = res && typeof res === 'object' ? res.text : undefined;
        return typeof text === 'string' ? text : '';
      },
      sendKey: async (ptyId: string, sequence: string): Promise<void> => {
        const dc = getDaemonClient();
        if (!dc?.isConnected) throw new Error('daemon not connected');
        dc.writeToSession(ptyId, sequence);
      },
    },
  });
}
