// ─── task.gate.* / task.adopt / task.close / task.pr on the pipe ─────────────
//
// Closing a task, opening its PR, adopting its result and running its gate were
// all reachable from exactly one place: the Electron renderer, over ipcMain. An
// orchestrator brain is not a renderer, so it could start N tasks and then do
// nothing with any of them — it could only ask a human to click. These five
// methods are that missing half, and they are deliberately the SAME services the
// GUI drives (TaskCloseService, TaskPrService, TaskGateRunner, TaskAdoptService)
// rather than a second implementation with its own rules.
//
// The gates, in the order they run, and all of them verbatim from the fan-out
// handler next door (fanout.rpc.ts) because these calls are strictly more
// destructive than spawning a worktree:
//
//   R4 origin allowlist — `ctx.origin === 'local'` or reject. A remote caller
//      never closes a task or writes to a repository.
//   R2 identity — the caller's workspace is SERVER-RESOLVED: a commander token
//      (ctx.commanderWorkspace) outranks a stated senderPtyId, and a pane agent
//      is resolved from its verified pty. A caller-supplied
//      `verifiedWorkspaceId` is REJECTED, not ignored — being silently
//      overruled leaves a caller believing it acted as someone it is not.
//   Ownership — the task must appear in `task.mission.list` scoped to that
//      resolved workspace. That list is owner-scoped by the daemon, so "not in
//      it" covers both "no such task" and "someone else's task"; the two are
//      reported apart only where doing so leaks nothing (an unknown id is not
//      evidence of another workspace's task, because the answer is the same).
//   Materialization — close/pr/adopt/gate all need a worktree on disk. A task
//      that never materialized is refused with that reason rather than a
//      confusing git error.
//
// Approval (integration lane, superseding the "none is raised here" this file
// shipped with): `task.close` and `task.pr` DO raise a human prompt, through
// the same renderer gate fan-out uses. The reasoning that said one prompt was
// enough assumed every caller is an MCP tool behind a PreToolUse permission
// gate — but the caller these methods exist for is an orchestrator brain whose
// commander surface auto-allows its own tools (ClaudeSdkAdapter's
// DEFAULT_ALLOWED_TOOLS), so for that caller there was no first prompt to be
// the second of. Removing a worktree and pushing a branch to someone's GitHub
// are the two effects here a human cannot undo by reading a result.
//
// Gate/adopt/read stay unprompted: a gate run is reversible by ignoring it,
// adopt lands in the LOCAL repository and never pushes (`git reset --hard`
// undoes the staged default, `git reset --hard HEAD~1` the `commit: true`
// form), and the git/gh views only read.
//
// `task.close` is deliberately NOT in COMMANDER_TEARDOWN_DENY. That set is an
// unconditional refusal in RpcRouter, evaluated before any handler runs, so
// listing it would mean a brain can open tasks and never close them — the
// exact half-loop this file exists to finish. The prompt is the control
// instead; see the note on COMMANDER_TEARDOWN_DENY in commanderSurface.ts.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserWindow } from 'electron';

import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { HUMAN_WORKSPACE_ID } from '../../../shared/channels';
import { sendToRenderer } from './_bridge';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { git as runGit, type GitResult } from '../../git/git';
import { getExecEnv } from '../../../shared/execEnv';
import { metaDirForWorktree } from '../../worktask/TaskWorktreeManager';
import type { TaskCloseService } from '../../worktask/TaskCloseService';
import type { TaskPrService } from '../../worktask/TaskPrService';
import type { TaskAdoptService } from '../../worktask/TaskAdoptService';
import type { TaskGateRunner } from '../../worktask/TaskGateRunner';

const execFileAsync = promisify(execFile);

type GetWindow = () => BrowserWindow | null;

/** The five methods this file registers. Named once so the contract doc, the
 *  MCP tools and lane F's allow-list all quote the same strings. */
