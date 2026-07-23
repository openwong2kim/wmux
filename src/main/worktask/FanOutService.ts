/**
 * FanOutService — J1 §2 D2. Orchestrates 1 prompt → N isolated tasks (main).
 *
 * Spawn requires fs (git worktree) and the renderer bridge entirely; the daemon has neither (daemon = source of truth + channels).
 * Spawn path is fixed via renderer only (§2 G4 — no inventing main-internal bridges). The workspace
 * tree source of truth is the renderer store (session.json), so main bridges that bypass that source of truth are not
 * created. This service only assembles daemon RPC (mission.start/update/invite) and renderer spawn RPC.
 *
 * Sequence (§2 — per task):
 *   ⓪ Preflight (repo validity once — if ineligible, zero tasks created)
 *   ① mission.start (idempotency key `{fanoutKey}-{k}`) → taskId·channelId
 *   ② worktree creation (TaskWorktreeManager — dedicated root·serial queue)
 *   ③ renderer spawn (workspace + agent pane, cwd=worktreePath, initialCommand) →
 *      recover actual workspaceId from response (handshake C3)
 *   ④ task.update({branch, worktreePath, paneGroupId=workspaceId}) materialization
 *   ⑤ channel invite (task workspace as mission channel member — failure non-fatal) + spawn fires
 *      initialCommand (`{agentCmd} "$(cat '{promptPath}')"` — path single-quote quoting)
 *
 * Failure compensation (per-task atomicity): on ②~④ failure, only that task gets mission.close (channel archive
 * included) + worktree is not deleted but recorded in preserve list. Other tasks continue. fan-out
 * allows partial success overall.
 *
 * fanout:start call idempotency (§2 G1 CRITICAL): key→result LRU, same key re-call = return previous result,
 * in-flight duplicate = reject.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FANOUT_MAX_TASKS,
  FANOUT_PROMPT_MAX_BYTES,
  WORKTASK_IDEMPOTENCY_CAP,
  WORKTASK_META_FILENAME,
  type WorkTaskMetaStamp,
} from '../../shared/workTask';
import { TaskWorktreeManager } from './TaskWorktreeManager';
import type { TaskWorktreePlan } from './TaskWorktreeManager';

/** Minimal daemon RPC surface (injectable for tests). Subset of daemonClient.rpc. */
export interface FanOutDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Minimal renderer spawn surface (sendToRenderer wrapper — injectable for tests). */
export interface FanOutRendererPort {
  /**
   * Spawn dedicated workspace + agent pane. cwd=worktreePath, initialCommand fires
   * the prompt. Recover and return actual workspaceId (handshake C3).
   */
  spawnWorkspace(params: {
    name: string;
    cwd: string;
    initialCommand: string;
  }): Promise<{ workspaceId: string; ptyId?: string } | { error: string }>;
}

/** fan-out call input (renderer dialog → IPC). */
export interface FanOutRequest {
  /** Per-call idempotency key (issued once on renderer submit — §2 G1). */
  idempotencyKey: string;
  /** Shared prompt body (cap FANOUT_PROMPT_MAX_BYTES). Optional — may be empty. */
  prompt: string;
  /** Per-task title (length = N). N is determined by title array length. */
  titles: string[];
  /** Per-task individual prompt (index-aligned with titles, optional). Effective prompt is
   *  `shared + "\n\n" + individual` (omit empty side). **Does not reject when both shared
   *  and individual are empty** — opening only worktree·branch·agent pane (environment-only)
   *  for manual prompt entry is valid (§7). Rejects entire fan-out only when combined result
   *  exceeds cap (no partial spawn). */
  taskPrompts?: string[];
  /** Repo path (defaults to active workspace cwd — filled by renderer). */
  repoPath: string;
  /** Agent command (default 'claude'). */
  agentCmd: string;
  /** Renderer-trusted identity (same trust basis as channelLocal — process boundary). */
  verifiedWorkspaceId: string;
  /** Mission channel member coordinates (creator memberId — default verifiedWorkspaceId). */
  memberId?: string;
}

