// Scheduled runs — the daemon-owned engine.
//
// Owns the store, the 30 s schedule tick, the launch of each run into its own
// daemon PTY, and the run state machine. Every effect on the rest of the
// daemon goes through `AutomationEnginePorts`, so the whole machine is driven
// in tests by calling `tick()` / `monitorOnce()` / the `on*` signal methods.
//
// Run lifecycle:
//   launching  claim persisted (at-most-once) → account/env/command → PTY →
//              readiness (first-run screens) → prompt pasted
//   running    ⇄ awaiting (approval record / awaiting_input / waiting)
//   completed | failed | unknown   first completion signal wins; the session
//              then lingers (a plain-text question may need a human) and is
//              snapshotted + tree-killed + destroyed afterwards
//   skipped    overlap / missed / daemon_down / needs_regrant, never launched
//
// A run still launching/running/awaiting when the daemon starts is recorded
// `unknown` and never relaunched: its session did not survive (recovery
// excludes `auto-` sessions) and replaying a prompt twice is worse than once.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { AgentSlug } from '../../shared/agentIdentity';
import {
  AUTOMATION_AGENT_CAPS,
  AUTOMATION_DEFAULTS,
  AUTOMATION_PTY_PREFIX,
  type Automation,
  type AutomationAgent,
  type AutomationAttention,
  type AutomationEvent,
  type AutomationListResult,
  type AutomationMutationResult,
  type AutomationOkResult,
  type AutomationPermissionMode,
  type AutomationRun,
  type AutomationRunNowResult,
  type AutomationRunDetail,
  type AutomationRunReason,
  type AutomationRunState,
} from '../../shared/automation';
import { nextOccurrenceAfter, planDue } from '../../shared/automationSchedule';
import { classifyLaunchScreen, FIRST_RUN_DISMISS_KEY, FIRST_RUN_MAX_ANSWERS } from '../../shared/agentFirstRun';
import type { SessionPromptScheduleResult } from '../../shared/sessionPromptSchedule';
import type { AgentStatus } from '../../shared/types';
import {
  changesWhatRuns,
  effectiveMode,
  isPermissionMode,
  modeRaises,
  needsRegrant,
  validateAllowedTools,
  validateDraft,
} from './draft';
import { buildAutomationCommand, buildAutomationEnv, resolveAccountEnv } from './launch';
import {
  ATTENTION_CAP,
  deleteSnapshot,
  isFinalRunState,
  loadAutomations,
  loadRuns,
  pruneRuns,
  readSnapshot,
  saveAutomations,
  saveRuns,
  writeSnapshot,
} from './store';

export const AUTOMATION_TICK_MS = 30_000;
export const AUTOMATION_MONITOR_MS = 5_000;
/** A tick later than this after the previous one means sleep or a clock jump. */
export const AUTOMATION_TICK_GAP_MS = 2 * 60_000;
export const READY_DEADLINE_MS = 120_000;
export const READY_POLL_MS = 1_000;
/** Consecutive ready reads before the paste (one read can be mid-paint). */
export const READY_STABLE_READS = 2;
/** Agent process gone but the PTY still up this long → ambiguous (`unknown`). */
export const PROCESS_EXIT_SETTLE_MS = 30_000;
/** An attached human may keep a completed session open this long at most. */
export const LINGER_ATTACHED_MAX_MS = 60 * 60_000;
/** Enter presses for a pasted prompt the delivery left unsubmitted, and their spacing. */
export const SUBMIT_RETRY_MAX = 3;
export const SUBMIT_RETRY_GAP_MS = 3_000;
const TRACKER_ARM_AFTER_MS = 10_000;
const TRACKER_ARM_EVERY_MS = 35_000;
const MINUTE_MS = 60_000;
/**
 * A needs-regrant notice is held back this long before it is announced (or
 * listed): the editor's own save is update → native confirm → grant, and the
 * grant withdraws the notice. The confirm has no deadline, so this is set well
 * beyond any plausible time in it rather than at the update → grant RPC gap;
 * the cost of holding back is nil, because an occurrence actually skipped as
 * needs_regrant announces its notice at once.
 */
export const REGRANT_NOTICE_SETTLE_MS = 5 * 60_000;

/** grant() refusal when the schedule changed after the human confirmed. */
export const GRANT_REVISION_CHANGED = 'The schedule changed while you were confirming; grant it again';

export interface AutomationAgentView {
  slug: AgentSlug | null;
  verified: boolean;
  status: AgentStatus;
  inputQuiet: boolean;
  incarnationId: string | null;
}

export interface AutomationEnginePorts {
  wmuxDir: string;
  parentEnv: NodeJS.ProcessEnv;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  emit: (event: AutomationEvent) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  isDirectory?: (p: string) => boolean;
  /** buildAgentLaunch against the installed CLI (env: the run's env, for CODEX_HOME). Throws when unavailable. */
  buildBaseCommand: (choice: { agent: AutomationAgent; model?: string; effort?: string }, env: Record<string, string>) => Promise<string>;
  /** Internal exec-session create (bypasses the external `auto-` id refusal). */
  createSession: (params: { id: string; cwd: string; env: Record<string, string>; command: string }) => Promise<void>;
  /** Live PTY pid, or null when the session is gone or dead. */
  sessionPid: (id: string) => number | null;
  isAttached: (id: string) => boolean;
  destroySession: (id: string) => Promise<void>;
  readScreen: (id: string) => Promise<string>;
  sendKey: (id: string, sequence: string) => Promise<void>;
  readAgent: (id: string) => AutomationAgentView;
  armAgentTracker: (id: string) => void;
  /** `onWrite('paste')` fires right before the paste is written: after it, the composer may hold the prompt. */
  deliverPrompt: (
    id: string, slug: AgentSlug, incarnationId: string, prompt: string,
    onWrite?: (stage: 'paste' | 'submit') => void,
  ) => Promise<SessionPromptScheduleResult>;
  hasPendingApproval: (id: string) => boolean;
  /** Newest recorded transcript turn end, ms epoch. */
  transcriptTurnEndAt: (id: string) => number | undefined;
  /**
   * Newest transcript event of any kind, ms epoch: the agent is still doing
   * work (a tool call, a result, a message). Optional; absent = not known.
   */
  transcriptLastEventAt?: (id: string) => number | undefined;
  /** Scrollback + viewport as plain text, or null. */
  snapshotText: (id: string) => Promise<string | null>;
  killTree: (pid: number) => Promise<void>;
}

