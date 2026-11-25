import { agentLauncherStem, agentRow } from '../../shared/agentIdentity';
import { firstRunEnvForAgent } from '../../shared/agentFirstRun';
import { workerAutoUpdateEnv } from '../worktask/fanoutEnvironment';
import { A2A_REMOTE_INBOUND_EVENT, A2A_REMOTE_RPC } from '../../shared/a2aRemoteDelivery';
import {
  A2A_SPAWN_EVENT,
  A2A_SPAWN_RPC,
  type A2aRemoteSpawnedBy,
  type A2aSpawnCardV1,
  type A2aSpawnClaimResult,
  type A2aSpawnFollowUpCardV1,
  type A2aSpawnRequestSummary,
  type A2aSpawnWork,
} from '../../shared/a2aSpawn';
import type { ApprovalHandle, RemoteSpawnPromptInfo } from '../mcp/ApprovalQueue';
import { createSpawnWorktree, removeSpawnWorktree, type SpawnWorktreeInput, type SpawnWorktreeResult } from './spawnWorktree';

/**
 * Remote spawn on the receiving PC, the app's part. The daemon decides and
 * keeps every request; this shows the cards and starts what was approved:
 *
 *   awaiting → the approval card (Allow once / Always / Deny) → `decide`
 *   approved → `claim` (the daemon checks everything again) → a hardened
 *              worktree (spawnWorktree.ts) → the "From <PC>" workspace, its
 *              one pane running the agent's launcher alone, in the policy's
 *              permission mode, stamped depth 1 inside pty.create before the
 *              agent starts → `started` (the daemon then links it and queues
 *              the prompt as its first task)
 *   Any step that fails after the workspace opened closes it and removes the
 *   worktree and its branch, then the daemon is told `failed`.
 *   a held follow-up → its card → the hold is retried (delivered) or rejected
 *
 * Driven by the daemon's `a2a.remote.spawn.changed` and inbound broadcasts,
 * on start (every reconnect) and on a backstop, so a lost broadcast only
 * delays. The prompt never reaches a command line, a log or a toast here.
 */

export const REMOTE_SPAWN_BACKSTOP_MS = 30_000;
/** A claim the daemon could not check now is tried again after this. */
export const REMOTE_SPAWN_RETRY_MS = 30_000;
/** How long the renderer may take to open the workspace. */
const SPAWN_WORKSPACE_TIMEOUT_MS = 60_000;

export interface RemoteSpawnCoordinatorDeps {
  daemonRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  sendToRenderer: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
  onDaemonEvent: (listener: (event: { type?: unknown; [key: string]: unknown }) => void) => () => void;
  /** The approval queue (kind 'remote-spawn'). */
  consent: {
    requestConsent(input: {
      kind: 'remote-spawn';
      dedupeKey: string;
      clientName: string;
      title: string;
      deadlineAt?: number;
      remoteSpawn: RemoteSpawnPromptInfo;
    }): ApprovalHandle;
    cancelPrompt(promptId: string, reason: string): void;
  };
  /** Deliver a held remote task now (RemoteA2aBridge.retryHeld). */
  retryHeld: (taskId: string) => Promise<unknown>;
  createWorktree?: (input: SpawnWorktreeInput) => Promise<SpawnWorktreeResult>;
  removeWorktree?: (input: { repoPath: string; spawnId: string }) => Promise<void>;
  backstopMs?: number;
  retryMs?: number;
  log: (level: 'info' | 'warn', msg: string) => void;
}

type SpawnedWorkspace = { workspaceId: string; paneId: string };

export class RemoteSpawnCoordinator {
  private readonly deps: RemoteSpawnCoordinatorDeps;
  /** Cards on screen, by key: `spawn:<host>:<id>` or `follow:<taskId>`. */
  private readonly shown = new Map<string, string>();
  private readonly starting = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(deps: RemoteSpawnCoordinatorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.unsubscribe = this.deps.onDaemonEvent((event) => {
      if (event?.type === A2A_SPAWN_EVENT || event?.type === A2A_REMOTE_INBOUND_EVENT) void this.refresh();
    });
    this.timer = setInterval(() => void this.refresh(), this.deps.backstopMs ?? REMOTE_SPAWN_BACKSTOP_MS);
    this.timer.unref?.();
    void this.refresh();
  }

