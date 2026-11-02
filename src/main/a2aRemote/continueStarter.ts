import path from 'node:path';
import { agentLauncherStem, agentRow } from '../../shared/agentIdentity';
import { firstRunEnvForAgent } from '../../shared/agentFirstRun';
import {
  A2A_CONTINUE_EVENT,
  A2A_CONTINUE_RPC,
  isContinueAgent,
  type A2aContinueClaimResult,
  type A2aContinuePermissionMode,
  type A2aContinuePlaceResult,
  type A2aContinueRequestState,
  type A2aContinueStartFailure,
  type A2aContinueWork,
} from '../../shared/a2aContinue';
import { pwshQuote, shellQuote } from '../../shared/resumeShell';
import {
  createContinueWorktree,
  removeContinueWorktree,
  type ContinueWorktreeInput,
  type ContinueWorktreeMade,
  type ContinueWorktreeResult,
} from './continueWorktree';
import { realpathOrNull } from './spawnWorktree';

/**
 * Continue on another PC, on the receiving PC (B): the app's part of starting
 * a conversation B has fully received. The daemon keeps the request and its
 * files; this, for each request `received`:
 *
 *   `claim` (the daemon checks it again) → the worktree on B's own copy of
 *   the branch at A's commit (continueWorktree.ts) → `place` (the daemon puts
 *   the transcript where Claude reads it for that folder) → the "From <PC>"
 *   workspace, its one pane running `claude --resume <placed path>
 *   --permission-mode <B's mode>` → the pane's first hooks bind it, to that
 *   same file → `started`.
 *
 * Any step that fails takes back what the steps before it made, last first
 * (the workspace, the placed files, the worktree and its branch), then tells
 * the daemon `failed` with the most precise code. A pane whose hooks name
 * another file resumed something else: it is taken down too. A pane whose
 * hooks say nothing in BIND_WAIT_MS is `started` all the same, with a
 * warning: the agent runs, and which file it holds cannot be proven.
 *
 * Driven by the daemon's continue broadcast, on start (every reconnect) and
 * on a backstop, so a lost broadcast only delays.
 */

export const CONTINUE_START_BACKSTOP_MS = 30_000;
/** A claim the daemon could not check now is tried again after this. */
export const CONTINUE_START_RETRY_MS = 30_000;
/** How long the pane's hooks may take to bind the resumed conversation. */
export const CONTINUE_BIND_WAIT_MS = 90_000;
const BIND_POLL_MS = 1_000;
/** How long the renderer may take to open the workspace. */
const SPAWN_WORKSPACE_TIMEOUT_MS = 60_000;
/** A claim reads every root's origin again through the daemon's git gate: more than a plain call's 10 s. */
export const CONTINUE_CLAIM_TIMEOUT_MS = 2 * 60_000;
/** A place may copy and sync a whole conversation across volumes, and an unplace waits for a place still running. */
export const CONTINUE_PLACE_TIMEOUT_MS = 10 * 60_000;

/**
 * Claude's own word for each of B's modes. Never left out: without the flag
 * Claude restores the mode the transcript was written in, which may be one
 * that skips every permission check.
 */
const CLAUDE_PERMISSION_MODE: Readonly<Record<A2aContinuePermissionMode, string>> = {
  auto: 'auto',
  acceptEdits: 'acceptEdits',
  manual: 'default',
};

// eslint-disable-next-line no-control-regex -- a control character ends a typed line early
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The pane's launch line: resume the placed transcript by its path, in B's
 * mode. The path is quoted for the platform's default shell (PowerShell on
 * Windows, sh elsewhere) with the resume line's own quoting. Null when it
 * cannot be typed.
 */
export function continueLaunchLine(launcher: string, transcriptPath: string, mode: A2aContinuePermissionMode, platform: NodeJS.Platform = process.platform): string | null {
  const flag = Object.hasOwn(CLAUDE_PERMISSION_MODE, mode) ? CLAUDE_PERMISSION_MODE[mode] : undefined;
  const absolute = platform === 'win32' ? path.win32.isAbsolute(transcriptPath) : path.posix.isAbsolute(transcriptPath);
  if (!flag || !absolute || CONTROL.test(transcriptPath)) return null;
  const word = platform === 'win32' ? pwshQuote(transcriptPath) : shellQuote(transcriptPath);
  return `${launcher} --resume ${word} --permission-mode ${flag}`;
}

