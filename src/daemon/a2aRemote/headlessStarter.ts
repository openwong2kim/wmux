import crypto from 'node:crypto';
import { agentLauncherStem, agentRow, type AgentSlug } from '../../shared/agentIdentity';
import { firstRunEnvForAgent } from '../../shared/agentFirstRun';
import type { HostId, A2aLinkRecordV1 } from '../../shared/a2aRemote';
import { REMOTE_SPAWN_LINEAGE_PREFIX, type A2aSpawnClaimResult, type A2aSpawnStepResult } from '../../shared/a2aSpawn';
import { workerLaunchFlags } from '../../shared/workerLaunch';
import type { SpawnWorktreeInput, SpawnWorktreeResult } from '../../main/a2aRemote/spawnWorktree';
import type { HeadlessStartRecordV1, HeadlessStartStore } from './headlessStartStore';
import type { SpawnRequestRecordV1 } from './spawnRequestStore';
import { errMsg } from './storeFile';

/**
 * Remote spawn on a host with no desktop app (headless mode, see
 * headlessMode.ts): the daemon starts the agent itself, where main's
 * remoteSpawnCoordinator does it on a desktop.
 *
 * A request a rule approved is started like this, each step only after the
 * one before it is written down (`headless-starts.json`):
 *   1. claim it (the receiver checks everything again; one claimer wins);
 *   2. record the start: the session id it will use, the PC it is for (the
 *      lineage: an agent started remotely does not fan out again; its launch
 *      denies the tools that would);
 *   3. make the worktree (createSpawnWorktree, as main does);
 *   4. create the session: `<agent> --session-id <uuid>` with the worker
 *      permission flags (workerLaunchFlags), never the prompt: the prompt is
 *      the link's first task, typed in once the agent is ready;
 *   5. report `started` with the ids of that session.
 * Anything that fails takes back what this start made and answers `failed`.
 *
 * `reconcile` (at boot, periodically, on a link or session ending, and when
 * the app attaches) settles every record:
 *   - a start that never got to `started`: its session and worktree go;
 *   - a started one stays only while headless mode is on, its session runs
 *     in this daemon run, and its link lives (or is still being made);
 *     otherwise its session is ended, its link broken (that PC is told), and
 *     the record kept as `ended` with its worktree and branch (the agent's
 *     work is never deleted here).
 *
 * The pane functions come in as `sessions` (index.ts): this file does not
 * reach a PTY on its own.
 */

/** What starting a session takes; the line holds the launcher and flags, never a prompt. */
export interface HeadlessSessionInput {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  /** The launcher, as `resolveAgent` found it. */
  agentBin: string;
  /** `<launcher stem> --session-id <uuid> <worker flags>`. */
  command: string;
  env: Record<string, string>;
}

export interface HeadlessSessionPort {
  /** The agent's launcher on the PATH the daemon runs agents with; null when it is not there. */
  resolveAgent(agent: AgentSlug): Promise<string | null>;
  create(input: HeadlessSessionInput): Promise<void>;
  /** The session exists and its process runs. */
  alive(sessionId: string): boolean;
  /** End the session and its process tree; nothing when it is gone already. */
  destroy(sessionId: string): Promise<void>;
}