export const WORKTASK_RPC_METHODS = [
  'task.gate.run',
  'task.gate.cancel',
  'task.adopt',
  'task.close',
  'task.pr',
  // Read-only. These are RPCs rather than git run from inside the MCP broker
  // for one reason: the ownership check. A tool that shelled out locally would
  // first need the worktree path, and handing a caller a path to run git in is
  // the whole authorization problem over again.
  'task.git.status',
  'task.git.log',
  'task.gh.prView',
] as const;

export type WorktaskRpcMethod = (typeof WORKTASK_RPC_METHODS)[number];

/** Minimal daemon RPC surface (same shape as CloseDaemonPort). */
export interface WorktaskRpcDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Read-only process seam for the git/gh reads (injected in tests). */
export type WorktaskExec = (cmd: 'git' | 'gh', args: string[], cwd: string) => Promise<GitResult>;

/** `git log` is a listing, and an unbounded one costs the caller's context
 *  window as much as the daemon's time. */
export const TASK_GIT_LOG_MAX = 50;
export const TASK_GIT_LOG_DEFAULT = 20;

/** Field separator for the log format. A unit separator cannot occur in a
 *  commit subject, so a crafted message cannot break the parse. */
const LOG_SEP = '\u001f';

/** How long the detached approval hop may hang before the call is answered as
 *  denied. Matches the fan-out gate; the renderer dialog auto-denies sooner
 *  (30 s), so this only bounds a bridge that never answers at all. */
export const TASK_APPROVAL_TIMEOUT_MS = 45_000;

/** The destructive half of this surface — the two methods that raise a prompt.
 *  `action` is what the dialog names, so it uses the user-facing vocabulary
 *  (Orchestrator / Task / Worker), not the RPC name. */
export type TaskApprovalAction = 'close' | 'pr';

export interface TaskApprovalRequest {
  workspaceId: string;
  taskId: string;
  title: string;
  branch: string;
  worktreePath: string;
  action: TaskApprovalAction;
  /** One sentence naming what will happen if the user approves. */
  effect: string;
  /** The branch tip the user is being shown, for `task.pr`. Short hash, or ''
   *  when it could not be read. Displayed, and re-checked after the answer. */
  branchTip?: string;
}

/** How an approval ended, for the refusal message. `unavailable` is a bridge
 *  that could not be reached at all — fail closed, but say which. */
export type TaskApprovalOutcome = 'approved' | 'declined' | 'timeout' | 'unavailable';

/** An RPC that ran out of time is a TIMEOUT, not an unreachable window. The
 *  bridge rejects with this text (see pipe/handlers/_bridge.ts), and folding it
 *  into `unavailable` told operators to go looking for a dead window when what
 *  actually happened is that nobody answered. */
const RPC_TIMEOUT_RE = /\btimed?\s*-?\s*out\b|\btimeout\b/i;

/** Distinct task-approval prompts one workspace may have waiting at once. The
 *  operator answers a single shared queue, so an unbounded producer here is a
 *  denial of service against the fan-out gate next to it. */
export const TASK_APPROVALS_MAX_PENDING_PER_WORKSPACE = 3;

/** Raise the prompt; anything that is not an explicit approval is a refusal. */
export type TaskApprovalPort = (request: TaskApprovalRequest) => Promise<TaskApprovalOutcome>;

const APPROVAL_DENY_MESSAGE: Record<Exclude<TaskApprovalOutcome, 'approved'>, string> = {
  declined: 'the user denied it',
  timeout: 'the approval prompt expired with no answer (no one was at the keyboard)',
  unavailable: 'the approval prompt could not be shown (the wmux window is unavailable)',
};

/**
 * The default port: the renderer's shared approval queue, the same one the
 * fan-out gate goes through, so one dialog and one timer serve both. Never
 * throws — a bridge failure is `unavailable`, which refuses.
 */