  /**
   * Stop acting: no more passes or starts, and the cards this one showed are
   * taken down (the next connection shows them again, and answers them).
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    for (const promptId of this.shown.values()) this.deps.consent.cancelPrompt(promptId, 'wmux reconnected to its background service');
    this.shown.clear();
  }

  /** Read what the daemon has for this app and act on it. One at a time; a call meanwhile runs once more after. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        // eslint-disable-next-line no-await-in-loop -- one pass at a time
        await this.pass();
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Resolves once the current pass and the starts it began have finished (tests). */
  async whenIdle(): Promise<void> {
    while (this.running || this.starting.size > 0) {
      // eslint-disable-next-line no-await-in-loop -- until quiet
      await (this.running ?? Promise.resolve());
      // eslint-disable-next-line no-await-in-loop -- a start finishing is a few awaits away
      if (this.starting.size > 0) await new Promise((r) => setImmediate(r));
    }
  }

  private async pass(): Promise<void> {
    if (this.stopped) return;
    let work: A2aSpawnWork;
    try {
      work = (await this.deps.daemonRpc(A2A_SPAWN_RPC.work, {})) as A2aSpawnWork;
    } catch (err) {
      this.deps.log('warn', `[remote-spawn] could not read the requests: ${errText(err)}`);
      return;
    }
    if (!work || !Array.isArray(work.awaiting) || !Array.isArray(work.approved) || !Array.isArray(work.followUps)) return;
    const live = new Set<string>();
    for (const card of work.awaiting) {
      const key = `spawn:${card.hostId}:${card.spawnId}`;
      live.add(key);
      if (!this.shown.has(key)) this.showCard(key, card);
    }
    for (const card of work.followUps) {
      const key = `follow:${card.taskId}`;
      live.add(key);
      if (!this.shown.has(key)) this.showFollowUp(key, card);
    }
    // Decided elsewhere, expired, or the PC was removed: its card goes.
    for (const [key, promptId] of [...this.shown]) {
      if (live.has(key)) continue;
      this.shown.delete(key);
      this.deps.consent.cancelPrompt(promptId, 'this request is no longer waiting');
    }
    for (const item of work.approved) void this.startOne(item.hostId, item.spawnId);
  }

