import crypto from 'node:crypto';
import { agentLauncherStem, agentRow, type AgentSlug } from '../../shared/agentIdentity';
import { firstRunEnvForAgent } from '../../shared/agentFirstRun';
import type { HostId, A2aLinkRecordV1 } from '../../shared/a2aRemote';
import { REMOTE_SPAWN_LINEAGE_PREFIX, type A2aSpawnClaimResult, type A2aSpawnStepResult } from '../../shared/a2aSpawn';
import { workerLaunchFlags } from '../../shared/workerLaunch';

/** Beyond the worker deny list: an agent started for another PC asks no PC for more agents. */
export const HEADLESS_EXTRA_DISALLOWED_TOOLS: readonly string[] = ['mcp__wmux__remote_spawn'];
import type { Git, SpawnWorktreeInput, SpawnWorktreeResult } from '../../main/a2aRemote/spawnWorktree';
import { headlessStartable } from './headlessMode';
import type { HeadlessStartRecordV1, HeadlessStartStore, HeadlessSurvivor } from './headlessStartStore';
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
 *      denies the tools that would, the worker list and remote_spawn);
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
  /** Start the session; its process (pid and start time, waited for briefly) so it can be found again after a restart. */
  create(input: HeadlessSessionInput): Promise<{ rootPid?: number; rootStart?: string }>;
  /** The session exists and its process runs. */
  alive(sessionId: string): boolean;
  /**
   * End the session and its process tree. `ok: false` lists the processes
   * that did not exit (or could not be proven gone); the session itself is
   * closed either way. A session that is gone already is `ok`.
   */
  destroy(sessionId: string): Promise<HeadlessDestroyResult>;
  /**
   * An agent of an earlier daemon run, by the pid and start time recorded
   * when it started: ended with its tree when it still runs (a pid that now
   * names another process is left alone); what did not exit is reported.
   */
  killEarlier(rootPid: number, rootStart: string | undefined): Promise<HeadlessDestroyResult>;
  /**
   * Of processes an earlier destroy left, the ones that may still run. An
   * unverified entry (a tree that could not be checked whole) stays until a
   * check of `worktreePath` shows no process working in it; where that check
   * is not possible it stays.
   */
  stillRunning(survivors: readonly HeadlessSurvivor[], worktreePath: string | undefined): Promise<HeadlessSurvivor[]>;
}