function rendererApprovalPort(getWindow: GetWindow): TaskApprovalPort {
  return async (request: TaskApprovalRequest): Promise<TaskApprovalOutcome> => {
    let verdict: { approved?: unknown; outcome?: unknown } | null = null;
    try {
      verdict = (await sendToRenderer(getWindow, 'task.requestApproval', { ...request }, {
        timeoutMs: TASK_APPROVAL_TIMEOUT_MS,
      })) as { approved?: unknown; outcome?: unknown } | null;
    } catch (err) {
      // Two different failures wear one rejection here: no window to ask
      // (unavailable) and a window that never answered (timeout). They send an
      // operator to different places, so they are reported apart.
      return RPC_TIMEOUT_RE.test(err instanceof Error ? err.message : String(err))
        ? 'timeout'
        : 'unavailable';
    }
    if (!verdict) return 'unavailable';
    if (verdict.approved === true) return 'approved';
    return verdict.outcome === 'timeout' ? 'timeout' : 'declined';
  };
}

export interface WorktaskRpcDeps {
  daemon: WorktaskRpcDaemonPort;
  getWindow: GetWindow;
  /** MUST be the same instances the renderer IPC handler drives. */
  close: TaskCloseService;
  pr: TaskPrService;
  adopt: TaskAdoptService;
  gate: TaskGateRunner;
  /** The daemon's own workspace id, used as the `system` actor on ledger
   *  writes. Defaults to 'ws-daemon'. */
  systemWorkspaceId?: string;
  /** Injected for tests; defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
  /** Injected for tests; defaults to the shared argv-only git helper. */
  exec?: WorktaskExec;
  /** Injected for tests; defaults to the renderer approval queue. */
  requestApproval?: TaskApprovalPort;
}

/** Projection task, minimal shape (task.mission.list). */
interface ProjectionTask {
  id: string;
  title: string;
  status: 'open' | 'closed';
  branch?: string;
  worktreePath?: string;
  detachedAt?: number;
}

/** Typed wire error, shaped like the fan-out / mission envelopes so MCP tools
 *  can branch on `error.code` instead of parsing prose. */