/** Per-task result (report — status distinction). */
export interface FanOutTaskResult {
  index: number;
  title: string;
  ok: boolean;
  taskId?: string;
  channelId?: string;
  workspaceId?: string;
  /** Agent pane ptyId (spawnWorkspace return — §3 onExhausted toast mapping material).
   *  When absent from renderer, unmapped tasks skip toast — best-effort). */
  ptyId?: string;
  /** F2 — fired initialCommand (agent launch + prompt injection). Material for retry to
   *  resend this command instead of raw prompt (prevents bare shell executing prompt). */
  initialCommand?: string;
  worktreePath?: string;
  branch?: string;
  /** Failure reason (ok=false). */
  error?: string;
  /** ④ task.update failed to commit (unmaterialized — §2 crash window contract). */
  unmaterialized?: boolean;
  /** ⑤ channel invite failed (agent works, channel send missing — non-fatal). */
  channelDisconnected?: boolean;
  /** Preserved worktree path on compensation (not deleted — J3 recovery scope). */
  preservedWorktree?: string;
}

export interface FanOutResult {
  ok: boolean;
  /** Whole fan-out rejection reason e.g. preflight ineligible (zero tasks created). */
  error?: string;
  tasks: FanOutTaskResult[];
}

export interface FanOutServiceOptions {
  daemon: FanOutDaemonPort;
  renderer: FanOutRendererPort;
  worktrees?: TaskWorktreeManager;
}

export class FanOutService {
  private readonly daemon: FanOutDaemonPort;
  private readonly renderer: FanOutRendererPort;
  private readonly worktrees: TaskWorktreeManager;

  /** §2 G1 idempotency: key → completed result LRU. Same key re-call returns previous result. */
  private readonly results = new Map<string, FanOutResult>();
  /** §2 G1 in-flight: keys in progress (duplicate calls rejected). */
  private readonly inFlight = new Set<string>();

  constructor(opts: FanOutServiceOptions) {
    this.daemon = opts.daemon;
    this.renderer = opts.renderer;
    this.worktrees = opts.worktrees ?? new TaskWorktreeManager();
  }