  private showCard(key: string, card: A2aSpawnCardV1): void {
    const handle = this.deps.consent.requestConsent({
      kind: 'remote-spawn',
      dedupeKey: key,
      clientName: card.hostName,
      title: `${card.hostName} wants to start ${card.agent} here`,
      deadlineAt: Date.parse(card.expiresAt),
      remoteSpawn: {
        hostId: card.hostId,
        hostName: card.hostName,
        agent: card.agent,
        folder: card.folder,
        permissionMode: card.permissionMode,
        followUps: card.followUps,
        text: card.text,
      },
    });
    this.shown.set(key, handle.promptId);
    void handle.resolution
      .then(async (r) => {
        // Answered after this one stopped: the next connection's card takes it.
        if (this.stopped) return;
        const verdict = !r.approved ? 'deny' : r.remember ? 'always' : 'once';
        const res = await this.deps.daemonRpc(A2A_SPAWN_RPC.decide, { hostId: card.hostId, spawnId: card.spawnId, verdict });
        if (!isOk(res)) this.deps.log('warn', `[remote-spawn] ${card.spawnId}: answer not taken: ${errorOf(res)}`);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.shown.get(key) === handle.promptId) this.shown.delete(key);
        void this.refresh();
      });
  }

  private showFollowUp(key: string, card: A2aSpawnFollowUpCardV1): void {
    const handle = this.deps.consent.requestConsent({
      kind: 'remote-spawn',
      dedupeKey: key,
      clientName: card.hostName,
      title: `${card.hostName} sent a new instruction`,
      remoteSpawn: {
        hostId: card.hostId,
        hostName: card.hostName,
        agent: card.agent,
        folder: card.folder,
        permissionMode: card.permissionMode,
        followUps: 'ask',
        text: card.text,
        followUp: true,
      },
    });
    this.shown.set(key, handle.promptId);
    void handle.resolution
      .then(async (r) => {
        if (this.stopped) return;
        if (r.approved) await this.deps.retryHeld(card.taskId);
        else await this.deps.daemonRpc(A2A_REMOTE_RPC.rejectHeld, { taskId: card.taskId, reason: 'declined on this PC' });
      })
      .catch((err: unknown) => this.deps.log('warn', `[remote-spawn] follow-up ${card.taskId}: not settled: ${errText(err)}`))
      .finally(() => {
        if (this.shown.get(key) === handle.promptId) this.shown.delete(key);
      });
  }

  private async startOne(hostId: string, spawnId: string): Promise<void> {
    const key = `${hostId}:${spawnId}`;
    if (this.starting.has(key) || this.retryTimers.has(key) || this.stopped) return;
    this.starting.add(key);
    let claimed: A2aSpawnClaimResult;
    try {
      claimed = (await this.deps.daemonRpc(A2A_SPAWN_RPC.claim, { hostId, spawnId })) as A2aSpawnClaimResult;
    } catch (err) {
      this.starting.delete(key);
      this.retryLater(key, hostId, spawnId, errText(err));
      return;
    }
    if (!claimed?.ok) {
      this.starting.delete(key);
      // Refused (the daemon answered the asker), or not checkable right now.
      if (!claimed?.code) this.retryLater(key, hostId, spawnId, claimed?.error ?? 'no answer');
      return;
    }
    const { claim } = claimed;
    // What this start made so far, taken back if it does not finish.
    let tree: { repoPath: string; spawnId: string } | null = null;
    let workspaceId: string | null = null;
    const undo = async (code: 'folder-not-allowed' | 'failed', why: string, refused = false): Promise<void> => {
      this.deps.log('warn', `[remote-spawn] ${spawnId} from ${hostId}: not started (${code}): ${why}`);
      if (workspaceId) {
        // Closing the workspace ends its pane and the agent in it.
        await this.deps.sendToRenderer('workspace.close', { id: workspaceId }).catch((err: unknown) =>
          this.deps.log('warn', `[remote-spawn] ${spawnId}: workspace ${workspaceId} not closed: ${errText(err)}`));
      }
      if (tree) {
        await (this.deps.removeWorktree ?? removeSpawnWorktree)(tree).catch((err: unknown) =>
          this.deps.log('warn', `[remote-spawn] ${spawnId}: worktree not removed: ${errText(err)}`));
      }
      if (!refused) await this.deps.daemonRpc(A2A_SPAWN_RPC.failed, { hostId, spawnId, code }).catch(() => undefined);
    };
    try {
      const row = agentRow(claim.agent);
      if (!row) return await undo('failed', `unknown agent ${claim.agent}`);
      const made = await (this.deps.createWorktree ?? createSpawnWorktree)({ repoPath: claim.repoPath, sub: claim.sub, spawnId, ...(claim.base ? { base: claim.base } : {}) });
      if (!made.ok) return await undo(made.code, made.detail);
      tree = { repoPath: claim.repoPath, spawnId };
      // Branched from origin's default branch as fetched now; when it could not be, from HEAD, said once here.
      if (made.baseNote) this.deps.log('warn', `[remote-spawn] ${spawnId}: ${made.baseNote}`);
      else if (made.baseRef) this.deps.log('info', `[remote-spawn] ${spawnId}: worktree from ${made.baseRef} at ${made.base}`);
      // The renderer takes a name of at most 64 characters (it drops the marker otherwise).
      const spawnedBy: A2aRemoteSpawnedBy = { hostId, name: claim.hostName.slice(0, 64), spawnId, agent: claim.agent };
      let opened: unknown;
      // The worktree is a folder nobody opened here: without the first-run env
      // Claude Code stops on its folder-trust prompt, as a fan-out worker would.
      const paneEnv = { ...workerAutoUpdateEnv(), ...firstRunEnvForAgent(agentLauncherStem(row)) };
      try {
        opened = await this.deps.sendToRenderer('fanout.spawnWorkspace', {
          name: `From ${claim.hostName}`,
          cwd: made.cwd,
          // The launcher alone: the prompt arrives as the link's first task, typed in once the agent is ready.
          initialCommand: agentLauncherStem(row),
          ...(Object.keys(paneEnv).length > 0 ? { env: paneEnv } : {}),
          workerPermissionMode: claim.permissionMode,
          // Also stamps the workspace depth 1 inside pty.create, before the agent starts.
          remoteSpawnedBy: spawnedBy,
        }, { timeoutMs: SPAWN_WORKSPACE_TIMEOUT_MS });
      } catch (err) {
        return await undo('failed', `the workspace did not open: ${errText(err)}`);
      }
      const ws = spawnedWorkspace(opened);
      // The renderer rolls back a workspace it could not finish; an id it did return is closed here.
      workspaceId = ws?.workspaceId ?? workspaceIdOf(opened);
      if (!ws) return await undo('failed', 'the workspace did not open');
      if (this.stopped) return await undo('failed', 'wmux reconnected to its background service meanwhile');
      let res: unknown;
      try {
        // The base note goes back to the asking PC with the answer.
        res = await this.deps.daemonRpc(A2A_SPAWN_RPC.started, { hostId, spawnId, ...ws, ...(made.baseNote ? { baseNote: made.baseNote } : {}) });
      } catch (err) {
        // No answer: the daemon may have stored the start anyway. Ask before
        // taking anything down; a start it stored stands (it finishes linking
        // on its own), and one it cannot tell about is left for the person.
        const stored = await this.startStored(hostId, spawnId);
        if (stored === false) {
          // Refused before anything is taken down: a start still being linked
          // gives itself up, and one stored meanwhile refuses this and stands.
          const refused = await this.deps.daemonRpc(A2A_SPAWN_RPC.failed, { hostId, spawnId, code: 'failed' }).then(isOk, () => false);
          if (refused) return await undo('failed', `not linked: ${errText(err)}`, true);
        }
        this.deps.log('warn', `[remote-spawn] ${spawnId} from ${hostId}: started, ${stored ? 'stored by the daemon' : 'not confirmed'}; kept: ${errText(err)}`);
        return;
      }
      if (!isOk(res)) return await undo('failed', `not linked: ${errorOf(res)}`);
      this.deps.log('info', `[remote-spawn] ${spawnId} from ${hostId}: started ${claim.agent} in workspace ${ws.workspaceId}`);
    } catch (err) {
      await undo('failed', `start failed: ${errText(err)}`);
    } finally {
      this.starting.delete(key);
    }
  }

  /** Whether the daemon stored this request as started; undefined when it cannot be asked. */
  private async startStored(hostId: string, spawnId: string): Promise<boolean | undefined> {
    try {
      const res = (await this.deps.daemonRpc(A2A_SPAWN_RPC.requestsList, {})) as { requests?: A2aSpawnRequestSummary[] };
      if (!Array.isArray(res?.requests)) return undefined;
      const rec = res.requests.find((r) => r.hostId === hostId && r.spawnId === spawnId);
      return rec?.state === 'decided' && rec.code === 'started';
    } catch {
      return undefined;
    }
  }

  private retryLater(key: string, hostId: string, spawnId: string, why: string): void {
    if (this.stopped) return;
    this.deps.log('warn', `[remote-spawn] ${spawnId} from ${hostId}: not claimed now, trying again: ${why}`);
    const t = setTimeout(() => {
      this.retryTimers.delete(key);
      void this.startOne(hostId, spawnId);
    }, this.deps.retryMs ?? REMOTE_SPAWN_RETRY_MS);
    t.unref?.();
    this.retryTimers.set(key, t);
  }
}

function spawnedWorkspace(res: unknown): SpawnedWorkspace | null {
  if (typeof res !== 'object' || res === null) return null;
  const r = res as Record<string, unknown>;
  return typeof r['workspaceId'] === 'string' && r['workspaceId'] && typeof r['paneId'] === 'string' && r['paneId']
    ? { workspaceId: r['workspaceId'], paneId: r['paneId'] }
    : null;
}

function workspaceIdOf(res: unknown): string | null {
  const id = typeof res === 'object' && res !== null ? (res as { workspaceId?: unknown }).workspaceId : undefined;
  return typeof id === 'string' && id ? id : null;
}

function isOk(res: unknown): boolean {
  return typeof res === 'object' && res !== null && (res as { ok?: unknown }).ok === true;
}

function errorOf(res: unknown): string {
  const e = typeof res === 'object' && res !== null ? (res as { error?: unknown }).error : undefined;
  return typeof e === 'string' ? e : 'no answer';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