function deny(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

/**
 * The caller's own tasks, or WHY we could not ask. Collapsing a daemon outage
 * into `[]` made every method answer NOT_FOUND — "no such task" — for a task
 * that plainly exists, which is the one answer that tells a caller to stop
 * retrying and go looking for a bug in its own bookkeeping.
 */
async function listMissions(
  daemon: WorktaskRpcDaemonPort,
  verifiedWorkspaceId: string,
): Promise<{ tasks: ProjectionTask[] } | { code: string; message: string }> {
  let res: { ok?: boolean; tasks?: ProjectionTask[]; error?: { message?: unknown } } | undefined;
  try {
    res = (await daemon.rpc('task.mission.list', { verifiedWorkspaceId })) as typeof res;
  } catch (err) {
    return {
      code: 'UNAVAILABLE',
      message: `could not reach the daemon to list your tasks: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res || res.ok !== true || !Array.isArray(res.tasks)) {
    const detail = typeof res?.error?.message === 'string' ? `: ${res.error.message}` : '';
    return { code: 'UNAVAILABLE', message: `the daemon could not list your tasks${detail}` };
  }
  return { tasks: res.tasks };
}

/**
 * R2 — the caller's workspace, server-resolved. A validated commander binding
 * outranks a stated senderPtyId (the token is the stronger claim, and honouring
 * the pty field for a brain would let it aim at a workspace it is not bound to).
 */
async function resolveCaller(
  getWindow: GetWindow,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
): Promise<{ workspaceId: string } | { code: string; message: string }> {
  if (params['verifiedWorkspaceId'] !== undefined) {
    return {
      code: 'INVALID_ARGUMENT',
      message: 'this method does not accept verifiedWorkspaceId — your workspace is resolved from your verified caller',
    };
  }
  const commanderWorkspaceId = ctx?.commanderWorkspace ?? '';
  const senderPtyId = commanderWorkspaceId
    ? ''
    : typeof params['senderPtyId'] === 'string'
      ? params['senderPtyId'].trim()
      : '';
  let workspaceId = commanderWorkspaceId;
  if (!workspaceId && senderPtyId) {
    try {
      workspaceId = (await resolvePtyOwnerWorkspace(getWindow, senderPtyId)) ?? '';
    } catch {
      workspaceId = '';
    }
  }
  if (!workspaceId) {
    return { code: 'NOT_AUTHORIZED', message: 'a verifiable caller is required (no resolvable senderPtyId)' };
  }
  if (workspaceId === HUMAN_WORKSPACE_ID) {
    return { code: 'NOT_AUTHORIZED', message: `'${HUMAN_WORKSPACE_ID}' is the reserved human workspace` };
  }
  return { workspaceId };
}

/**
 * The caller + the task it named, or the wire error to answer with.
 *
 * `requireLive` is for the methods that ACT on a task (gate, adopt, PR). A
 * closed task's worktree has been removed and a detached one has been handed
 * away deliberately — running a gate in either is at best a confusing git error
 * and at worst work done in a directory nobody is watching. The read-only
 * methods and `task.close` itself do not set it: reading a finished task is
 * useful, and closing an already-closed one is how the cleanup scan
 * reconciles.
 */
async function resolveOwnedTask(
  deps: WorktaskRpcDeps,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
  requireLive = false,
): Promise<{ workspaceId: string; task: ProjectionTask } | { code: string; message: string }> {
  const taskId = typeof params['taskId'] === 'string' ? params['taskId'].trim() : '';
  if (!taskId) return { code: 'INVALID_ARGUMENT', message: 'taskId is required' };

  const caller = await resolveCaller(deps.getWindow, params, ctx);
  if (!('workspaceId' in caller)) return caller;

  const listed = await listMissions(deps.daemon, caller.workspaceId);
  if (!('tasks' in listed)) return listed;
  const task = listed.tasks.find((t) => t.id === taskId);
  if (!task) {
    // Owner-scoped list: unknown id and another workspace's id are the same
    // answer, and saying which would confirm a task exists elsewhere.
    return {
      code: 'NOT_FOUND',
      message: `no task '${taskId}' is owned by your workspace — list your tasks to see the ones you may act on`,
    };
  }
  if (requireLive && task.detachedAt !== undefined) {
    return {
      code: 'FAILED_PRECONDITION',
      message: `task '${taskId}' was detached — its worktree is no longer this orchestrator's to act on`,
    };
  }
  if (requireLive && task.status !== 'open') {
    return {
      code: 'FAILED_PRECONDITION',
      message: `task '${taskId}' is closed; reopen the work as a new task rather than acting on a closed one`,
    };
  }
  return { workspaceId: caller.workspaceId, task };
}

/** Repo root + repoHash for a task worktree. Same derivation (and same hash
 *  rule: sha256 of the realpath, 12 chars) the IPC close path uses, so the
 *  worktree mutex key matches whichever surface closed the task. */
async function resolveRepoInfo(worktreePath: string): Promise<{ repoRoot: string; repoHash: string } | null> {
  let commonDir = '';
  const modern = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath);
  if (modern.code === 0) {
    commonDir = modern.stdout.trim();
  } else {
    const legacy = await runGit(['rev-parse', '--git-common-dir'], worktreePath);
    if (legacy.code !== 0) return null;
    const raw = legacy.stdout.trim();
    commonDir = raw ? path.resolve(worktreePath, raw) : '';
  }
  if (!commonDir) return null;
  const top = await runGit(['rev-parse', '--show-toplevel'], path.dirname(commonDir));
  if (top.code !== 0) return null;
  const repoRoot = top.stdout.trim();
  if (!repoRoot) return null;
  let real = repoRoot;
  try {
    real = fs.realpathSync(repoRoot);
  } catch {
    // Unresolvable symlink — hash the path we have; the IPC path does the same.
  }
  return { repoRoot, repoHash: crypto.createHash('sha256').update(real).digest('hex').slice(0, 12) };
}

/**
 * `git`/`gh` with the same contract as the shared git helper: argv only, cwd
 * fixed, never throws — a non-zero exit is DATA, because "gh is not installed"
 * and "there is no PR" are answers a caller acts on, not transport failures.
 */