export interface ContinueStarterDeps {
  daemonRpc: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
  sendToRenderer: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
  onDaemonEvent: (listener: (event: { type?: unknown; [key: string]: unknown }) => void) => () => void;
  /**
   * Whether the window's RPC bridge answers. A request is sent to the window
   * without being queued, so one sent before the bridge is up is dropped.
   */
  rendererReady: () => Promise<boolean>;
  createWorktree?: (input: ContinueWorktreeInput) => Promise<ContinueWorktreeResult>;
  removeWorktree?: (made: ContinueWorktreeMade) => Promise<void>;
  /** The OS realpath, or null when it does not resolve. */
  realpath?: (p: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
  backstopMs?: number;
  retryMs?: number;
  bindWaitMs?: number;
  bindPollMs?: number;
  log: (level: 'info' | 'warn', msg: string) => void;
}

type OpenedPane = { workspaceId: string; ptyId: string };

export class ContinueStarter {
  private readonly deps: ContinueStarterDeps;
  private readonly platform: NodeJS.Platform;
  private readonly starting = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(deps: ContinueStarterDeps) {
    this.deps = deps;
    this.platform = deps.platform ?? process.platform;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.unsubscribe = this.deps.onDaemonEvent((event) => {
      if (event?.type === A2A_CONTINUE_EVENT) void this.refresh();
    });
    this.timer = setInterval(() => void this.refresh(), this.deps.backstopMs ?? CONTINUE_START_BACKSTOP_MS);
    this.timer.unref?.();
    void this.refresh();
  }

  /** Stop acting: no more passes or starts; a start still running takes itself down before it would report `started`. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }

  /** Read what the daemon has received and start it. One pass at a time; a call meanwhile runs once more after. */
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
    let work: A2aContinueWork;
    try {
      work = (await this.deps.daemonRpc(A2A_CONTINUE_RPC.work, {})) as A2aContinueWork;
    } catch (err) {
      this.deps.log('warn', `[continue] could not read the received conversations: ${errText(err)}`);
      return;
    }
    if (!work || !Array.isArray(work.received)) return;
    for (const item of work.received) void this.startOne(item.hostId, item.continueId);
  }