export interface HeadlessStarterDeps {
  mode: { active(): boolean };
  receiver: {
    claim(hostId: HostId, spawnId: string): Promise<A2aSpawnClaimResult>;
    started(hostId: HostId, spawnId: string, end: { workspaceId: string; paneId: string }): Promise<A2aSpawnStepResult>;
    failed(hostId: HostId, spawnId: string, code: 'folder-not-allowed' | 'failed'): A2aSpawnStepResult;
  };
  requests: { get(hostId: HostId, spawnId: string): SpawnRequestRecordV1 | undefined };
  links: { get(linkId: string): A2aLinkRecordV1 | undefined };
  /** The link is stored `started` and still being made (spawn-links.json `committed`). */
  activationOwed(linkId: string): boolean;
  starts: Pick<HeadlessStartStore, 'get' | 'list' | 'bySession' | 'add' | 'update' | 'remove'>;
  /** Null until the daemon's session RPCs exist. */
  sessions: () => HeadlessSessionPort | null;
  worktrees: {
    create(input: SpawnWorktreeInput): Promise<SpawnWorktreeResult>;
    remove(input: { repoPath: string; spawnId: string }): Promise<void>;
  };
  /** The pane of a link is gone: its live links break and their PCs are told. */
  paneGone(workspaceId: string, paneId: string): Promise<void>;
  /** End whatever link a start of `spawnId` made or still owes (spawnStarter.abandon). */
  abandon(hostId: HostId, spawnId: string): void;
  /** This daemon run (a restart ends every agent the run before had). */
  runId: string;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  now?: () => number;
  retryMs?: number;
}

export const HEADLESS_START_RETRY_MS = 10_000;
const TERMINAL_LINK: ReadonlySet<string> = new Set(['revoked', 'broken']);

