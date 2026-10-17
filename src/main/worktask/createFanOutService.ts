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
import { WSL_RPC_TIMEOUT_MS } from '../../shared/wsl';
import { FanOutService } from './FanOutService';
import { createDaemonLaunchProbe } from './fanoutLaunchProbe';
import { createWorkerTempDir, getWorkerTempDirSweeper, removeWorkerTempDir } from './fanoutTempDir';

type GetWindow = () => BrowserWindow | null;

/** How long a task's spawn may take before the fan-out gives up on it. F26 —
 *  it covers pty:create's own WSL budget (WSL_RPC_TIMEOUT_MS, a 60 s cwd probe
 *  that a burst of WSL workers starting up slows down) plus the attach after
 *  it. The old 30 s gave up on WSL spawns that were still in progress. */
export const SPAWN_TIMEOUT_MS = WSL_RPC_TIMEOUT_MS + 30_000;

/** How long a reply that arrives after the give-up is still listened for. */
const SPAWN_LATE_REPLY_MS = 10 * 60_000;

/**
 * The renderer's `fanout.spawnWorkspace`, given up on after `giveUpMs`. The
 * fan-out then reports the task as not started and closes its mission, so a
 * workspace the renderer still brings up afterwards would be a live, stamped
 * pane no task or caller knows about (it holds a live-cap slot and its agent
 * runs). It is closed as soon as its late reply lands. A late failure needs
 * nothing: the renderer has already rolled its workspace back.
 */
export function spawnTaskWorkspace(
  getWindow: GetWindow,
  params: Record<string, unknown>,
  opts: { send?: typeof sendToRenderer; giveUpMs?: number; lateReplyMs?: number } = {},
): Promise<unknown> {
  const send = opts.send ?? sendToRenderer;
  const giveUpMs = opts.giveUpMs ?? SPAWN_TIMEOUT_MS;
  const reply = send(getWindow, 'fanout.spawnWorkspace', params, {
    timeoutMs: giveUpMs + (opts.lateReplyMs ?? SPAWN_LATE_REPLY_MS),
  });
  return new Promise((resolve, reject) => {
    let gaveUp = false;
    const timer = setTimeout(() => {
      gaveUp = true;
      reject(new Error(`RPC timeout: fanout.spawnWorkspace (${giveUpMs}ms)`));
    }, giveUpMs);
    reply.then(
      (res) => {
        if (!gaveUp) {
          clearTimeout(timer);
          resolve(res);
          return;
        }
        const late = (res as { workspaceId?: unknown } | null)?.workspaceId;
        if (typeof late !== 'string' || !late) return;
        console.warn(`[fanout] closing workspace ${late}: its spawn finished after the fan-out gave up on it`);
        send(getWindow, 'workspace.close', { id: late, force: true }).then(
          (closed) => {
            const error = (closed as { error?: unknown } | null)?.error;
            if (typeof error === 'string') console.warn(`[fanout] late workspace ${late} not closed: ${error}`);
          },
          (err: unknown) => console.warn(`[fanout] late workspace ${late} not closed: ${String(err)}`),
        );
      },
      (err: unknown) => {
        if (gaveUp) return;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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
        const res = (await spawnTaskWorkspace(getWindow, p)) as {
          workspaceId?: string;
          ptyId?: string;
          initialCommand?: string;
          error?: string;
        };
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
    // #1919 — did the worker's agent actually start? `false` only on the
    // daemon's positive evidence of absence (see fanoutLaunchProbe.ts).
    launchProbe: createDaemonLaunchProbe(getDaemonClient),
    // Private TMPDIR per worker, removed once its task workspace is gone
    // (see fanoutTempDir.ts for the reconcile).
    workerTempDirs: {
      create: () => createWorkerTempDir(),
      register: (owner: string, dir: string) => getWorkerTempDirSweeper().register(owner, dir),
      remove: (dir: string) => {
        void removeWorkerTempDir(dir);
      },
    },
    // A bot's worker starts with the bot's approved skills in its worktree.
    botSkills: async (botId: string, worktreePath: string) => {
      const { installBotSkillsInWorktree } = await import('../pipe/handlers/skill.rpc');
      await installBotSkillsInWorktree(botId, worktreePath);
    },
  });
}