  private async startOne(hostId: string, continueId: string): Promise<void> {
    const key = `${hostId}:${continueId}`;
    if (this.starting.has(key) || this.retryTimers.has(key) || this.stopped) return;
    this.starting.add(key);
    // Nothing is claimed before the window can open the workspace: the
    // request stays received, and is tried again.
    if (!(await this.deps.rendererReady().catch(() => false))) {
      this.starting.delete(key);
      this.retryLater(key, continueId, 'the window does not answer yet');
      return;
    }
    let claimed: A2aContinueClaimResult;
    try {
      claimed = (await this.deps.daemonRpc(A2A_CONTINUE_RPC.claim, { hostId, continueId }, { timeoutMs: CONTINUE_CLAIM_TIMEOUT_MS })) as A2aContinueClaimResult;
    } catch (err) {
      // No answer: the daemon may have claimed it anyway, and a claimed
      // request is never listed again. One it holds as starting is given up,
      // so the other PC resumes its own copy; any other is tried again.
      const now = await this.requestState(hostId, continueId);
      if (now?.state === 'starting') {
        const ended = await this.deps.daemonRpc(A2A_CONTINUE_RPC.failed, { hostId, continueId, code: 'failed' }).then(isOk, () => false);
        this.deps.log('warn', `[continue] ${continueId} from ${hostId}: claimed with no answer, ${ended ? 'given up' : 'not given up'}: ${errText(err)}`);
      } else {
        this.retryLater(key, continueId, errText(err));
      }
      this.starting.delete(key);
      return;
    }
    if (!claimed?.ok) {
      this.starting.delete(key);
      // Refused (the daemon answered the asker), or not checkable right now.
      if (!claimed?.code) this.retryLater(key, continueId, claimed?.error ?? 'no answer');
      return;
    }
    const { claim } = claimed;
    // What this start made so far, taken back if it does not finish.
    let tree: ContinueWorktreeMade | null = null;
    let placed = false;
    let workspaceId: string | null = null;
    const undo = async (code: A2aContinueStartFailure, why: string, refused = false): Promise<void> => {
      this.deps.log('warn', `[continue] ${continueId} from ${hostId}: not started (${code}): ${why}`);
      if (workspaceId) {
        // Closing the workspace ends its pane and the agent in it, before its
        // files go; without force the window refuses while an agent runs.
        const closeError = await this.deps.sendToRenderer('workspace.close', { id: workspaceId, force: true })
          .then((res) => errorField(res), (err: unknown) => errText(err));
        if (closeError !== null) {
          // The agent may still run there, so its files, its worktree and the
          // request stay as they are: the daemon's sweep settles the start
          // started while a live agent runs it, else unknown, and A resumes on neither.
          this.deps.log('warn', `[continue] ${continueId}: workspace ${workspaceId} not closed, so nothing is taken back: ${closeError}`);
          return;
        }
      }
      if (placed) {
        const back = await this.deps.daemonRpc(A2A_CONTINUE_RPC.unplace, { hostId, continueId }, { timeoutMs: CONTINUE_PLACE_TIMEOUT_MS })
          .catch((err: unknown) => ({ ok: false, error: errText(err) }));
        if (!isOk(back)) this.deps.log('warn', `[continue] ${continueId}: placed files not taken back: ${errorOf(back)}`);
      }
      if (tree) {
        await (this.deps.removeWorktree ?? removeContinueWorktree)(tree).catch((err: unknown) =>
          this.deps.log('warn', `[continue] ${continueId}: worktree not removed: ${errText(err)}`));
      }
      if (!refused) await this.deps.daemonRpc(A2A_CONTINUE_RPC.failed, { hostId, continueId, code }).catch(() => undefined);
    };
    try {
      const row = agentRow(claim.agent);
      if (!row || !isContinueAgent(claim.agent)) return await undo('failed', `${claim.agent} is not an agent whose conversation moves`);
      const launcher = agentLauncherStem(row);
      if (!Object.hasOwn(CLAUDE_PERMISSION_MODE, claim.permissionMode)) return await undo('failed', 'not a mode a continued conversation runs in');
      const made = await (this.deps.createWorktree ?? createContinueWorktree)({
        repoPath: claim.repoPath, origin: claim.origin, branch: claim.branch, head: claim.head, sub: claim.sub, continueId,
      });
      if (!made.ok) return await undo(made.code, made.detail);
      tree = made.made;
      let put: A2aContinuePlaceResult;
      try {
        put = (await this.deps.daemonRpc(A2A_CONTINUE_RPC.place, { hostId, continueId, cwd: made.cwd }, { timeoutMs: CONTINUE_PLACE_TIMEOUT_MS })) as A2aContinuePlaceResult;
      } catch (err) {
        // No answer: the daemon may have placed them, and unplace takes back whatever it did.
        placed = true;
        return await undo('failed', `the files were not placed: ${errText(err)}`);
      }
      // A refused place took back its own steps.
      if (!put?.ok) return await undo(put?.code ?? 'failed', put?.error ?? 'no answer');
      placed = true;
      const command = continueLaunchLine(launcher, put.transcriptPath, claim.permissionMode, this.platform);
      if (!command) return await undo('failed', 'the placed transcript\'s path cannot be typed');
      // The worktree is a folder nobody opened here: without the first-run env
      // Claude Code stops on its folder-trust prompt, as a fan-out worker would.
      const paneEnv = firstRunEnvForAgent(launcher);
      // A start that spans a reconnect opens no pane only to close it.
      if (this.stopped) return await undo('failed', 'wmux reconnected to its background service meanwhile');
      let opened: unknown;
      try {
        opened = await this.deps.sendToRenderer('fanout.spawnWorkspace', {
          name: `From ${claim.hostName}`,
          cwd: made.cwd,
          initialCommand: command,
          ...(Object.keys(paneEnv).length > 0 ? { env: paneEnv } : {}),
          workerPermissionMode: claim.permissionMode,
        }, { timeoutMs: SPAWN_WORKSPACE_TIMEOUT_MS });
      } catch (err) {
        return await undo('failed', `the workspace did not open: ${errText(err)}`);
      }
      const pane = openedPane(opened);
      // The renderer rolls back a workspace it could not finish; an id it did return is closed here.
      workspaceId = pane?.workspaceId ?? workspaceIdOf(opened);
      if (!pane) return await undo('failed', 'the workspace did not open');
      const bound = await this.waitForBinding(pane.ptyId, put.transcriptPath);
      if (bound === 'stopped') return await undo('failed', 'wmux reconnected to its background service meanwhile');
      if (bound === 'other') return await undo('failed', 'the pane\'s agent resumed another transcript');
      if (bound === 'none') {
        this.deps.log('warn', `[continue] ${continueId} from ${hostId}: no hook bound the pane in time; started, its transcript unproven`);
      }
      let res: unknown;
      try {
        res = await this.deps.daemonRpc(A2A_CONTINUE_RPC.started, { hostId, continueId });
      } catch (err) {
        // No answer: the pane runs the conversation already, so what the
        // daemon holds decides, as for a start it did not store. One still
        // starting stays (the sweep settles it started while its agent runs),
        // as does one decided started; one decided otherwise is taken down
        // without being reported again.
        const now = await this.requestState(hostId, continueId);
        if (now?.state === 'starting' || (now?.state === 'decided' && now.code === 'started')) {
          this.deps.log('warn', `[continue] ${continueId} from ${hostId}: started, no answer; kept, as ${now.state}: ${errText(err)}`);
          return;
        }
        if (now?.state === 'decided') return await undo('failed', `no answer, and decided ${now.code ?? 'otherwise'}: ${errText(err)}`, true);
        if (now) {
          // No record: refused before anything is taken down; one stored meanwhile refuses this and stands.
          const refused = await this.deps.daemonRpc(A2A_CONTINUE_RPC.failed, { hostId, continueId, code: 'failed' }).then(isOk, () => false);
          if (refused) return await undo('failed', `not stored: ${errText(err)}`, true);
        }
        // One it cannot tell about is left for the person.
        this.deps.log('warn', `[continue] ${continueId} from ${hostId}: started, not confirmed; kept: ${errText(err)}`);
        return;
      }
      if (!isOk(res)) {
        // Not stored: what the daemon holds decides. One still starting stays
        // (the sweep settles it started while its agent runs), as does one
        // decided started; one decided otherwise is not reported again.
        const now = await this.requestState(hostId, continueId);
        if (now?.state === 'starting' || (now?.state === 'decided' && now.code === 'started')) {
          this.deps.log('warn', `[continue] ${continueId} from ${hostId}: started, not stored (${errorOf(res)}); kept, as ${now.state}`);
          return;
        }
        return await undo('failed', `not stored: ${errorOf(res)}`, now?.state === 'decided');
      }
      this.deps.log('info', `[continue] ${continueId} from ${hostId}: started ${claim.agent} in workspace ${pane.workspaceId}`);
    } catch (err) {
      await undo('failed', `start failed: ${errText(err)}`);
    } finally {
      this.starting.delete(key);
    }
  }