  /**
   * fan-out entry point. Call idempotency (§2 G1): same key returns completed result, in-flight duplicate rejected.
   */
  async start(req: FanOutRequest): Promise<FanOutResult> {
    const key = req.idempotencyKey;
    if (!key || key.trim().length === 0) {
      return { ok: false, error: 'fanout:start requires an idempotencyKey', tasks: [] };
    }
    // Completed same key → return previous result (no re-run).
    const cached = this.results.get(key);
    if (cached) return cached;
    // in-flight duplicate → reject.
    if (this.inFlight.has(key)) {
      return { ok: false, error: `fanout:start: idempotency key ${key} is already in flight`, tasks: [] };
    }

    this.inFlight.add(key);
    try {
      const result = await this.run(req);
      // Store completed result (LRU cap).
      this.recordResult(key, result);
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async run(req: FanOutRequest): Promise<FanOutResult> {
    // ── Input validation ──
    // title·individual prompt are index-aligned pairs — zip before filtering empty titles
    // so alignment is not broken (misdelivering individual prompt to wrong task is fatal).
    const rawPrompts = Array.isArray(req.taskPrompts) ? req.taskPrompts : [];
    const entries = req.titles
      .map((t, k) => ({
        title: typeof t === 'string' ? t.trim() : '',
        taskPrompt: typeof rawPrompts[k] === 'string' ? rawPrompts[k].trim() : '',
      }))
      .filter((e) => e.title.length > 0);
    const n = entries.length;
    if (n === 0) {
      return { ok: false, error: 'fanout:start: at least one task title is required', tasks: [] };
    }
    if (n > FANOUT_MAX_TASKS) {
      return { ok: false, error: `fanout:start: task count ${n} exceeds cap ${FANOUT_MAX_TASKS}`, tasks: [] };
    }
    const sharedPrompt = (typeof req.prompt === 'string' ? req.prompt : '').trim();
    // Per-task effective prompt = shared + individual (omit empty side). Does not reject when both empty —
    // "environment-only" (open worktree·branch·workspace only, human enters prompt) is
    // valid (§7 review). Rejects entire fan-out only on cap exceed (no partial spawn — same shape as preflight
    // "zero tasks created" contract).
    const effectivePrompts: string[] = [];
    for (const [k, e] of entries.entries()) {
      const combined = [sharedPrompt, e.taskPrompt].filter((p) => p.length > 0).join('\n\n');
      if (Buffer.byteLength(combined, 'utf8') > FANOUT_PROMPT_MAX_BYTES) {
        return {
          ok: false,
          error: `fanout:start: task ${k + 1} prompt exceeds ${FANOUT_PROMPT_MAX_BYTES} bytes; shorten it and reference details from a file path`,
          tasks: [],
        };
      }
      effectivePrompts.push(combined);
    }
    const titles = entries.map((e) => e.title);
    const verifiedWorkspaceId = typeof req.verifiedWorkspaceId === 'string' ? req.verifiedWorkspaceId.trim() : '';
    if (!verifiedWorkspaceId) {
      return { ok: false, error: 'fanout:start: verifiedWorkspaceId is required', tasks: [] };
    }
    const agentCmd = typeof req.agentCmd === 'string' && req.agentCmd.trim().length > 0 ? req.agentCmd.trim() : 'claude';
    const memberId = req.memberId && req.memberId.length > 0 ? req.memberId : verifiedWorkspaceId;

    // ── ⓪ Preflight (§2 — repo validity once upfront. Ineligible → zero tasks created) ──
    // repo validity·bare·submodule·LFS are taskId-independent so fixed on first item. But
    // slug derivation·path length·branch conflict vary per title (F3 2-model review) so titles
    // are all pre-validated — if any is ineligible, reject all N before mission.start to honor
    // "ineligible → zero tasks created" contract. Real taskId not yet available so use per-index
    // placeholders to derive·validate slug/path/branch.
    for (const [k, preflightTitle] of titles.entries()) {
      const placeholder = `wtask-preflight-${String(k).padStart(8, '0')}`;
      const pf = await this.worktrees.preflight(req.repoPath, preflightTitle, placeholder, {
        checkBranchConflict: true,
      });
      if (!pf.ok) {
        return { ok: false, error: `fanout preflight failed (task ${k + 1}): ${pf.error}`, tasks: [] };
      }
    }

    // ── Sequential task processing (serial queue already enforced, spawn load also serial) ──
    const tasks: FanOutTaskResult[] = [];
    for (const [k, title] of titles.entries()) {
      const missionIdemKey = `${req.idempotencyKey}-${k}`;
      const r = await this.spawnOne({
        index: k,
        title,
        prompt: effectivePrompts[k],
        agentCmd,
        repoPath: req.repoPath,
        verifiedWorkspaceId,
        memberId,
        missionIdemKey,
      });
      tasks.push(r);
    }

    const allOk = tasks.every((t) => t.ok);
    return { ok: allOk, tasks };
  }

  /** Spawn one task (①~⑤). Per-task compensation on failure. */
  private async spawnOne(ctx: {
    index: number;
    title: string;
    prompt: string;
    agentCmd: string;
    repoPath: string;
    verifiedWorkspaceId: string;
    memberId: string;
    missionIdemKey: string;
  }): Promise<FanOutTaskResult> {
    const base: FanOutTaskResult = { index: ctx.index, title: ctx.title, ok: false };

    // ① mission.start — acquire taskId·channelId (pass idempotency key).
    let taskId: string;
    let channelId: string;
    try {
      const started = (await this.daemon.rpc('task.mission.start', {
        title: ctx.title,
        verifiedWorkspaceId: ctx.verifiedWorkspaceId,
        memberId: ctx.memberId,
        idempotencyKey: ctx.missionIdemKey,
      })) as { ok?: boolean; taskId?: string; channelId?: string; error?: unknown };
      if (!started?.ok || !started.taskId || !started.channelId) {
        return { ...base, error: `mission.start failed: ${describeErr(started?.error)}` };
      }
      taskId = started.taskId;
      channelId = started.channelId;
    } catch (err) {
      return { ...base, error: `mission.start threw: ${(err as Error).message}` };
    }
    base.taskId = taskId;
    base.channelId = channelId;

    // ② worktree creation (dedicated root·serial queue). Re-run preflight with per-task taskId to
    //    finalize real slug·path (bare/submodule/LFS already caught at ⓪ so re-check is cheap).
    const pf = await this.worktrees.preflight(ctx.repoPath, ctx.title, taskId);
    if (!pf.ok) {
      await this.compensate(taskId, ctx.verifiedWorkspaceId);
      return { ...base, error: `worktree preflight failed: ${pf.error}` };
    }
    const plan: TaskWorktreePlan = pf.plan;
    const created = await this.worktrees.createWorktree(plan);
    if (!created.ok) {
      await this.compensate(taskId, ctx.verifiedWorkspaceId);
      return { ...base, error: `worktree create failed: ${created.error}` };
    }
    base.worktreePath = plan.worktreePath;
    base.branch = plan.branch;

    // Prompt file (omit if empty — §7 "environment-only") + task.json stamp to task meta
    // directory (outside worktree — diff cleanliness §4). task.json (J3 §1 CL5) is disk source-of-truth
    // sidecar to reverse-trace worktrees under dedicated root by taskId·title after projection
    // GC.
    let promptPath: string | undefined;
    try {
      fs.mkdirSync(plan.metaDir, { recursive: true });
      if (ctx.prompt.length > 0) {
        promptPath = path.join(plan.metaDir, 'prompt.md');
        fs.writeFileSync(promptPath, ctx.prompt, 'utf8');
      }
      const stamp: WorkTaskMetaStamp = { taskId, title: ctx.title, createdAt: Date.now() };
      fs.writeFileSync(path.join(plan.metaDir, WORKTASK_META_FILENAME), JSON.stringify(stamp), 'utf8');
    } catch (err) {
      await this.compensate(taskId, ctx.verifiedWorkspaceId, plan);
      return { ...base, error: `prompt file write failed: ${(err as Error).message}`, preservedWorktree: plan.worktreePath };
    }

    // ③ renderer spawn — dedicated workspace + agent pane. cwd=worktreePath,
    //    initialCommand=`{agentCmd} "$(cat '{promptPath}')"` (path quoting) — when no prompt,
    //    agentCmd only with no args (human enters in pane). Recover actual workspaceId.
    const initialCommand = buildInitialCommand(ctx.agentCmd, promptPath);
    base.initialCommand = initialCommand; // F2 retry material (prevent bare-shell misfire).
    const wsName = `wtask: ${ctx.title.slice(0, 32)}`;
    let workspaceId: string;
    try {
      const spawned = await this.renderer.spawnWorkspace({
        name: wsName,
        cwd: plan.worktreePath,
        initialCommand,
      });
      if ('error' in spawned) {
        await this.compensate(taskId, ctx.verifiedWorkspaceId, plan);
        return { ...base, error: `renderer spawn failed: ${spawned.error}`, preservedWorktree: plan.worktreePath };
      }
      workspaceId = spawned.workspaceId;
      // ptyId is optional (absent if handshake cannot carry it) — §3 onExhausted toast mapping.
      if (spawned.ptyId) base.ptyId = spawned.ptyId;
    } catch (err) {
      await this.compensate(taskId, ctx.verifiedWorkspaceId, plan);
      return { ...base, error: `renderer spawn threw: ${(err as Error).message}`, preservedWorktree: plan.worktreePath };
    }
    base.workspaceId = workspaceId;

    // ④ task.update — materialization commit ({branch, worktreePath, paneGroupId=workspaceId}).
    // This RPC has no MCP tool surface but reaches first-party clients via pipe router
    // registration (F4). Mutation defense is daemon owner OR CEO authz gate + materialization monotonic
    // gate (double materialization blocked); main stamps this path with owner identity.
    try {
      const updated = (await this.daemon.rpc('task.mission.update', {
        taskId,
        verifiedWorkspaceId: ctx.verifiedWorkspaceId,
        branch: plan.branch,
        worktreePath: plan.worktreePath,
        paneGroupId: workspaceId,
      })) as { ok?: boolean; error?: unknown };
      if (!updated?.ok) {
        // Unmaterialized — task·workspace·worktree exist but field commit failed.
        // §2 crash window contract: task stays open, report shows "unmaterialized",
        // human closes (auto re-materialization is J3). No compensation close (preserve successful spawn).
        return { ...base, unmaterialized: true, error: `task.update failed: ${describeErr(updated?.error)}` };
      }
    } catch (err) {
      return { ...base, unmaterialized: true, error: `task.update threw: ${(err as Error).message}` };
    }

    // ⑤ channel invite — task workspace as mission channel member (failure non-fatal §2 C3).
    let channelDisconnected = false;
    try {
      const invited = (await this.daemon.rpc('a2a.channel.invite', {
        channelId,
        invitedMember: { workspaceId, memberId: workspaceId },
        verifiedWorkspaceId: ctx.verifiedWorkspaceId,
      })) as { ok?: boolean; error?: unknown };
      if (!invited?.ok) channelDisconnected = true;
    } catch {
      channelDisconnected = true;
    }

    return { ...base, ok: true, channelDisconnected };
  }

  /**
   * Per-task compensation (§2): mission.close (reuse J0 compensation path — channel archive included).
   * worktree is **not deleted** but preserved (destroying disk state at failure is riskier — §2).
   * close failure is ignored (best-effort — task may remain unmaterialized open in report).
   */
  private async compensate(
    taskId: string,
    verifiedWorkspaceId: string,
    _plan?: TaskWorktreePlan,
  ): Promise<void> {
    try {
      await this.daemon.rpc('task.mission.close', { taskId, verifiedWorkspaceId });
    } catch {
      // best-effort compensation — fan-out continues even on failure.
    }
  }

  private recordResult(key: string, result: FanOutResult): void {
    this.results.set(key, result);
    while (this.results.size > WORKTASK_IDEMPOTENCY_CAP) {
      const oldest = this.results.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
  }
}

/** Display error value (string/object guard). */
function describeErr(err: unknown): string {
  if (err === undefined || err === null) return 'unknown';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    return `${String(e.code ?? '')}: ${String(e.message ?? JSON.stringify(err))}`;
  }
  return String(err);
}

/**
 * Assemble initialCommand (§4 D4). POSIX `{agentCmd} "$(cat '{path}')"` / Windows PowerShell
 * `{agentCmd} "$(Get-Content -Raw -LiteralPath '{path}')"`. Prompt body is in file so
 * quoting surface is limited to path — wrap path in shell single quotes so spaces·`$`·backticks·quotes are
 * not re-interpreted by shell (F1 3-model review conf10). sanitizePtyText preserving `$()`·quotes
 * is fixed by §4 C9 tests.
 *
 * When `promptPath` is undefined (§7 "environment-only" — open worktree·agent without prompt)
 * return agentCmd as-is. Do not fire empty string arg (`agentCmd ""`): CLIs handle empty args
 * differently (ignore/error/send empty prompt) so explicitly use "no args" for normal interactive agent launch.
 */
export function buildInitialCommand(agentCmd: string, promptPath?: string): string {
  if (promptPath === undefined) return agentCmd;
  if (process.platform === 'win32') {
    // PowerShell single-quote literal: escape internal `'` as `''`. -LiteralPath blocks
    // glob·path special char interpretation.
    const escaped = promptPath.replace(/'/g, "''");
    return `${agentCmd} "$(Get-Content -Raw -LiteralPath '${escaped}')"`;
  }
  // POSIX single-quote literal: internal `'` via `'\''` (close-escape-open).
  const escaped = promptPath.replace(/'/g, "'\\''");
  return `${agentCmd} "$(cat '${escaped}')"`;
}