async function runGitLike(cmd: 'git' | 'gh', args: string[], cwd: string): Promise<GitResult> {
  if (cmd === 'git') return runGit(args, cwd);
  try {
    const { stdout, stderr } = await execFileAsync(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
      cwd,
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...getExecEnv(), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' },
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(e), code: typeof err.code === 'number' ? err.code : 1 };
  }
}

/**
 * `git status --porcelain=v1 --branch -z` → structured.
 *
 * NUL-framed, not line-split. Without `-z` git QUOTES any path that is not
 * plain ASCII (`"src/\303\251.ts"`) and a path containing a newline arrives as
 * two lines — so a caller acting on `files[].path` was handed names that do not
 * exist on disk. The branch header is the first record; a rename carries its
 * source in the FOLLOWING record, which is consumed with it.
 */
export function parseGitStatus(stdout: string): {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  files: { status: string; path: string }[];
} {
  const records = stdout.split('\0').filter((r) => r.length > 0);
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] as string;
    if (rec.startsWith('## ')) {
      const header = rec.slice(3);
      const nameEnd = header.indexOf(' [');
      const name = nameEnd === -1 ? header : header.slice(0, nameEnd);
      branch = name.split('...')[0]?.trim() ?? '';
      const aheadMatch = /ahead (\d+)/.exec(header);
      const behindMatch = /behind (\d+)/.exec(header);
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      behind = behindMatch ? Number(behindMatch[1]) : 0;
      continue;
    }
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2);
    files.push({ status, path: rec.slice(3) });
    // R/C put the ORIGIN path in the next record — it is part of this entry,
    // not a file of its own.
    if (status[0] === 'R' || status[0] === 'C') i += 1;
  }
  return { branch, ahead, behind, clean: files.length === 0, files };
}

/**
 * The worktree's current HEAD, short. `''` when git could not answer — which
 * the caller treats as "unknown", and an unknown tip that stays unknown is
 * still equal to itself, so a repo git cannot read at all does not become an
 * unexplainable refusal. (It fails the other way — a repo that starts
 * unreadable and becomes readable refuses once, which is the safe direction.)
 */
async function branchTip(exec: WorktaskExec, worktreePath: string | undefined): Promise<string> {
  if (!worktreePath) return '';
  const res = await exec('git', ['rev-parse', '--short', 'HEAD'], worktreePath);
  return res.code === 0 ? res.stdout.trim() : '';
}

/** The `%H\x1f%an\x1f%aI\x1f%s` lines `task.git.log` asks for. */
export function parseGitLog(stdout: string): { hash: string; author: string; date: string; subject: string }[] {
  return stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      const [hash = '', author = '', date = '', subject = ''] = line.split('\u001f');
      return { hash, author, date, subject };
    });
}

/**
 * Register the task-lifecycle pipe methods. `close`, `pr` and `gate` MUST be
 * the same service instances the renderer IPC handler uses — TaskWorktreeManager
 * keeps a per-repo mutex chain, and two instances would race for git's
 * index.lock.
 *
 */