export class A2aHeadlessStarter {
  private readonly deps: HeadlessStarterDeps;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private settling: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(deps: HeadlessStarterDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** A request was approved (by a rule): start it, if headless mode is on. */
  start(hostId: HostId, spawnId: string): Promise<void> {
    const k = `${hostId}:${spawnId}`;
    if (this.stopped || this.inFlight.has(k) || this.timers.has(k) || !this.deps.mode.active()) return Promise.resolve();
    if (!this.deps.sessions()) {
      this.retryLater(k, hostId, spawnId, 'the session service is not up yet');
      return Promise.resolve();
    }
    this.inFlight.add(k);
    return this.startNow(hostId, spawnId).catch((err: unknown) => {
      this.deps.log('error', `[headless] spawn ${spawnId} from ${hostId}: ${errMsg(err)}`);
    }).finally(() => this.inFlight.delete(k));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Any link changed: a start whose link ended loses its session. */
  onLinkTransition(link: A2aLinkRecordV1): void {
    if (TERMINAL_LINK.has(link.state) && this.deps.starts.list().some((r) => r.linkId === link.linkId && r.phase === 'started')) void this.reconcile();
  }

  /** A session died or was closed: the start it ran ends (its link breaks). */
  onSessionGone(sessionId: string): void {
    const rec = this.deps.starts.bySession(sessionId);
    if (rec && rec.phase !== 'ended') void this.reconcile();
  }

  /** Settle every record (see the file comment). Runs one at a time. */
  reconcile(): Promise<void> {
    const run = this.settling.then(() => this.reconcileNow());
    this.settling = run.catch(() => undefined);
    return run;
  }

  private async reconcileNow(): Promise<void> {
    for (const rec of this.deps.starts.list()) {
      if (this.inFlight.has(`${rec.hostId}:${rec.spawnId}`)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- one start at a time
        await this.settle(rec);
      } catch (err) {
        this.deps.log('warn', `[headless] spawn ${rec.spawnId}: not settled yet, trying again later: ${errMsg(err)}`);
      }
    }
  }

  private async settle(rec: HeadlessStartRecordV1): Promise<void> {
    const sessions = this.deps.sessions();
    if (rec.phase === 'ended') {
      if (sessions?.alive(rec.sessionId)) await sessions.destroy(rec.sessionId);
      return;
    }
    const req = this.deps.requests.get(rec.hostId, rec.spawnId);
    const stored = req?.state === 'decided' && req.code === 'started';
    if (rec.phase !== 'started' && !stored) {
      // Never reported started: nothing of it may stay.
      if (!sessions) return;
      await this.takeBack(rec, sessions, 'it did not finish');
      if (req && (req.state === 'starting' || req.state === 'approved')) this.deps.receiver.failed(rec.hostId, rec.spawnId, 'failed');
      return;
    }
    const linkId = rec.linkId ?? req?.linkId;
    if (rec.phase !== 'started') this.deps.starts.update(rec.hostId, rec.spawnId, { phase: 'started', ...(linkId ? { linkId } : {}) });
    const link = linkId ? this.deps.links.get(linkId) : undefined;
    // A link that is gone (a PC removed with its links) ends the start too, unless it is still being made.
    const linkEnded = link ? TERMINAL_LINK.has(link.state) : !(linkId && this.deps.activationOwed(linkId));
    const sessionLive = rec.runId === this.deps.runId && sessions?.alive(rec.sessionId) === true;
    if (this.deps.mode.active() && sessionLive && !linkEnded) return;
    // Nothing can be ended before the session service is up: the next reconcile does it.
    if (!sessions) return;
    await this.end(rec, link, sessions);
  }

  /** A started start whose agent may no longer count: session ended, link broken, record kept as `ended`. */
  private async end(rec: HeadlessStartRecordV1, link: A2aLinkRecordV1 | undefined, sessions: HeadlessSessionPort): Promise<void> {
    // Whether or not it looks alive: a session recovery brought back (even on disk only) goes too.
    await sessions.destroy(rec.sessionId);
    if (link && !TERMINAL_LINK.has(link.state)) await this.deps.paneGone(rec.workspaceId, rec.sessionId);
    // A link still owed is never made for it.
    this.deps.abandon(rec.hostId, rec.spawnId);
    this.deps.starts.update(rec.hostId, rec.spawnId, { phase: 'ended', endedAt: new Date(this.now()).toISOString() });
    this.deps.log('info', `[headless] spawn ${rec.spawnId} from ${rec.hostId}: ended; worktree kept at ${rec.worktreePath ?? '(none)'}`);
  }

  /** Session and worktree of a start that did not finish go, then its record. A step that fails keeps the record (tried again). */
  private async takeBack(rec: HeadlessStartRecordV1, sessions: HeadlessSessionPort, why: string): Promise<void> {
    this.deps.log('warn', `[headless] spawn ${rec.spawnId} from ${rec.hostId}: taken back (${why})`);
    await sessions.destroy(rec.sessionId);
    await this.deps.worktrees.remove({ repoPath: rec.repoPath, spawnId: rec.spawnId });
    this.deps.starts.remove(rec.hostId, rec.spawnId);
  }

  private retryLater(k: string, hostId: HostId, spawnId: string, why: string): void {
    if (this.stopped || this.timers.has(k)) return;
    this.deps.log('info', `[headless] spawn ${spawnId} from ${hostId}: not started now, trying again: ${why}`);
    const t = setTimeout(() => {
      this.timers.delete(k);
      void this.start(hostId, spawnId);
    }, this.deps.retryMs ?? HEADLESS_START_RETRY_MS);
    t.unref?.();
    this.timers.set(k, t);
  }

  private async startNow(hostId: HostId, spawnId: string): Promise<void> {
    const k = `${hostId}:${spawnId}`;
    let claimed: A2aSpawnClaimResult;
    try {
      claimed = await this.deps.receiver.claim(hostId, spawnId);
    } catch (err) {
      this.retryLater(k, hostId, spawnId, errMsg(err));
      return;
    }
    if (!claimed.ok) {
      // Refused (the asker was answered), or not checkable now.
      if (!claimed.code) this.retryLater(k, hostId, spawnId, claimed.error);
      return;
    }
    const { claim } = claimed;
    const refuse = (why: string): void => {
      this.deps.log('warn', `[headless] spawn ${spawnId} from ${hostId}: not started: ${why}`);
      this.deps.receiver.failed(hostId, spawnId, 'failed');
    };
    // Claude Code only in this version; `manual` needs a person at the pane.
    if (claim.agent !== 'claude') return refuse(`${claim.agent} is not started on a host without the app`);
    if (claim.permissionMode === 'manual') return refuse('the manual permission mode needs a person at the pane');
    const row = agentRow(claim.agent);
    if (!row) return refuse(`unknown agent ${claim.agent}`);
    const stem = agentLauncherStem(row);
    const sessions = this.deps.sessions();
    if (!sessions) return refuse('the session service is not up');
    const agentBin = await sessions.resolveAgent(claim.agent).catch(() => null);
    if (!agentBin) return refuse(`${stem} was not found on the login PATH or in ~/.local/bin of the account the daemon runs as`);
    if (!this.deps.mode.active()) return refuse('headless mode was turned off');

    const rec: HeadlessStartRecordV1 = {
      v: 1, hostId, spawnId, agent: claim.agent, repoPath: claim.repoPath,
      sessionId: `hl-${crypto.randomUUID()}`,
      workspaceId: `hl-${spawnId.slice(3)}`,
      agentSessionId: crypto.randomUUID(),
      lineage: `${REMOTE_SPAWN_LINEAGE_PREFIX}${hostId}`,
      runId: this.deps.runId,
      phase: 'prepared',
      startedAt: new Date(this.now()).toISOString(),
    };
    try {
      this.deps.starts.add(rec);
    } catch (err) {
      return refuse(`the start was not recorded: ${errMsg(err)}`);
    }
    const undo = async (code: 'folder-not-allowed' | 'failed', why: string): Promise<void> => {
      this.deps.log('warn', `[headless] spawn ${spawnId} from ${hostId}: not started (${code}): ${why}`);
      try {
        await this.takeBack(rec, sessions, why);
      } catch (err) {
        this.deps.log('warn', `[headless] spawn ${spawnId}: left for the next reconcile: ${errMsg(err)}`);
      }
      this.deps.receiver.failed(hostId, spawnId, code);
    };

    let made: SpawnWorktreeResult;
    try {
      made = await this.deps.worktrees.create({ repoPath: claim.repoPath, sub: claim.sub, spawnId });
    } catch (err) {
      made = { ok: false, code: 'failed', detail: errMsg(err) };
    }
    if (!made.ok) return undo(made.code, made.detail);
    try {
      this.deps.starts.update(hostId, spawnId, { worktreePath: made.worktreePath, cwd: made.cwd });
    } catch (err) {
      return undo('failed', `the worktree was not recorded: ${errMsg(err)}`);
    }
    if (!this.deps.mode.active()) return undo('failed', 'headless mode was turned off');

    // The worktree is a folder nobody opened here: without the first-run env
    // Claude Code stops on its folder-trust prompt, as a fan-out worker would.
    const command = `${stem} --session-id ${rec.agentSessionId} ${workerLaunchFlags(claim.permissionMode)}`;
    try {
      await sessions.create({ sessionId: rec.sessionId, workspaceId: rec.workspaceId, cwd: made.cwd, agentBin, command, env: firstRunEnvForAgent(stem) });
      this.deps.starts.update(hostId, spawnId, { phase: 'created' });
    } catch (err) {
      return undo('failed', `the session did not start: ${errMsg(err)}`);
    }
    if (!this.deps.mode.active()) return undo('failed', 'headless mode was turned off');
    if (!sessions.alive(rec.sessionId)) return undo('failed', 'the agent exited as soon as it started');

    let res: A2aSpawnStepResult;
    try {
      res = await this.deps.receiver.started(hostId, spawnId, { workspaceId: rec.workspaceId, paneId: rec.sessionId });
    } catch (err) {
      res = { ok: false, error: errMsg(err) };
    }
    const req = this.deps.requests.get(hostId, spawnId);
    if (!res.ok && !(req?.state === 'decided' && req.code === 'started')) return undo('failed', `not linked: ${res.error}`);
    try {
      this.deps.starts.update(hostId, spawnId, { phase: 'started', ...(req?.linkId ? { linkId: req.linkId } : {}) });
    } catch (err) {
      // The request says started: reconcile finishes the record.
      this.deps.log('warn', `[headless] spawn ${spawnId}: started, record not updated: ${errMsg(err)}`);
    }
    this.deps.log('info', `[headless] spawn ${spawnId} from ${hostId}: started ${claim.agent} in session ${rec.sessionId}`);
  }
}