type LivePhase = 'launching' | 'monitoring' | 'lingering' | 'ambiguous' | 'terminating';

interface LiveRun {
  runId: string;
  ptyId: string;
  phase: LivePhase;
  deliveredAt?: number;
  sawRunning: boolean;
  awaitingSince?: number;
  /** Last time the agent was seen running (detector or hook), ms epoch. */
  lastRunningAt?: number;
  lingerUntil?: number;
  processExitAt?: number;
}

export interface AgentEventSignal {
  kind: string;
  status: string;
  /** HookIngest's arbitration. Only a confirmed turn end ('emit'/'dedup') completes a run. */
  decision?: string;
  agentSessionId?: string;
}

const CONFIRMED_DECISIONS: ReadonlySet<string> = new Set(['emit', 'dedup']);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AutomationEngine {
  private automations: Automation[] = [];
  private attention: AutomationAttention[] = [];
  private runs: AutomationRun[] = [];
  private readonly live = new Map<string, LiveRun>();
  /** Active run registry: pane id → run id. The gate-skip / history-skip key. */
  private readonly panes = new Map<string, string>();
  /**
   * needs-regrant attention ids that are announced: broadcast, and visible in
   * `list()`. Queued silently first; announced by the tick once settled, by
   * the first skipped occurrence, or at boot.
   */
  private readonly announced = new Set<string>();
  private booting = true;
  private lastTickAt: number | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private saveChain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly ports: AutomationEnginePorts) {}

  private now(): number {
    return (this.ports.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (this.ports.sleep ?? defaultSleep)(ms);
  }

  private newId(): string {
    return (this.ports.newId ?? randomUUID)();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Load, settle runs a previous daemon left open, and (optionally) start the timers. */
  async start(options: { timers?: boolean } = {}): Promise<void> {
    const a = loadAutomations(this.ports.wmuxDir);
    this.automations = a.automations;
    this.attention = a.attention;
    this.runs = loadRuns(this.ports.wmuxDir).runs;
    const now = this.now();
    // A notice that outlived a daemon is settled by definition. A schedule
    // whose grant is already stale (an update that never got its grant, or a
    // store from before stale grants were skipped) gets one now: its runs are
    // skipped from here on, and nobody would otherwise be told why.
    for (const item of this.attention) if (item.kind === 'needs-regrant') this.announced.add(item.id);
    let raised = 0;
    for (const automation of this.automations) {
      if (!needsRegrant(automation) || this.attention.some((x) => x.automationId === automation.id && x.kind === 'needs-regrant')) continue;
      this.queueAttention(automation, 'needs-regrant', false);
      this.announced.add(this.attention[this.attention.length - 1].id);
      raised++;
    }
    if (raised) await this.persistAutomations();
    let settled = 0;
    for (const run of this.runs) {
      if (isFinalRunState(run.state)) continue;
      // Claimed but the daemon went away: never relaunched.
      run.state = 'unknown';
      run.reason = 'interrupted';
      run.endedAt = now;
      delete run.ptyId;
      settled++;
    }
    if (settled) this.ports.log('warn', `[automation] ${settled} run(s) left open by a previous daemon marked unknown`);
    this.pruneAndDrop();
    await this.persistRuns();
    if (options.timers !== false) {
      this.tickTimer = setInterval(() => this.tick(), AUTOMATION_TICK_MS);
      this.tickTimer.unref?.();
      this.monitorTimer = setInterval(() => {
        this.monitorOnce().catch((err) => this.ports.log('error', `[automation] monitor failed: ${String(err)}`));
      }, AUTOMATION_MONITOR_MS);
      this.monitorTimer.unref?.();
      this.tick();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.tickTimer = null;
    this.monitorTimer = null;
  }

  /** Idle keepalive: an enabled schedule or a live run keeps the daemon up. */
  holdsDaemon(): boolean {
    return this.panes.size > 0 || this.automations.some((a) => a.enabled);
  }

  /** Is this pane a scheduled run's (registry membership, not the id prefix)? */
  ownsPane(ptyId: string): boolean {
    return this.panes.has(ptyId);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private persistAutomations(): Promise<boolean> {
    const state = { version: 1 as const, automations: this.automations.map(clone), attention: [...this.attention] };
    const job = this.saveChain.then(() => saveAutomations(this.ports.wmuxDir, state));
    this.saveChain = job.catch(() => undefined);
    return job.then((ok) => {
      if (!ok) this.ports.log('warn', '[automation] automations.json save failed');
      return ok;
    });
  }

  private persistRuns(): Promise<boolean> {
    const state = { version: 1 as const, runs: this.runs.map(clone) };
    const job = this.saveChain.then(() => saveRuns(this.ports.wmuxDir, state));
    this.saveChain = job.catch(() => undefined);
    return job.then((ok) => {
      if (!ok) this.ports.log('warn', '[automation] automation-runs.json save failed');
      return ok;
    });
  }

  private pruneAndDrop(): void {
    const { kept, dropped } = pruneRuns(this.runs, new Set(this.automations.map((a) => a.id)));
    const liveRunIds = new Set(this.live.keys());
    // A lingering run is final but still owns a session — never drop it early.
    const keep = new Set(kept.map((r) => r.id));
    this.runs = this.runs.filter((r) => keep.has(r.id) || liveRunIds.has(r.id));
    for (const id of dropped) if (!liveRunIds.has(id)) deleteSnapshot(this.ports.wmuxDir, id);
  }

  private emitRun(run: AutomationRun): void {
    const name = this.automations.find((a) => a.id === run.automationId)?.name ?? '';
    this.ports.emit({ type: 'run-changed', run: clone(run), automationName: name });
  }

  private emitAutomations(): void {
    this.ports.emit({ type: 'automations-changed' });
  }

  private queueAttention(automation: Automation, kind: AutomationAttention['kind'], announce = true): void {
    this.attention.push({
      id: this.newId(),
      automationId: automation.id,
      automationName: automation.name,
      kind,
      at: this.now(),
    });
    if (this.attention.length > ATTENTION_CAP) this.attention = this.attention.slice(-ATTENTION_CAP);
    if (announce) this.ports.emit({ type: 'attention', automationId: automation.id, automationName: automation.name, kind });
  }

  /** Broadcast needs-regrant notices that outlived the editor's update → grant window (or all of one schedule's, now). */
  private announceRegrantNotices(now: number, automationId?: string): void {
    for (const item of this.attention) {
      if (item.kind !== 'needs-regrant' || this.announced.has(item.id)) continue;
      if (automationId ? item.automationId !== automationId : now - item.at < REGRANT_NOTICE_SETTLE_MS) continue;
      this.announced.add(item.id);
      this.ports.emit({ type: 'attention', automationId: item.automationId, automationName: item.automationName, kind: item.kind });
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  list(): AutomationListResult {
    // An unannounced needs-regrant notice is still inside the editor's save
    // window: a client pulling the queue now must not surface it either.
    const pending = this.attention.filter((x) => x.kind !== 'needs-regrant' || this.announced.has(x.id));
    return { automations: this.automations.map(clone), pendingAttention: pending.map(clone) };
  }

  listRuns(automationId?: string): AutomationRun[] {
    return this.runs
      .filter((r) => !automationId || r.automationId === automationId)
      .sort((a, b) => b.scheduledFor - a.scheduledFor || (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .map(clone);
  }

  snapshot(runId: string): string | null {
    const run = this.runs.find((r) => r.id === runId);
    return run?.hasSnapshot ? readSnapshot(this.ports.wmuxDir, runId) : null;
  }

  // ── Mutations (first-party only; the RPC layer enforces it) ───────────────

  async create(rawDraft: unknown, enabled?: unknown): Promise<AutomationMutationResult> {
    return this.insert(rawDraft, 'desktop-ui', enabled !== false);
  }

  /** MCP draft path: always disabled, proposed, approval mode. */
  async propose(rawDraft: unknown): Promise<AutomationMutationResult> {
    return this.insert(rawDraft, 'mcp-proposal', false);
  }

  private async insert(rawDraft: unknown, createdBy: Automation['createdBy'], wantEnabled: boolean): Promise<AutomationMutationResult> {
    const draft = validateDraft(rawDraft);
    if (!draft.ok) return { ok: false, error: draft.error };
    if (this.automations.length >= AUTOMATION_DEFAULTS.maxAutomations) {
      return { ok: false, error: `At most ${AUTOMATION_DEFAULTS.maxAutomations} schedules` };
    }
    const now = this.now();
    const proposal = createdBy === 'mcp-proposal';
    // A proposal is always disabled, whatever was asked.
    const enabled = !proposal && wantEnabled;
    const automation: Automation = {
      id: this.newId(),
      name: draft.value.name,
      enabled,
      ...(proposal ? { proposed: true } : {}),
      revision: 1,
      trigger: draft.value.trigger,
      action: draft.value.action,
      permission: { mode: 'approval' },
      policy: { overlap: 'skip_if_active', ...draft.value.policy },
      nextRunAt: enabled ? nextOccurrenceAfter(draft.value.trigger, now) : null,
      createdAt: now,
      updatedAt: now,
      createdBy,
    };
    this.automations.push(automation);
    if (proposal) this.queueAttention(automation, 'proposed');
    await this.persistAutomations();
    this.emitAutomations();
    return { ok: true, automation: clone(automation) };
  }

  async update(id: unknown, rawDraft: unknown): Promise<AutomationMutationResult> {
    const automation = this.find(id);
    if (!automation) return { ok: false, error: 'Not found' };
    const draft = validateDraft(rawDraft);
    if (!draft.ok) return { ok: false, error: draft.error };
    // The revision is the server's: any client-sent revision/grant is ignored
    // because only the validated draft fields are read.
    const bumped = changesWhatRuns(automation.action, draft.value.action);
    if (bumped) automation.revision += 1;
    automation.name = draft.value.name;
    automation.trigger = draft.value.trigger;
    automation.action = draft.value.action;
    automation.policy = { overlap: 'skip_if_active', ...draft.value.policy };
    automation.updatedAt = this.now();
    automation.nextRunAt = automation.enabled ? nextOccurrenceAfter(automation.trigger, this.now()) : null;
    // Raised now, not at the first skipped occurrence: the editor grants again
    // in the same save (and the grant clears this), so only an update that
    // never got its grant leaves it standing.
    if (bumped && needsRegrant(automation)) this.queueAttention(automation, 'needs-regrant', false);
    await this.persistAutomations();
    this.emitAutomations();
    return { ok: true, automation: clone(automation) };
  }

  async remove(id: unknown): Promise<AutomationOkResult> {
    const automation = this.find(id);
    if (!automation) return { ok: false, error: 'Not found' };
    // Out of the schedule set BEFORE any await, so a tick in between cannot
    // start a run for a schedule that is being deleted.
    this.automations = this.automations.filter((a) => a.id !== automation.id);
    this.attention = this.attention.filter((x) => x.automationId !== automation.id);
    for (const run of this.runs.filter((r) => r.automationId === automation.id)) {
      if (this.live.has(run.id)) await this.terminate(run, 'failed', 'cancelled');
      else if (!isFinalRunState(run.state)) this.finish(run, 'failed', 'cancelled');
    }
    this.pruneAndDrop();
    await this.persistAutomations();
    await this.persistRuns();
    this.emitAutomations();
    return { ok: true };
  }

  async setEnabled(id: unknown, enabled: unknown): Promise<AutomationMutationResult> {
    const automation = this.find(id);
    if (!automation || typeof enabled !== 'boolean') return { ok: false, error: 'Not found' };
    automation.enabled = enabled;
    // A human enabling a draft is what turns it into a schedule.
    if (enabled) delete automation.proposed;
    automation.nextRunAt = enabled ? nextOccurrenceAfter(automation.trigger, this.now()) : null;
    automation.updatedAt = this.now();
    await this.persistAutomations();
    this.emitAutomations();
    return { ok: true, automation: clone(automation) };
  }

  /** Grants `mode` at the CURRENT revision. The only writer of grantedRevision. */
  async grant(id: unknown, mode: unknown, allowedTools: unknown, expectedRevision?: unknown): Promise<AutomationMutationResult> {
    const automation = this.find(id);
    if (!automation) return { ok: false, error: 'Not found' };
    // The revision the human confirmed, when the caller pinned one: an edit
    // that landed while the confirm was open is not what they agreed to.
    if (expectedRevision !== undefined && expectedRevision !== automation.revision) {
      return { ok: false, error: GRANT_REVISION_CHANGED };
    }
    if (!isPermissionMode(mode)) return { ok: false, error: 'Invalid permission mode' };
    if (mode === 'auto' && !AUTOMATION_AGENT_CAPS[automation.action.agent].autoMode) return { ok: false, error: 'Auto mode is for Claude only' };
    const before = effectiveMode(automation);
    if (mode === 'approval') {
      automation.permission = { mode: 'approval' };
    } else if (mode === 'scoped' && automation.action.agent === 'codex') {
      // codex scoped = workspace-write sandbox with no approval prompts; it has
      // no per-tool allow-list, so a tool list would promise something unenforced.
      if (allowedTools !== undefined && !(Array.isArray(allowedTools) && allowedTools.length === 0)) {
        return { ok: false, error: 'Tool lists apply to claude only' };
      }
      automation.permission = { mode, grantedRevision: automation.revision };
    } else if (mode === 'scoped') {
      const tools = validateAllowedTools(allowedTools);
      if (!tools.ok) return { ok: false, error: tools.error };
      automation.permission = { mode, allowedTools: tools.value, grantedRevision: automation.revision };
    } else {
      automation.permission = { mode, grantedRevision: automation.revision };
    }
    automation.updatedAt = this.now();
    // The grant now matches the current revision: a stale-grant notice is moot.
    this.attention = this.attention.filter((x) => !(x.automationId === automation.id && x.kind === 'needs-regrant'));
    if (mode !== 'approval' && modeRaises(before, mode)) this.queueAttention(automation, 'grant-raised');
    await this.persistAutomations();
    this.emitAutomations();
    return { ok: true, automation: clone(automation) };
  }

  async ackAttention(ids: unknown): Promise<AutomationOkResult> {
    if (!Array.isArray(ids)) return { ok: false, error: 'Invalid ids' };
    const drop = new Set(ids.filter((x): x is string => typeof x === 'string'));
    this.attention = this.attention.filter((x) => !drop.has(x.id));
    await this.persistAutomations();
    return { ok: true };
  }

  async runNow(id: unknown, kind: unknown): Promise<AutomationRunNowResult> {
    const automation = this.find(id);
    if (!automation) return { ok: false, error: 'Not found' };
    if (kind !== 'manual' && kind !== 'test') return { ok: false, error: 'Invalid run kind' };
    // The same rule as the schedule: a stale grant never runs, not even by hand.
    if (needsRegrant(automation)) return { ok: false, error: 'Grant the permission again before running' };
    const run = await this.startRun(automation, this.now(), kind);
    return { ok: true, run: clone(run) };
  }

  async cancelRun(runId: unknown): Promise<AutomationOkResult> {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) return { ok: false, error: 'Not found' };
    if (this.live.has(run.id)) {
      await this.terminate(run, 'failed', 'cancelled');
    } else if (!isFinalRunState(run.state)) {
      this.finish(run, 'failed', 'cancelled');
      await this.persistRuns();
    }
    return { ok: true };
  }

  private find(id: unknown): Automation | undefined {
    return typeof id === 'string' ? this.automations.find((a) => a.id === id) : undefined;
  }

  // ── Schedule tick ─────────────────────────────────────────────────────────

  tick(now: number = this.now()): void {
    if (this.stopped) return;
    if (this.lastTickAt !== null && (now < this.lastTickAt || now - this.lastTickAt > AUTOMATION_TICK_GAP_MS)) {
      this.ports.log('info', `[automation] tick gap ${Math.round((now - this.lastTickAt) / 1000)}s — recomputing due runs`);
    }
    this.lastTickAt = now;
    this.announceRegrantNotices(now);
    const booting = this.booting;
    this.booting = false;
    let automationsDirty = false;
    let runsDirty = false;
    for (const automation of this.automations) {
      if (!automation.enabled) {
        if (automation.nextRunAt !== null) {
          automation.nextRunAt = null;
          automationsDirty = true;
        }
        continue;
      }
      const plan = planDue({
        trigger: automation.trigger,
        nextRunAt: automation.nextRunAt,
        now,
        lastScheduledFor: this.lastScheduledFor(automation.id),
        booting,
        limit: AUTOMATION_DEFAULTS.runHistoryPerAutomation,
      });
      for (const skip of plan.skipped) {
        this.recordSkipped(automation, skip.at, skip.reason);
        runsDirty = true;
      }
      if (plan.nextRunAt !== automation.nextRunAt) {
        automation.nextRunAt = plan.nextRunAt;
        automationsDirty = true;
      }
      if (plan.fire !== null) {
        this.startRun(automation, plan.fire, 'scheduled')
          .catch((err) => this.ports.log('error', `[automation] start failed: ${String(err)}`));
      }
    }
    if (runsDirty) {
      this.pruneAndDrop();
      void this.persistRuns();
    }
    if (automationsDirty) {
      void this.persistAutomations();
      this.emitAutomations();
    }
  }

  private lastScheduledFor(automationId: string): number | null {
    let latest: number | null = null;
    for (const r of this.runs) {
      if (r.automationId === automationId && r.trigger === 'scheduled' && (latest === null || r.scheduledFor > latest)) {
        latest = r.scheduledFor;
      }
    }
    return latest;
  }

  private recordSkipped(
    automation: Automation,
    scheduledFor: number,
    reason: AutomationRunReason,
    trigger: AutomationRun['trigger'] = 'scheduled',
    mode: AutomationPermissionMode = effectiveMode(automation),
  ): AutomationRun {
    const run: AutomationRun = {
      id: this.newId(),
      automationId: automation.id,
      revision: automation.revision,
      effectiveMode: mode,
      scheduledFor,
      trigger,
      state: 'skipped',
      reason,
      endedAt: this.now(),
    };
    this.runs.push(run);
    this.emitRun(run);
    return run;
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  /** Claim and launch one run. Returns the run record (possibly skipped/failed). */
  async startRun(
    automation: Automation,
    scheduledFor: number,
    trigger: AutomationRun['trigger'],
  ): Promise<AutomationRun> {
    // Snapshot what runs and under which grant in one synchronous step: an
    // update/grant landing during the claim save below must not mix an old
    // grant with a new action (or the reverse).
    const snapshot = clone(automation);
    // Fail closed: a grant that predates an edit never runs as a weaker mode.
    if (needsRegrant(snapshot)) {
      this.announceRegrantNotices(this.now(), automation.id);
      const skipped = this.recordSkipped(automation, scheduledFor, 'needs_regrant', trigger, snapshot.permission.mode);
      this.pruneAndDrop();
      await this.persistRuns();
      return skipped;
    }
    const mode = effectiveMode(snapshot);
    // Overlap: an open run, or any run of this schedule whose session is still
    // live (lingering after completion, or ambiguous). A completed/failed run
    // whose session a human has opened does not count: that session is theirs
    // now, and the next occurrence gets its own PTY.
    const active = this.runs.some((r) => r.automationId === automation.id && !isFinalRunState(r.state)) ||
      [...this.live.values()].some((l) => {
        const r = this.runs.find((x) => x.id === l.runId);
        if (r?.automationId !== automation.id) return false;
        const handedOver = (r.state === 'completed' || r.state === 'failed') && this.ports.isAttached(l.ptyId);
        return !handedOver;
      });
    if (active) {
      const skipped = this.recordSkipped(automation, scheduledFor, 'overlap', trigger);
      this.pruneAndDrop();
      await this.persistRuns();
      return skipped;
    }
    const id = this.newId();
    const run: AutomationRun = {
      id,
      automationId: automation.id,
      revision: snapshot.revision,
      effectiveMode: mode,
      scheduledFor,
      trigger,
      state: 'launching',
      ptyId: `${AUTOMATION_PTY_PREFIX}${id}`,
      startedAt: this.now(),
    };
    this.runs.push(run);
    this.emitRun(run);
    // At-most-once: the claim must be durable before anything is spawned.
    if (!(await this.persistRuns())) {
      this.finish(run, 'failed', 'launch_failed');
      delete run.ptyId;
      void this.persistRuns();
      return run;
    }
    this.launch(run, snapshot, mode).catch(async (err) => {
      this.ports.log('error', `[automation] run ${run.id} launch crashed: ${String(err)}`);
      try {
        if (this.live.has(run.id)) await this.terminate(run, 'failed', 'launch_failed');
        else {
          this.finish(run, 'failed', 'launch_failed');
          delete run.ptyId;
          await this.persistRuns();
        }
      } catch { /* nothing left to do */ }
    });
    return run;
  }

  private async launch(run: AutomationRun, automation: Automation, mode: AutomationPermissionMode): Promise<void> {
    const ptyId = `${AUTOMATION_PTY_PREFIX}${run.id}`;
    const { action } = automation;
    const account = resolveAccountEnv(this.ports.wmuxDir, action.agent, action.accountId);
    if (!account.ok) {
      this.finish(run, 'failed', 'account_missing');
      delete run.ptyId;
      await this.persistRuns();
      return;
    }
    const isDirectory = this.ports.isDirectory ?? defaultIsDirectory;
    let command: string;
    const env = buildAutomationEnv(ptyId, this.ports.parentEnv, account.env);
    try {
      if (!isDirectory(action.cwd)) throw new Error('Folder is missing');
      const base = await this.ports.buildBaseCommand(
        { agent: action.agent, ...(action.model ? { model: action.model } : {}), ...(action.effort ? { effort: action.effort } : {}) },
        env,
      );
      command = buildAutomationCommand(base, action.agent, mode, automation.permission.allowedTools);
    } catch (err) {
      this.ports.log('warn', `[automation] run ${run.id} launch refused: ${String(err)}`);
      this.finish(run, 'failed', 'launch_failed');
      delete run.ptyId;
      await this.persistRuns();
      return;
    }
    if (isFinalRunState(run.state)) return; // cancelled while resolving

    // Registered BEFORE the PTY exists: the agent's first hooks (SessionStart,
    // an early PreToolUse) must already see the pane as a scheduled run.
    const live: LiveRun = { runId: run.id, ptyId, phase: 'launching', sawRunning: false };
    this.live.set(run.id, live);
    this.panes.set(ptyId, run.id);
    try {
      await this.ports.createSession({ id: ptyId, cwd: action.cwd, env, command });
    } catch (err) {
      this.ports.log('warn', `[automation] run ${run.id} session create failed: ${String(err)}`);
      this.unregister(run.id);
      if (!isFinalRunState(run.state)) this.finish(run, 'failed', 'launch_failed');
      delete run.ptyId;
      await this.persistRuns();
      return;
    }
    if (!this.live.has(run.id) || isFinalRunState(run.state)) {
      // Cancelled (or removed) while the session was being created: the
      // terminate that ran found no session yet, so reap it now.
      const pid = this.ports.sessionPid(ptyId);
      try {
        if (pid !== null) await this.ports.killTree(pid);
        await this.ports.destroySession(ptyId);
      } catch (err) {
        this.ports.log('warn', `[automation] run ${run.id} late reap failed: ${String(err)}`);
      }
      this.unregister(run.id);
      return;
    }

    const ready = await this.awaitReady(run, live, action.agent);
    if (isFinalRunState(run.state) || live.phase !== 'launching') return;
    if (!ready.ok) {
      await this.terminate(run, 'failed', ready.reason);
      return;
    }
    const delivery = await this.deliver(run, live, action.agent, action.prompt, ready.incarnationId);
    if (isFinalRunState(run.state) || live.phase !== 'launching') return;
    let result = delivery.result;
    if (result === 'error' && delivery.pasted) {
      // The paste may sit in the composer with only Enter missing. Settle it
      // on the screen instead of destroying a session that is fine.
      this.ports.log('warn', `[automation] run ${run.id} prompt pasted but not submitted; confirming the submit`);
      const settled = await this.confirmSubmit(run, live, action.prompt);
      if (isFinalRunState(run.state) || live.phase !== 'launching') return;
      run.detail = settled;
      if (settled === 'submit_retried') result = 'sent';
    }
    if (result !== 'sent') {
      this.ports.log('warn', `[automation] run ${run.id} prompt delivery ${result}${run.detail ? ` (${run.detail})` : ''}`);
      await this.terminate(run, 'failed', 'launch_failed');
      return;
    }
    live.deliveredAt = this.now();
    live.phase = 'monitoring';
    run.state = 'running';
    this.emitRun(run);
    await this.persistRuns();
  }

  private async awaitReady(
    run: AutomationRun,
    live: LiveRun,
    agent: AutomationAgent,
  ): Promise<{ ok: true; incarnationId: string } | { ok: false; reason: AutomationRunReason }> {
    const started = this.now();
    let dismissals = 0;
    let stable = 0;
    let lastArm = -Infinity;
    let everVerified = false;
    let lastView: AutomationAgentView | null = null;
    while (this.now() - started < READY_DEADLINE_MS) {
      if (isFinalRunState(run.state) || live.phase !== 'launching') return { ok: false, reason: 'cancelled' };
      if (this.ports.sessionPid(live.ptyId) === null) return { ok: false, reason: 'launch_failed' };
      let screen = '';
      try {
        screen = await this.ports.readScreen(live.ptyId);
      } catch {
        screen = '';
      }
      const blocking = classifyLaunchScreen(screen);
      if (blocking) {
        stable = 0;
        if (blocking.kind === 'first-run' && blocking.prompt.kind === 'interstitial' && dismissals < FIRST_RUN_MAX_ANSWERS) {
          try {
            await this.ports.sendKey(live.ptyId, FIRST_RUN_DISMISS_KEY);
          } catch {
            return { ok: false, reason: 'first_run_blocked' };
          }
          dismissals++;
          this.ports.log('info', `[automation] run ${run.id} dismissed first-run screen`);
          await this.sleep(READY_POLL_MS);
          continue;
        }
        // Trust dialogs, model errors, and any menu we do not know: never
        // typed into, never pasted into.
        this.ports.log('warn', `[automation] run ${run.id} blocked on ${blocking.kind === 'first-run' ? blocking.prompt.headline : blocking.headline}`);
        return { ok: false, reason: 'first_run_blocked' };
      }
      const view = this.ports.readAgent(live.ptyId);
      lastView = view;
      if (view.verified && view.slug === agent) everVerified = true;
      const incarnationId = view.incarnationId;
      const ready = view.verified && view.slug === agent && view.inputQuiet && !!incarnationId &&
        (view.status === 'idle' || view.status === 'waiting' || view.status === 'complete') &&
        screen.trim().length > 0;
      if (ready && incarnationId) {
        stable++;
        if (stable >= READY_STABLE_READS) return { ok: true, incarnationId };
      } else {
        stable = 0;
        const elapsed = this.now() - started;
        if (!view.verified && elapsed >= TRACKER_ARM_AFTER_MS && this.now() - lastArm >= TRACKER_ARM_EVERY_MS) {
          lastArm = this.now();
          this.ports.armAgentTracker(live.ptyId);
        }
      }
      await this.sleep(READY_POLL_MS);
    }
    const reason: AutomationRunReason = everVerified ? 'first_run_blocked' : 'launch_failed';
    this.ports.log('warn', `[automation] run ${run.id} not ready after ${READY_DEADLINE_MS / 1000}s: ` +
      `reason=${reason} everVerified=${everVerified} last=${lastView ? JSON.stringify({
        slug: lastView.slug, verified: lastView.verified, status: lastView.status,
        inputQuiet: lastView.inputQuiet, incarnation: lastView.incarnationId !== null,
      }) : 'none'}`);
    return { ok: false, reason };
  }

  private async deliver(
    run: AutomationRun,
    live: LiveRun,
    agent: AutomationAgent,
    prompt: string,
    incarnationId: string,
  ): Promise<{ result: SessionPromptScheduleResult; pasted: boolean }> {
    const started = this.now();
    let pasted = false;
    const onWrite = (stage: 'paste' | 'submit') => { if (stage === 'paste') pasted = true; };
    for (;;) {
      if (isFinalRunState(run.state) || live.phase !== 'launching') return { result: 'error', pasted };
      let result: SessionPromptScheduleResult;
      try {
        result = await this.ports.deliverPrompt(live.ptyId, agent, incarnationId, prompt, onWrite);
      } catch {
        return { result: 'error', pasted };
      }
      if (result !== 'busy' || this.now() - started >= READY_DEADLINE_MS) return { result, pasted };
      await this.sleep(READY_POLL_MS);
    }
  }

  /**
   * A pasted prompt the delivery did not submit. Within the readiness
   * deadline: while the prompt is on screen, press Enter (at most
   * SUBMIT_RETRY_MAX times, SUBMIT_RETRY_GAP_MS apart) until the agent shows
   * it took the turn — running, or new transcript entries. Nothing is pressed
   * once the prompt is nowhere on screen. The pane is the run's own and is
   * not offered to anyone else, so a draft there is the one just pasted.
   */
  private async confirmSubmit(run: AutomationRun, live: LiveRun, prompt: string): Promise<AutomationRunDetail> {
    const started = this.now();
    let enters = 0;
    let lastEnterAt = -Infinity;
    let firstEnterAt: number | null = null;
    while (this.now() - started < READY_DEADLINE_MS) {
      if (isFinalRunState(run.state) || live.phase !== 'launching') return 'submit_unconfirmed';
      if (this.ports.sessionPid(live.ptyId) === null) return 'submit_unconfirmed';
      if (firstEnterAt !== null) {
        const view = this.ports.readAgent(live.ptyId);
        const lastEvent = this.ports.transcriptLastEventAt?.(live.ptyId);
        if (view.status === 'running' || view.status === 'complete' || (lastEvent !== undefined && lastEvent >= firstEnterAt)) {
          return 'submit_retried';
        }
      }
      let screen = '';
      try {
        screen = await this.ports.readScreen(live.ptyId);
      } catch {
        screen = '';
      }
      if (!screenShowsPrompt(screen, prompt)) {
        // Before any Enter: the paste never landed. After one: the agent took
        // it and cleared the composer without a status we could read yet.
        return firstEnterAt === null ? 'prompt_not_in_composer' : 'submit_retried';
      }
      if (enters < SUBMIT_RETRY_MAX && this.now() - lastEnterAt >= SUBMIT_RETRY_GAP_MS) {
        try {
          await this.ports.sendKey(live.ptyId, '\r');
        } catch {
          return 'submit_unconfirmed';
        }
        enters++;
        lastEnterAt = this.now();
        firstEnterAt ??= lastEnterAt;
      }
      await this.sleep(READY_POLL_MS);
    }
    return 'submit_unconfirmed';
  }

  // ── Monitoring ────────────────────────────────────────────────────────────

  async monitorOnce(now: number = this.now()): Promise<void> {
    for (const live of [...this.live.values()]) {
      const run = this.runs.find((r) => r.id === live.runId);
      if (!run) {
        this.unregister(live.runId);
        continue;
      }
      await this.monitorRun(run, live, now);
    }
  }

  private maxRunMs(run: AutomationRun): number {
    const automation = this.automations.find((a) => a.id === run.automationId);
    return (automation?.policy.maxRunMinutes ?? AUTOMATION_DEFAULTS.maxRunMinutes) * MINUTE_MS;
  }

  private awaitTimeoutMs(run: AutomationRun): number {
    const automation = this.automations.find((a) => a.id === run.automationId);
    const configured = automation?.policy.awaitTimeoutMinutes;
    if (configured !== undefined) return configured * MINUTE_MS;
    // Approval runs end too: an unanswered prompt must not hold the slot (and
    // skip the next occurrences as overlap) until the absolute run cap.
    return (run.effectiveMode === 'approval'
      ? AUTOMATION_DEFAULTS.approvalAwaitTimeoutMinutes
      : AUTOMATION_DEFAULTS.unattendedAwaitTimeoutMinutes) * MINUTE_MS;
  }

  private async monitorRun(run: AutomationRun, live: LiveRun, now: number): Promise<void> {
    if (live.phase === 'terminating') return;
    if (live.phase === 'lingering') {
      if (this.ports.sessionPid(live.ptyId) === null) {
        await this.terminate(run);
      } else if (now >= (live.lingerUntil ?? 0) &&
        (!this.ports.isAttached(live.ptyId) || now >= (live.lingerUntil ?? 0) + LINGER_ATTACHED_MAX_MS ||
          now - (run.startedAt ?? now) > this.maxRunMs(run))) {
        await this.terminate(run);
      }
      return;
    }
    // Absolute ceiling — approval mode and ambiguous runs included.
    if (now - (run.startedAt ?? now) > this.maxRunMs(run)) {
      this.ports.log('warn', `[automation] run ${run.id} hit its run limit`);
      await this.terminate(run, 'failed', 'timeout');
      return;
    }
    if (live.phase === 'launching') return;
    if (this.ports.sessionPid(live.ptyId) === null) {
      // Destroyed from outside (no session:died reaches us for that).
      await this.terminate(run, 'unknown', 'process_exit');
      return;
    }
    if (live.phase !== 'monitoring') return;

    if (live.processExitAt !== undefined && now - live.processExitAt >= PROCESS_EXIT_SETTLE_MS) {
      // The agent is gone but its PTY is not: no exit code to judge by.
      this.finish(run, 'unknown', 'process_exit');
      live.phase = 'ambiguous';
      await this.persistRuns();
      return;
    }

    const view = this.ports.readAgent(live.ptyId);
    if (view.status === 'running') {
      live.sawRunning = true;
      live.lastRunningAt = now;
    }
    // Completion first: a finished turn must not be read as awaiting.
    const turnEnd = this.ports.transcriptTurnEndAt(live.ptyId);
    if (live.deliveredAt !== undefined && turnEnd !== undefined && turnEnd > live.deliveredAt) {
      await this.complete(run, live, 'completed');
      return;
    }
    if (live.sawRunning && view.status === 'complete') {
      await this.complete(run, live, 'completed');
      return;
    }
    // Only an approval record or an explicit question is "waiting on a human";
    // a bare ready-for-input footer is not.
    const awaiting = this.ports.hasPendingApproval(live.ptyId) || view.status === 'awaiting_input';
    if (awaiting) {
      if (run.state === 'running') {
        run.state = 'awaiting';
        live.awaitingSince = now;
        this.emitRun(run);
        await this.persistRuns();
      }
      const limit = this.awaitTimeoutMs(run);
      if (now - (live.awaitingSince ?? now) > limit) {
        // One misread "awaiting" must not end a run that is still working:
        // turn progress since the wait began restarts the clock from there.
        // Raw PTY output is not progress — a prompt on screen keeps
        // repainting, and that is exactly the wait this limit ends.
        const progress = Math.max(live.lastRunningAt ?? 0, this.ports.transcriptLastEventAt?.(live.ptyId) ?? 0);
        if (progress > (live.awaitingSince ?? now)) {
          live.awaitingSince = progress;
          return;
        }
        await this.terminate(run, 'failed', 'await_timeout');
      }
      return;
    }
    if (run.state === 'awaiting') {
      run.state = 'running';
      delete live.awaitingSince;
      this.emitRun(run);
      await this.persistRuns();
    }
  }

  // ── Signals from the rest of the daemon ───────────────────────────────────

  /** A hook-sourced agent event for some pane (HookIngest's emit path). */
  async onAgentEvent(ptyId: string, signal: AgentEventSignal): Promise<void> {
    const runId = this.panes.get(ptyId);
    if (!runId) return;
    const run = this.runs.find((r) => r.id === runId);
    const live = this.live.get(runId);
    if (!run || !live) return;
    if (signal.agentSessionId && signal.agentSessionId.length <= 256 && run.agentSessionId !== signal.agentSessionId) {
      run.agentSessionId = signal.agentSessionId;
      if (isFinalRunState(run.state)) await this.persistRuns();
    }
    if (live.phase !== 'monitoring' || live.deliveredAt === undefined) return;
    if (signal.status === 'running') {
      live.sawRunning = true;
      live.lastRunningAt = this.now();
    }
    const confirmed = signal.decision === undefined || CONFIRMED_DECISIONS.has(signal.decision);
    if (signal.kind === 'agent.stop_failure' && confirmed) {
      await this.complete(run, live, 'failed', 'agent_error');
      return;
    }
    if (signal.kind === 'agent.stop' && signal.status !== 'running' && confirmed) {
      await this.complete(run, live, 'completed');
      return;
    }
    if (signal.status === 'awaiting_input' && run.state === 'running') {
      run.state = 'awaiting';
      live.awaitingSince = this.now();
      this.emitRun(run);
      await this.persistRuns();
    }
  }

  /** The agent process inside a run's PTY died (process-tracker death edge). */
  onAgentProcessExit(ptyId: string): void {
    const runId = this.panes.get(ptyId);
    const live = runId ? this.live.get(runId) : undefined;
    if (live && live.processExitAt === undefined) live.processExitAt = this.now();
  }

  /** The PTY itself exited (exec unit: the agent's own exit). */
  async onSessionDied(ptyId: string, exitCode: number | null): Promise<void> {
    const runId = this.panes.get(ptyId);
    if (!runId) return;
    const run = this.runs.find((r) => r.id === runId);
    if (!run) {
      this.unregister(runId);
      return;
    }
    const delivered = this.live.get(runId)?.deliveredAt !== undefined;
    if (!isFinalRunState(run.state)) {
      // Exiting before the prompt was ever delivered is a failed launch,
      // whatever the exit code says.
      if (!delivered) this.finish(run, 'failed', 'launch_failed');
      else if (exitCode === 0) this.finish(run, 'completed');
      else if (typeof exitCode === 'number') this.finish(run, 'failed', 'process_exit');
      else this.finish(run, 'unknown', 'process_exit');
    }
    await this.terminate(run);
  }

  // ── Endings ───────────────────────────────────────────────────────────────

  /** Mark a run final (no session side effects). Idempotent. */
  private finish(run: AutomationRun, state: AutomationRunState, reason?: AutomationRunReason): void {
    if (isFinalRunState(run.state)) return;
    run.state = state;
    if (reason) run.reason = reason;
    else delete run.reason;
    run.endedAt = this.now();
    this.emitRun(run);
  }

  /** A turn ended: record it, then keep the session for the linger window. */
  private async complete(run: AutomationRun, live: LiveRun, state: AutomationRunState, reason?: AutomationRunReason): Promise<void> {
    this.finish(run, state, reason);
    live.phase = 'lingering';
    live.lingerUntil = this.now() + AUTOMATION_DEFAULTS.completionLingerMinutes * MINUTE_MS;
    this.pruneAndDrop();
    await this.persistRuns();
  }

  /**
   * Snapshot → kill the PTY's process tree → destroy the session → unregister.
   * `state` (when given) is applied first if the run is not already final.
   */
  private async terminate(run: AutomationRun, state?: AutomationRunState, reason?: AutomationRunReason): Promise<void> {
    if (state) this.finish(run, state, reason);
    const live = this.live.get(run.id);
    if (!live || live.phase === 'terminating') return;
    live.phase = 'terminating';
    const ptyId = live.ptyId;
    try {
      const text = await this.ports.snapshotText(ptyId);
      if (text !== null && writeSnapshot(this.ports.wmuxDir, run.id, text)) run.hasSnapshot = true;
    } catch (err) {
      this.ports.log('warn', `[automation] run ${run.id} snapshot failed: ${String(err)}`);
    }
    const pid = this.ports.sessionPid(ptyId);
    if (pid !== null) {
      try {
        await this.ports.killTree(pid);
      } catch (err) {
        this.ports.log('warn', `[automation] run ${run.id} tree kill failed: ${String(err)}`);
      }
    }
    try {
      await this.ports.destroySession(ptyId);
    } catch (err) {
      this.ports.log('warn', `[automation] run ${run.id} destroy failed: ${String(err)}`);
    }
    this.unregister(run.id);
    delete run.ptyId;
    this.emitRun(run);
    this.pruneAndDrop();
    await this.persistRuns();
  }

  private unregister(runId: string): void {
    const live = this.live.get(runId);
    if (live) this.panes.delete(live.ptyId);
    this.live.delete(runId);
  }
}

/**
 * Is the prompt visible anywhere on screen? Whitespace-insensitive; the first
 * line (at most 40 characters) stands for the prompt. A long paste the agent
 * folds into a placeholder (Claude's "[Pasted text #1 …]") counts as visible.
 */
export function screenShowsPrompt(screen: string, prompt: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, '');
  if (/\[Pasted text #\d+/.test(screen)) return true;
  const first = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const needle = flat(Array.from(first).slice(0, 40).join(''));
  return needle.length > 0 && flat(screen).includes(needle);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