export function registerWorktaskRpc(router: RpcRouter, deps: WorktaskRpcDeps): void {
  const systemWorkspaceId = deps.systemWorkspaceId ?? 'ws-daemon';
  const fileExists = deps.fileExists ?? ((p: string) => fs.existsSync(p));
  // `gh` rides the same argv-only helper as git — no shell, no interpolation.
  // Only non-interactive read subcommands are used, so there is no prompt to
  // disable.
  const exec: WorktaskExec = deps.exec ?? ((cmd, args, cwd) => runGitLike(cmd, args, cwd));
  const requestApproval: TaskApprovalPort = deps.requestApproval ?? rendererApprovalPort(deps.getWindow);
  const register = (method: WorktaskRpcMethod, handler: Parameters<RpcRouter['register']>[1]): void =>
    router.register(method, handler);

  // ── Pending-prompt bookkeeping ──────────────────────────────────────────
  //
  // A brain that retries in a loop would otherwise stack one dialog per call:
  // the same question, N times, and every one of them competing with the
  // fan-out gate for the operator's single approval queue. Two rules:
  //
  //   DEDUPE — an identical (workspace, task, action) already on screen is the
  //     SAME question, so the retry joins that prompt instead of raising a
  //     second one. One answer settles every caller waiting on it, which is
  //     also the honest semantics: the user was asked once.
  //   CAP — a per-workspace ceiling on distinct pending prompts, so a caller
  //     cycling task ids cannot fill the queue and starve a fan-out approval.
  //     Over the cap the call is refused immediately rather than queued.
  const inFlightApprovals = new Map<string, Promise<TaskApprovalOutcome>>();
  const pendingPerWorkspace = new Map<string, number>();

  /**
   * Ask the human, and turn anything short of an explicit approval into the
   * wire refusal. The summary is built from the SERVER's own projection row —
   * title, branch, worktree — so what the dialog shows is what the handler is
   * about to act on, never a caller-supplied description of it.
   */
  const approve = async (
    action: TaskApprovalAction,
    workspaceId: string,
    task: ProjectionTask,
    effect: string,
    extra: { branchTip?: string } = {},
  ): Promise<{ ok: false; error: { code: string; message: string } } | null> => {
    const key = `${workspaceId} ${task.id} ${action}`;
    let pending = inFlightApprovals.get(key);
    if (!pending) {
      const open = pendingPerWorkspace.get(workspaceId) ?? 0;
      if (open >= TASK_APPROVALS_MAX_PENDING_PER_WORKSPACE) {
        return deny(
          'RESOURCE_EXHAUSTED',
          `your workspace already has ${open} task approvals waiting for an answer ` +
            `(cap ${TASK_APPROVALS_MAX_PENDING_PER_WORKSPACE}) — answer or let those expire before asking for more`,
        );
      }
      pendingPerWorkspace.set(workspaceId, open + 1);
      pending = requestApproval({
        workspaceId,
        taskId: task.id,
        title: task.title,
        branch: task.branch ?? '',
        worktreePath: task.worktreePath ?? '',
        action,
        effect,
        ...(extra.branchTip !== undefined ? { branchTip: extra.branchTip } : {}),
      }).finally(() => {
        inFlightApprovals.delete(key);
        const left = (pendingPerWorkspace.get(workspaceId) ?? 1) - 1;
        if (left > 0) pendingPerWorkspace.set(workspaceId, left);
        else pendingPerWorkspace.delete(workspaceId);
      });
      inFlightApprovals.set(key, pending);
    }
    const outcome = await pending;
    if (outcome === 'approved') return null;
    return deny('NOT_AUTHORIZED', `task.${action} needs a human approval and ${APPROVAL_DENY_MESSAGE[outcome]}`);
  };

  const localOnly = (ctx: RpcContext | undefined, method: string): { ok: false; error: { code: string; message: string } } | null =>
    ctx?.origin === 'local'
      ? null
      : deny('NOT_AUTHORIZED', `${method} is local-origin only (remote callers cannot act on tasks)`);

  // ── task.gate.run ────────────────────────────────────────────────────
  register('task.gate.run', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.gate.run');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx, true);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task } = owned;
    if (!task.worktreePath || !fileExists(task.worktreePath)) {
      return deny('FAILED_PRECONDITION', `task '${task.id}' has no worktree on disk, so there is nothing to run a gate in`);
    }
    // The wmux.json trust verdict is keyed by the path the USER approved — the
    // parent repository — not by a wtask/ worktree the daemon minted minutes
    // ago. Resolved here and handed to the runner, which reads the config there
    // and still RUNS the gate in the worktree.
    const repo = await resolveRepoInfo(task.worktreePath);
    const result = await deps.gate.run({
      taskId: task.id,
      worktreePath: task.worktreePath,
      systemWorkspaceId,
      ...(repo ? { projectRoot: repo.repoRoot } : {}),
    });
    // `busy` and `refused` are answers, not transport failures — the envelope
    // carries them so a poller can tell them apart without parsing text.
    return result.ok ? { ...result, title: task.title } : result;
  });

  // ── task.gate.cancel ─────────────────────────────────────────────────
  register('task.gate.cancel', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.gate.cancel');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    // Cancelling a gate that is not running is not an error: a caller racing a
    // gate that just finished should read `cancelled: false`, not a failure.
    return { ok: true as const, taskId: owned.task.id, cancelled: deps.gate.cancel(owned.task.id) };
  });

  // ── task.adopt ───────────────────────────────────────────────────────
  register('task.adopt', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.adopt');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx, true);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task } = owned;
    if (!task.worktreePath || !fileExists(task.worktreePath)) {
      return deny('FAILED_PRECONDITION', `task '${task.id}' has no worktree on disk, so it has produced nothing to adopt`);
    }
    // Opt-in, and rejected rather than coerced: a caller sending `"true"` and
    // silently getting the staged default would discover it one adopt later,
    // as a dirty-target refusal it cannot explain.
    const rawCommit = params['commit'];
    if (rawCommit !== undefined && typeof rawCommit !== 'boolean') {
      return deny('INVALID_ARGUMENT', 'commit must be a boolean');
    }
    // The title comes from the SERVER's projection row, never from params — the
    // commit subject names what the daemon believes this task is.
    return deps.adopt.adopt({
      taskId: task.id,
      worktreePath: task.worktreePath,
      commit: rawCommit === true,
      title: task.title,
    });
  });

  // ── task.close ───────────────────────────────────────────────────────
  // Teardown-class: it removes a git worktree. TaskCloseService owns the order
  // contract (unpushed check → remove → mission.close → meta cleanup) and both
  // the dirty and unpushed refusals; this handler adds identity and the repo
  // derivation and changes none of it.
  register('task.close', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.close');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task, workspaceId } = owned;

    // Asked BEFORE the ordering contract starts, so a denial leaves the task
    // exactly as it was — TaskCloseService's first step is the unpushed check,
    // and after that the worktree removal is under way.
    const refused = await approve(
      'close',
      workspaceId,
      task,
      task.worktreePath
        ? `remove the worktree at ${task.worktreePath} and close the task (refused if the branch is dirty or has unpushed commits)`
        : 'close the task (it has no worktree on disk)',
    );
    if (refused) return refused;

    if (!task.worktreePath || !fileExists(task.worktreePath)) {
      // Nothing on disk to remove — close-only, exactly as the IPC path
      // reconciles an unmaterialized or already-deleted task.
      return deps.close.closeTask({ taskId: task.id, verifiedWorkspaceId: workspaceId });
    }
    const repo = await resolveRepoInfo(task.worktreePath);
    if (!repo) return deps.close.closeTask({ taskId: task.id, verifiedWorkspaceId: workspaceId });
    return deps.close.closeTask({
      taskId: task.id,
      verifiedWorkspaceId: workspaceId,
      repoRoot: repo.repoRoot,
      repoHash: repo.repoHash,
      worktreePath: task.worktreePath,
      metaDir: metaDirForWorktree(task.worktreePath),
    });
  });

  // ── task.pr ──────────────────────────────────────────────────────────
  register('task.pr', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.pr');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx, true);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task, workspaceId } = owned;
    if (!task.worktreePath || !task.branch) {
      return deny(
        'FAILED_PRECONDITION',
        `task '${task.id}' has no worktree and branch yet, so there is no branch to open a PR from`,
      );
    }
    // A push leaves the machine: once the branch is on the remote, no result
    // this call returns can take it back.
    //
    // The prompt is not instantaneous — up to 45 s — and the worker owning this
    // worktree is still running. Approving "push wtask/lane-one" and then
    // pushing whatever that branch points at half a minute later is approving a
    // name, not a change. So the tip is captured NOW, shown in the dialog, and
    // required to still be the tip afterwards; a moved branch is refused rather
    // than pushed, and the caller can ask again against what it can now see.
    const tipBefore = await branchTip(exec, task.worktreePath);
    const refused = await approve(
      'pr',
      workspaceId,
      task,
      `push the branch ${task.branch} to its remote and open a pull request for it`,
      { branchTip: tipBefore },
    );
    if (refused) return refused;
    const tipAfter = await branchTip(exec, task.worktreePath);
    if (tipBefore !== tipAfter) {
      return deny(
        'ABORTED',
        `the branch moved while the approval was on screen (${tipBefore || 'unknown'} → ${tipAfter || 'unknown'}), ` +
          'so what was approved is not what would be pushed — read the new state and ask again',
      );
    }
    const body = typeof params['body'] === 'string' ? params['body'] : undefined;
    return deps.pr.createPr({
      taskId: task.id,
      verifiedWorkspaceId: workspaceId,
      worktreePath: task.worktreePath,
      branch: task.branch,
      title: task.title,
      ...(body !== undefined ? { body } : {}),
    });
  });

  // ── task.git.status ──────────────────────────────────────────────────
  // Read-only, and the reason the destructive methods above can be terse: a
  // brain that can SEE a task's worktree state stops guessing at it from pane
  // screens, and stops calling task.close to find out whether it was dirty.
  register('task.git.status', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.git.status');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task } = owned;
    if (!task.worktreePath || !fileExists(task.worktreePath)) {
      return deny('FAILED_PRECONDITION', `task '${task.id}' has no worktree on disk`);
    }
    const res = await exec('git', ['status', '--porcelain=v1', '--branch', '-z'], task.worktreePath);
    if (res.code !== 0) {
      return { ok: false as const, taskId: task.id, reason: 'git-failed' as const, error: res.stderr.trim() };
    }
    return { ok: true as const, taskId: task.id, worktreePath: task.worktreePath, ...parseGitStatus(res.stdout) };
  });

  // ── task.git.log ─────────────────────────────────────────────────────
  register('task.git.log', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.git.log');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task } = owned;
    if (!task.worktreePath || !fileExists(task.worktreePath)) {
      return deny('FAILED_PRECONDITION', `task '${task.id}' has no worktree on disk`);
    }
    const raw = params['limit'];
    if (raw !== undefined && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1)) {
      return deny('INVALID_ARGUMENT', 'limit must be a positive integer');
    }
    // Clamped rather than rejected at the top end: a caller asking for 500
    // commits wants "as many as I can have", and refusing the whole call helps
    // nobody. The number that actually ran is reported back.
    const limit = Math.min(typeof raw === 'number' ? raw : TASK_GIT_LOG_DEFAULT, TASK_GIT_LOG_MAX);
    const res = await exec(
      'git',
      ['log', `-n`, String(limit), `--format=%H${LOG_SEP}%an${LOG_SEP}%aI${LOG_SEP}%s`],
      task.worktreePath,
    );
    if (res.code !== 0) {
      return { ok: false as const, taskId: task.id, reason: 'git-failed' as const, error: res.stderr.trim() };
    }
    return { ok: true as const, taskId: task.id, limit, commits: parseGitLog(res.stdout) };
  });

  // ── task.gh.prView ───────────────────────────────────────────────────
  // Errors as DATA: `gh` missing, unauthenticated, or simply no PR for this
  // branch are all things a caller acts on, and turning them into a transport
  // error would make "there is no PR yet" indistinguishable from "the call
  // broke".
  register('task.gh.prView', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.gh.prView');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task } = owned;
    if (!task.worktreePath || !fileExists(task.worktreePath)) {
      return deny('FAILED_PRECONDITION', `task '${task.id}' has no worktree on disk`);
    }
    const res = await exec(
      'gh',
      ['pr', 'view', '--json', 'number,title,state,url,isDraft,headRefName,mergeStateStatus'],
      task.worktreePath,
    );
    if (res.code !== 0) {
      return {
        ok: false as const,
        taskId: task.id,
        reason: 'no-pr' as const,
        error: res.stderr.trim() || 'gh could not report a pull request for this branch',
      };
    }
    try {
      return { ok: true as const, taskId: task.id, pr: JSON.parse(res.stdout) as unknown };
    } catch {
      return { ok: false as const, taskId: task.id, reason: 'gh-failed' as const, error: 'gh returned unparseable JSON' };
    }
  });
}