  /**
   * The pane's binding, polled until its hooks name a transcript: `same` when
   * it is the placed file (by realpath; case-insensitively on Windows),
   * `other` when it is not, `none` when nothing came in time, `stopped` when
   * this starter stopped meanwhile.
   */
  private async waitForBinding(ptyId: string, placedPath: string): Promise<'same' | 'other' | 'none' | 'stopped'> {
    const realpath = this.deps.realpath ?? realpathOrNull;
    const want = (await realpath(placedPath)) ?? placedPath;
    const deadline = Date.now() + (this.deps.bindWaitMs ?? CONTINUE_BIND_WAIT_MS);
    for (;;) {
      if (this.stopped) return 'stopped';
      let named: string | null = null;
      try {
        const res = (await this.deps.daemonRpc(A2A_CONTINUE_RPC.binding, { ptyId })) as { transcriptPath?: unknown };
        named = typeof res?.transcriptPath === 'string' && res.transcriptPath ? res.transcriptPath : null;
      } catch {
        // Asked again on the next poll.
      }
      if (named !== null) return this.samePath((await realpath(named)) ?? named, want) ? 'same' : 'other';
      if (Date.now() >= deadline) return 'none';
      // eslint-disable-next-line no-await-in-loop -- one poll at a time
      await new Promise((r) => setTimeout(r, this.deps.bindPollMs ?? BIND_POLL_MS));
    }
  }

  /** Where the daemon holds this request now; undefined when it cannot be asked. */
  private async requestState(hostId: string, continueId: string): Promise<A2aContinueRequestState | undefined> {
    try {
      return ((await this.deps.daemonRpc(A2A_CONTINUE_RPC.state, { hostId, continueId })) as A2aContinueRequestState | undefined) ?? {};
    } catch {
      return undefined;
    }
  }

  private retryLater(key: string, continueId: string, why: string): void {
    if (this.stopped) return;
    this.deps.log('warn', `[continue] ${continueId}: not claimed now, trying again: ${why}`);
    const t = setTimeout(() => {
      this.retryTimers.delete(key);
      // Through the work list, so a request no longer received is not tried again.
      void this.refresh();
    }, this.deps.retryMs ?? CONTINUE_START_RETRY_MS);
    t.unref?.();
    this.retryTimers.set(key, t);
  }

  private samePath(a: string, b: string): boolean {
    return this.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
}

function openedPane(res: unknown): OpenedPane | null {
  if (typeof res !== 'object' || res === null) return null;
  const r = res as Record<string, unknown>;
  return typeof r['workspaceId'] === 'string' && r['workspaceId'] && typeof r['ptyId'] === 'string' && r['ptyId']
    ? { workspaceId: r['workspaceId'], ptyId: r['ptyId'] }
    : null;
}

function workspaceIdOf(res: unknown): string | null {
  const id = typeof res === 'object' && res !== null ? (res as { workspaceId?: unknown }).workspaceId : undefined;
  return typeof id === 'string' && id ? id : null;
}

function isOk(res: unknown): boolean {
  return typeof res === 'object' && res !== null && (res as { ok?: unknown }).ok === true;
}

/** The `error` a renderer answer carries (a refusal resolves, it does not throw), or null. */
function errorField(res: unknown): string | null {
  const e = typeof res === 'object' && res !== null ? (res as { error?: unknown }).error : undefined;
  return e === undefined || e === null || e === '' ? null : String(e);
}

function errorOf(res: unknown): string {
  const e = typeof res === 'object' && res !== null ? (res as { error?: unknown }).error : undefined;
  return typeof e === 'string' ? e : 'no answer';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