export type HeadlessDestroyResult = { ok: true } | { ok: false; survivors: HeadlessSurvivor[] };

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
  starts: Pick<HeadlessStartStore, 'get' | 'list' | 'phaseOfLink' | 'phaseOfSession' | 'add' | 'update' | 'remove'>;
  /** Null until the daemon's session RPCs exist. */
  sessions: () => HeadlessSessionPort | null;
  worktrees: {
    create(input: SpawnWorktreeInput): Promise<SpawnWorktreeResult>;
    remove(input: { repoPath: string; spawnId: string }): Promise<void>;
    /** The folder is still on disk (an ended start's kept worktree). */
    exists(worktreePath: string): boolean;
    /** Where the worktree of `spawnId` is made. */
    pathFor(spawnId: string): string;
    /** The commit a new worktree is at; null when it cannot be read. */
    baseOf(worktreePath: string): Promise<string | null>;
    /** Nothing beyond `base` and a clean tree (true); anything else, or unknown, is false. */
    pristine(worktreePath: string, base: string): Promise<boolean>;
  };
  /** The owner asked (`wmux daemon headless release <spawnId>`) to drop the hold on this start. */
  releases: { requested(spawnId: string): boolean; clear(spawnId: string): void };
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
    // Only an approved request is started (one decided, expired or claimed meanwhile is not retried).
    if (this.deps.requests.get(hostId, spawnId)?.state !== 'approved') return Promise.resolve();
    if (!this.deps.sessions()) {
      this.retryLater(k, hostId, spawnId, 'the session service is not up yet');
      return Promise.resolve();
    }
    this.inFlight.add(k);
    return this.startNow(hostId, spawnId).catch((err: unknown) => {
      this.deps.log('error', `[headless] spawn ${spawnId} from ${hostId}: ${errMsg(err)}`);
    }).finally(() => {
      this.inFlight.delete(k);
      // Headless mode turned off while it started: what it made ends now, not at the next sweep.
      if (!this.deps.mode.active() && this.deps.starts.get(hostId, spawnId)) void this.reconcile();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Any link changed: a start whose link ended loses its session. */
  onLinkTransition(link: A2aLinkRecordV1): void {
    if (TERMINAL_LINK.has(link.state) && this.deps.starts.phaseOfLink(link.linkId) === 'started') void this.reconcile();
  }

  /** A session died or was closed: the start it ran ends (its link breaks). */
  onSessionGone(sessionId: string): void {
    const phase = this.deps.starts.phaseOfSession(sessionId);
    if (phase && phase !== 'ended') void this.reconcile();
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

  private async settle(start: HeadlessStartRecordV1): Promise<void> {
    let rec = start;
    const sessions = this.deps.sessions();
    // Processes an earlier end left: nothing more is undone, nor the start marked ended, until they are gone.
    if (rec.survivors?.length && this.deps.releases.requested(rec.spawnId)) {
      this.deps.log('warn', `[headless] spawn ${rec.spawnId}: hold on pid ${rec.survivors.map((p) => p.pid).join(', ')} released by the owner`);
      rec = this.deps.starts.update(rec.hostId, rec.spawnId, { survivors: undefined });
      this.deps.releases.clear(rec.spawnId);
    }
    if (rec.survivors?.length) {
      if (!sessions) return;
      const left = await sessions.stillRunning(rec.survivors, rec.worktreePath);
      rec = this.deps.starts.update(rec.hostId, rec.spawnId, { survivors: left.length > 0 ? left : undefined });
      if (left.length > 0) {
        this.deps.log('warn', `[headless] spawn ${rec.spawnId}: ${left.length} process(es) of its agent still run (pid ${left.map((p) => p.pid).join(', ')}); its worktree stays`);
        return;
      }
    }
    if (rec.phase === 'ended') {
      if (sessions?.alive(rec.sessionId)) await this.destroyOrHold(rec, sessions);
      // The owner removed its worktree: nothing is left to list.
      else if (!rec.worktreePath || !this.deps.worktrees.exists(rec.worktreePath)) this.deps.starts.remove(rec.hostId, rec.spawnId);
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
    const destroyed = await sessions.destroy(rec.sessionId);
    // An agent of an earlier daemon run is not in that session any more: found by its own pid and start time.
    const earlier = rec.runId !== this.deps.runId && rec.rootPid !== undefined
      ? await sessions.killEarlier(rec.rootPid, rec.rootStart)
      : { ok: true as const };
    // The link breaks either way (nothing is delivered to it, nothing counts it live).
    if (link && !TERMINAL_LINK.has(link.state)) await this.deps.paneGone(rec.workspaceId, rec.sessionId);
    // A link still owed is never made for it.
    this.deps.abandon(rec.hostId, rec.spawnId);
    const survivors = [...(destroyed.ok ? [] : destroyed.survivors), ...(earlier.ok ? [] : earlier.survivors)];
    if (survivors.length > 0) this.hold(rec, survivors);
    this.deps.starts.update(rec.hostId, rec.spawnId, { phase: 'ended', endedAt: new Date(this.now()).toISOString() });
    // Nothing done in it (no commit beyond where it started, a clean tree): it goes, with its branch.
    if (rec.worktreePath && rec.baseCommit && await this.deps.worktrees.pristine(rec.worktreePath, rec.baseCommit)) {
      await this.deps.worktrees.remove({ repoPath: rec.repoPath, spawnId: rec.spawnId });
      this.deps.starts.remove(rec.hostId, rec.spawnId);
      this.deps.log('info', `[headless] spawn ${rec.spawnId} from ${rec.hostId}: ended; its worktree was left unchanged and was removed`);
      return;
    }
    this.deps.log('info', `[headless] spawn ${rec.spawnId} from ${rec.hostId}: ended; worktree kept at ${rec.worktreePath ?? '(none)'}`);
  }

  /**
   * Session and worktree of a start that did not finish go, then its record.
   * The worktree only when this start recorded making it (or, before
   * `git worktree add`, the free path it was about to use): a `remote-<spawnId>`
   * that was there before (another start's kept work) is never touched. A
   * step that fails keeps the record (tried again).
   */
  private async takeBack(rec: HeadlessStartRecordV1, sessions: HeadlessSessionPort, why: string): Promise<void> {
    this.deps.log('warn', `[headless] spawn ${rec.spawnId} from ${rec.hostId}: taken back (${why})`);
    await this.destroyOrHold(rec, sessions);
    // Made by this start, or about to be when it stopped (nothing was there when it was recorded).
    if (rec.worktreePath || rec.worktreeIntended) await this.deps.worktrees.remove({ repoPath: rec.repoPath, spawnId: rec.spawnId });
    this.deps.starts.remove(rec.hostId, rec.spawnId);
  }

  /** End the session; when processes of its tree did not exit, they are recorded and this throws (reconcile tries again). */
  private async destroyOrHold(rec: HeadlessStartRecordV1, sessions: HeadlessSessionPort): Promise<void> {
    const destroyed = await sessions.destroy(rec.sessionId);
    if (!destroyed.ok) this.hold(rec, destroyed.survivors);
  }

  private hold(rec: HeadlessStartRecordV1, survivors: HeadlessSurvivor[]): never {
    this.deps.starts.update(rec.hostId, rec.spawnId, { survivors });
    throw new Error(`${survivors.length} process(es) of its agent did not exit (pid ${survivors.map((p) => p.pid).join(', ')}); its worktree stays until they do`);
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
    // Claude Code only in this version (headlessStartable); `manual` needs a person at the pane.
    if (!headlessStartable(claim.agent)) return refuse(`${claim.agent} is not started on a host without the app`);
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
    /** `notOurs`: the worktree step failed, so whatever is at its path is not this start's (never removed). */
    const undo = async (code: 'folder-not-allowed' | 'failed', why: string, notOurs = false): Promise<void> => {
      this.deps.log('warn', `[headless] spawn ${spawnId} from ${hostId}: not started (${code}): ${why}`);
      try {
        // Not left in the record either, where a later reconcile would take it back.
        if (notOurs && this.deps.starts.get(hostId, spawnId)?.worktreeIntended) this.deps.starts.update(hostId, spawnId, { worktreeIntended: undefined });
        const stored = this.deps.starts.get(hostId, spawnId) ?? rec;
        const current = rec.worktreePath && !stored.worktreePath ? { ...stored, worktreePath: rec.worktreePath } : stored;
        const { worktreeIntended: _intended, worktreePath: _path, ...withoutTree } = current;
        await this.takeBack(notOurs ? withoutTree : current, sessions, why);
      } catch (err) {
        this.deps.log('warn', `[headless] spawn ${spawnId}: left for the next reconcile: ${errMsg(err)}`);
      }
      this.deps.receiver.failed(hostId, spawnId, code);
    };

    // The path is recorded before `git worktree add`, so a daemon that dies in between still takes it back.
    // Only a free one: one that is there already is another start's and is never recorded (nor touched).
    const intended = this.deps.worktrees.pathFor(spawnId);
    if (this.deps.worktrees.exists(intended)) return undo('failed', `${intended} is there already`);
    try {
      this.deps.starts.update(hostId, spawnId, { worktreeIntended: intended });
    } catch (err) {
      return undo('failed', `the worktree was not recorded: ${errMsg(err)}`);
    }
    let made: SpawnWorktreeResult;
    try {
      made = await this.deps.worktrees.create({ repoPath: claim.repoPath, sub: claim.sub, spawnId });
    } catch (err) {
      made = { ok: false, code: 'failed', detail: errMsg(err) };
    }
    if (!made.ok) return undo(made.code, made.detail, true);
    try {
      const baseCommit = await this.deps.worktrees.baseOf(made.worktreePath).catch(() => null);
      this.deps.starts.update(hostId, spawnId, { worktreePath: made.worktreePath, cwd: made.cwd, ...(baseCommit ? { baseCommit } : {}) });
    } catch (err) {
      // Made by this start, so it goes, recorded or not.
      rec.worktreePath = made.worktreePath;
      return undo('failed', `the worktree was not recorded: ${errMsg(err)}`);
    }
    if (!this.deps.mode.active()) return undo('failed', 'headless mode was turned off');

    // The worktree is a folder nobody opened here: without the first-run env
    // Claude Code stops on its folder-trust prompt, as a fan-out worker would.
    const command = `${stem} --session-id ${rec.agentSessionId} ${workerLaunchFlags(claim.permissionMode, HEADLESS_EXTRA_DISALLOWED_TOOLS)}`;
    try {
      const root = await sessions.create({ sessionId: rec.sessionId, workspaceId: rec.workspaceId, cwd: made.cwd, agentBin, command, env: firstRunEnvForAgent(stem) });
      this.deps.starts.update(hostId, spawnId, {
        phase: 'created',
        ...(root.rootPid !== undefined ? { rootPid: root.rootPid } : {}),
        ...(root.rootStart ? { rootStart: root.rootStart } : {}),
      });
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

/**
 * Whether a start's worktree is as it was made: HEAD still at `base` and
 * nothing in it that git lists, ignored files included. An agent's output may
 * be all ignored files (a report under an ignored folder, a build), and
 * removing the worktree would delete them.
 */
export async function worktreeUnchanged(git: Git, base: string): Promise<boolean> {
  const head = await git(['rev-parse', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() !== base) return false;
  const status = await git(['status', '--porcelain', '--untracked-files=all', '--ignored=traditional']);
  return status.code === 0 && status.stdout.trim() === '';
}
