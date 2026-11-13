import { agentLauncherStem, agentRow } from '../../shared/agentIdentity';
import { agentExecEnv } from '../../shared/execEnv';
import { captureProcessTree, recordedRootMatcher, type VerifiedTreeKillResult } from '../automation/verifiedTreeKill';
import { whichOnPath } from '../web/agentLaunch';
import { defaultHeadlessProcDeps, snapshotTree, stillHeld, type HeadlessProcDeps } from './headlessProcs';
import type { HeadlessSurvivor } from './headlessStartStore';
import type { HeadlessDestroyResult, HeadlessSessionPort } from './headlessStarter';

/**
 * The panes a headless remote start runs its agent in (headlessStarter.ts).
 *
 * The launcher is looked up on the PATH agents run with (the login shell's,
 * plus ~/.local/bin and the other per-user fallbacks) and the spawn is pinned
 * to it, as a phone-created pane's is (webPaneSpawn). Kept alive with no
 * client attached (remoteDurable). The agent's line is the spawn's only: what
 * is persisted, and what a recovery after a restart would run, is a line that
 * says the agent ended, so a restart never brings an agent back without its
 * task (headless reconcile then ends that session).
 *
 * index.ts hands in what opens and closes a pane; nothing here imports the
 * session machinery itself.
 */

export const HEADLESS_REPLAY_LINE = "echo 'wmux: this agent was started for another PC and ended when the daemon restarted.'";

export interface HeadlessPaneMeta {
  state: string;
  pid: number;
  pidStartTime?: string;
  pidStartKernel?: string;
  pidCreatedAtFt?: string;
}

export interface HeadlessSessionsDeps {
  /** The environment a pane created by the daemon gets (identity stamped, credentials and wmux internals left out). */
  paneEnv(sessionId: string, workspaceId: string): Record<string, string>;
  /** The daemon's createSession, with the line it spawns apart from the one it persists. */
  createSession(params: Record<string, unknown>, local: { execLaunchCommand: string; remoteDurable: true }): Promise<unknown>;
  /** The daemon's destroySession; with `killTree` it answers `{ tree }` or throws when the tree cannot be taken. */
  destroySession(params: { id: string; killTree?: true }): Promise<unknown>;
  /** A live session's meta. */
  meta(sessionId: string): HeadlessPaneMeta | undefined;
  platform?: NodeJS.Platform;
  /** The PATH agents are launched with, for this env (agentExecEnv). */
  agentPath?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  procs?: HeadlessProcDeps;
  /** How long to wait for a new session's start time (3 s). */
  startWaitMs?: number;
  /** Where a recorded start that does not match is reported. */
  warn?: (msg: string) => void;
}

const shellQuotable = (s: string): boolean => !/['\n\r\0]/.test(s);

export function createHeadlessSessions(deps: HeadlessSessionsDeps): HeadlessSessionPort {
  const platform = deps.platform ?? process.platform;
  const agentPath = deps.agentPath ?? (async (env: NodeJS.ProcessEnv) => (await agentExecEnv(env)).PATH);
  const procs = deps.procs ?? defaultHeadlessProcDeps;
  const startWaitMs = deps.startWaitMs ?? 3000;
  const running = (meta: HeadlessPaneMeta | undefined): meta is HeadlessPaneMeta => meta?.state === 'attached' || meta?.state === 'detached';
  /** A live session's recorded start time, waited for briefly (it is read right after the spawn). */
  const startTimeOf = async (id: string): Promise<string | undefined> => {
    for (let waited = 0; ; waited += 100) {
      const meta = deps.meta(id);
      if (!running(meta)) return undefined;
      const start = platform === 'win32' ? meta.pidCreatedAtFt : meta.pidStartTime;
      if (start || waited >= startWaitMs) return start;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return {
    resolveAgent: async (agent) => {
      const row = agentRow(agent);
      if (!row || platform === 'win32') return null;
      return (await whichOnPath(agentLauncherStem(row), (await agentPath(process.env)) ?? '')) ?? null;
    },
    create: async ({ sessionId, workspaceId, cwd, agentBin, command, env: extra }) => {
      const base = deps.paneEnv(sessionId, workspaceId);
      const pinned = (await agentPath(base)) ?? base.PATH ?? '';
      if (!shellQuotable(pinned) || !shellQuotable(agentBin)) throw new Error('the agent path cannot be quoted for the launch line');
      const space = command.indexOf(' ');
      const launch = `/usr/bin/env PATH='${pinned}' '${agentBin}'${space < 0 ? '' : command.slice(space)}`;
      await deps.createSession(
        { id: sessionId, exec: { command: HEADLESS_REPLAY_LINE }, cwd, env: { ...base, ...extra, PATH: pinned } },
        { execLaunchCommand: launch, remoteDurable: true },
      );
      // Its process, with the start time the daemon reads right after the spawn (waited for, so a
      // later tree kill is not refused and a later run can find it again).
      const rootStart = await startTimeOf(sessionId);
      const rootPid = deps.meta(sessionId)?.pid;
      // Recorded with the start time (DaemonSessionManager), never on Windows.
      const rootStartKernel = rootStart ? deps.meta(sessionId)?.pidStartKernel : undefined;
      return { ...(rootPid && rootPid > 1 ? { rootPid } : {}), ...(rootStart ? { rootStart } : {}), ...(rootStartKernel ? { rootStartKernel } : {}) };
    },
    alive: (id) => running(deps.meta(id)),
    destroy: async (id) => {
      // Any id: one recovery left on disk only is ended too (#2493). The agent's
      // tree when its root can be proven; what did not exit is reported, never
      // taken for gone.
      // A tree kill is refused while the session's start time is not read yet: wait for it (briefly).
      await startTimeOf(id);
      const rootPid = deps.meta(id)?.pid ?? 0;
      // The agent's tree as it is before the kill: what holds the start if the kill cannot be confirmed.
      const before = await snapshotTree(rootPid, procs);
      const held = (extra: HeadlessSurvivor[], why: string): HeadlessDestroyResult => ({
        ok: false,
        survivors: [...(before ?? [{ pid: rootPid, reason: why, unverified: true as const }]), ...extra.filter((s) => !before?.some((b) => b.pid === s.pid))],
      });
      let res: unknown;
      try {
        res = await deps.destroySession({ id, killTree: true });
      } catch (err) {
        // The tree cannot be proven (its root's start time is unknown): the pane alone is closed.
        await deps.destroySession({ id });
        return held([], `its process tree could not be checked: ${err instanceof Error ? err.message : String(err)}`);
      }
      const tree = (res as { tree?: VerifiedTreeKillResult } | undefined)?.tree;
      return tree && !tree.ok ? held(tree.survivors, 'did not exit') : { ok: true };
    },
    killEarlier: async (rootPid, rootStart, rootStartKernel) => {
      // Only the process recorded at its start: a pid that names another process now is left alone.
      const captured = await captureProcessTree(rootPid, { rootIsOurs: recordedRootMatcher(rootPid, rootStart, (msg) => deps.warn?.(`[headless] ${msg}`), rootStartKernel) });
      if (!captured) return { ok: true };
      const tree = await captured.kill();
      return tree.ok ? { ok: true } : { ok: false, survivors: tree.survivors };
    },
    stillRunning: (survivors, worktreePath) => stillHeld(survivors, worktreePath, procs),
  };
}
