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
// A turn that fails on a temporary provider error (transientFailure.ts) is
// held instead, still `running` with `retryAt` set, and gets ONE continue
// message after TRANSIENT_RETRY_DELAY_MS; the prompt is never sent again. A
// second failure, or a session that cannot take the continue, ends it failed.
//
// A run still launching/running/awaiting when the daemon starts is recorded
// `unknown` and never relaunched: its session did not survive (recovery
// excludes `auto-` sessions) and replaying a prompt twice is worse than once.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { agentRow, type AgentSlug } from '../../shared/agentIdentity';
import {
  AUTOMATION_AGENT_CAPS,
  AUTOMATION_CAPABILITY_BROWSER_IDENTITY,
  AUTOMATION_DEFAULT_SETTINGS,
  AUTOMATION_DEFAULTS,
  AUTOMATION_PTY_PREFIX,
  isFailureReason,
  type Automation,
  type AutomationAgent,
  type AutomationBrowserIdentity,
  type AutomationIdentityRunsResult,
  type AutomationRunIdentityResult,
  type AutomationAttention,
  type AutomationEvent,
  type AutomationFailureReason,
  type AutomationListResult,
  type AutomationMutationResult,
  type AutomationOkResult,
  type AutomationPermissionMode,
  type AutomationRun,
  type AutomationRunNowResult,
  type AutomationRunDetail,
  type AutomationRunReason,
  type AutomationRunState,
  type AutomationSettings,
  type AutomationSettingsResult,
} from '../../shared/automation';
import { AUTOMATION_TICK_MS, nextOccurrenceAfter, planDue } from '../../shared/automationSchedule';
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
  validateBrowserIdentity,
  validateDraft,
} from './draft';
import { buildAutomationCommand, buildAutomationEnv, resolveAccountEnv } from './launch';
import { FolderTrustRefusedError } from '../folderTrustState';
import { TRANSIENT_RETRY_DELAY_MS, TRANSIENT_RETRY_READY_GRACE_MS } from './transientFailure';
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

export { AUTOMATION_TICK_MS };
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
  /**
   * True when the agent's own status command says this run's account is signed
   * out (daemon/agentLoginGate). Absent = not checked.
   */
  signedOut?: (agent: AutomationAgent, env: Record<string, string>) => Promise<boolean>;
  /** A run was refused because its account is signed out: raise the desktop notice. */
  authLost?: (agent: AutomationAgent, env: Record<string, string>) => void;
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
  /** `onWrite('paste')` fires once the paste write succeeded (or threw): after it, the composer may hold the prompt. */
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
  /**
   * The one continue after a temporary provider error: the fixed continue
   * message (never the run's prompt) through the scheduled-prompt proof,
   * expecting exactly this agent and accepting a pane its failed turn left at
   * `error`. `stillWanted` is asked again right before the paste and the
   * Enter. Absent = no retry is possible.
   */
  deliverContinue?: (
    id: string, slug: AgentSlug, incarnationId: string, stillWanted: () => boolean,
  ) => Promise<SessionPromptScheduleResult>;
  /** Whether the session's own screen shows a folder-trust dialog (#2802). Absent = not known. */
  folderTrustState?: (id: string) => Promise<'trust' | 'clear' | 'unknown'>;
  /**
   * The usage reserve's hold on a Claude account ('default' or an account
   * id): when its 5h window resets (ms), or null when unattended starts may
   * go ahead. Absent = no reserve.
   */
  reserveHold?: (account: string) => number | null;
}

/** `held`: waiting out a temporary provider error; `retrying`: its one continue is being sent. */
type LivePhase = 'launching' | 'monitoring' | 'held' | 'retrying' | 'lingering' | 'ambiguous' | 'terminating';

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
  /** An Enter of the submit retry was refused at a folder-trust prompt. */
  folderTrustRefused?: boolean;
  /** The agent the prompt was delivered to: a continue may reach only this process. */
  incarnationId?: string;
  /** First pass that found the held run's continue due: the not-ready grace runs from here. */
  retryCheckSince?: number;
}

export interface AgentEventSignal {
  kind: string;
  status: string;
  /** HookIngest's arbitration. Only a confirmed turn end ('emit'/'dedup') completes a run. */
  decision?: string;
  agentSessionId?: string;
  /** A StopFailure the provider classed as a sign-in failure (shared/phoneTurnFailure `auth`). */
  authFailure?: boolean;
  /** A failed turn whose cause is a temporary provider error (transientFailure.ts). */
  transientFailure?: boolean;
}

const CONFIRMED_DECISIONS: ReadonlySet<string> = new Set(['emit', 'dedup']);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The usage key a run's account goes by: its account id, or 'default' for the default login. */
function reserveAccount(automation: Automation): string {
  return automation.action.accountId ?? 'default';
}

export class AutomationEngine {
  private automations: Automation[] = [];
  private attention: AutomationAttention[] = [];
  private settings: AutomationSettings = { ...AUTOMATION_DEFAULT_SETTINGS };
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
  /**
   * Scheduled occurrences the usage reserve holds, automation id → its
   * scheduledFor. Memory only: the automation's cursor stays on the held
   * occurrence, so after a restart it is met like any occurrence that came
   * due while the daemon was down.
   */
  private readonly reserveHeld = new Map<string, number>();
  private booting = true;
  private lastTickAt: number | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private saveChain: Promise<unknown> = Promise.resolve();
  /** Work started and not awaited (a launch, a scheduled start, a timed monitor pass): each may save later. */
  private readonly detached = new Set<Promise<unknown>>();
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
    this.settings = a.settings;
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
      if (run.retryAt !== undefined) {
        // Held after a temporary provider error: that turn did fail, and its
        // session did not survive, so there is nothing left to continue.
        run.state = 'failed';
        run.reason = 'agent_error';
        run.detail = 'retry_interrupted';
        delete run.retryAt;
      } else {
        // Claimed but the daemon went away: never relaunched.
        run.state = 'unknown';
        run.reason = 'interrupted';
      }
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
        this.detach(this.monitorOnce().catch((err) => this.ports.log('error', `[automation] monitor failed: ${String(err)}`)));
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

  /**
   * Resolves once the work this engine started without awaiting it (a launch,
   * a scheduled start, a timed monitor pass) has ended and every save queued
   * so far, and any queued meanwhile, has settled. After stop() nothing new
   * starts, so this is the point past which the engine writes nothing.
   */
  async whenSaved(): Promise<void> {
    for (;;) {
      const chain = this.saveChain;
      await Promise.allSettled([...this.detached]);
      await chain;
      if (this.detached.size === 0 && chain === this.saveChain) return;
    }
  }

  /** Keep `work` (already caught) until it settles, for whenSaved. */
  private detach(work: Promise<unknown>): void {
    this.detached.add(work);
    void work.finally(() => this.detached.delete(work));
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
    const state = {
      version: 1 as const, automations: this.automations.map(clone), attention: [...this.attention], settings: { ...this.settings },
    };
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

  private emitRun(run: AutomationRun, pausedSchedule = false): void {
    const name = this.automations.find((a) => a.id === run.automationId)?.name ?? '';
    // The event stream reaches every client: it says THAT a run has a browser
    // identity, never which pane, account or sites.
    const { browserIdentity, ...shown } = clone(run);
    this.ports.emit({
      type: 'run-changed',
      run: browserIdentity ? { ...shown, hasBrowserIdentity: true } : shown,
      automationName: name,
      ...(pausedSchedule && { pausedSchedule: true as const }),
    });
  }

  private emitAutomations(): void {
    this.ports.emit({ type: 'automations-changed' });
  }

  private queueAttention(
    automation: Automation,
    kind: AutomationAttention['kind'],
    announce = true,
    reason?: AutomationFailureReason,
  ): void {
    this.attention.push({
      id: this.newId(),
      automationId: automation.id,
      automationName: automation.name,
      kind,
      at: this.now(),
      ...(reason && { reason }),
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
    return { automations: this.automations.map(clone), pendingAttention: pending.map(clone), settings: { ...this.settings } };
  }

  listRuns(automationId?: string): AutomationRun[] {
    return this.runs
      .filter((r) => !automationId || r.automationId === automationId)
      .sort((a, b) => b.scheduledFor - a.scheduledFor || (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .map(clone);
  }

  capabilities(): { capabilities: string[] } {
    return { capabilities: [AUTOMATION_CAPABILITY_BROWSER_IDENTITY] };
  }

  /**
   * The live run behind `ptyId`, with the identity it launched with — only
   * while this daemon incarnation runs it (the in-memory pane map, which a
   * restart empties) and before it reaches a final state.
   */
  runIdentity(ptyId: unknown): AutomationRunIdentityResult {
    if (typeof ptyId !== 'string') return { run: null };
    const runId = this.panes.get(ptyId);
    const run = runId ? this.runs.find((r) => r.id === runId) : undefined;
    if (!run || !this.live.has(run.id) || isFinalRunState(run.state) || !run.browserIdentity || run.ptyId !== ptyId) {
      return { run: null };
    }
    return {
      run: {
        runId: run.id,
        automationId: run.automationId,
        revision: run.revision,
        effectiveMode: run.effectiveMode,
        ptyId,
        browserIdentity: clone(run.browserIdentity),
      },
    };
  }

  /** Live identity runs and their shell pids (main walks callers to these). */
  identityRuns(): AutomationIdentityRunsResult {
    const runs: AutomationIdentityRunsResult['runs'] = [];
    for (const live of this.live.values()) {
      const run = this.runs.find((r) => r.id === live.runId);
      if (!run?.browserIdentity || isFinalRunState(run.state)) continue;
      const pid = this.ports.sessionPid(live.ptyId);
      if (pid === null) continue;
      runs.push({ ptyId: live.ptyId, pid, automationId: run.automationId, revision: run.revision });
    }
    return { runs };
  }

  /** Main refused a browser call of a live run: say why on the run. */
  async noteRunBrowser(runId: unknown, detail: unknown): Promise<AutomationOkResult> {
    if (detail !== 'browser_needs_consent' && detail !== 'browser_policy_denied' && detail !== 'browser_consent_unattended') {
      return { ok: false, error: 'Invalid detail' };
    }
    const run = this.runs.find((r) => r.id === runId);
    if (!run || !this.live.has(run.id) || isFinalRunState(run.state)) return { ok: false, error: 'Not found' };
    if (run.detail === detail) return { ok: true };
    run.detail = detail;
    this.emitRun(run);
    await this.persistRuns();
    return { ok: true };
  }

  /** A browser call of the live run behind `ptyId` used the shared default Chrome profile: say so on the run. */
  async noteRunBrowserProfile(ptyId: unknown): Promise<AutomationOkResult> {
    const runId = typeof ptyId === 'string' ? this.panes.get(ptyId) : undefined;
    const run = runId ? this.runs.find((r) => r.id === runId) : undefined;
    if (!run || !this.live.has(run.id) || isFinalRunState(run.state)) return { ok: false, error: 'Not found' };
    if (run.browserProfileUnbound) return { ok: true };
    run.browserProfileUnbound = true;
    this.emitRun(run);
    await this.persistRuns();
    return { ok: true };
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
    // because only the validated draft fields are read. A bound browser
    // identity is kept (a draft can never carry one); an edit that changes
    // what runs leaves it ungranted until main grants it again.
    const identity = automation.action.browserIdentity;
    const nextAction = identity ? { ...draft.value.action, browserIdentity: identity } : draft.value.action;
    const bumped = changesWhatRuns(automation.action, nextAction);
    if (bumped) {
      automation.revision += 1;
      this.resetBreaker(automation);
    }
    automation.name = draft.value.name;
    automation.trigger = draft.value.trigger;
    automation.action = nextAction;
    automation.policy = { overlap: 'skip_if_active', ...draft.value.policy };
    automation.updatedAt = this.now();
    // The cursor moves on from any held occurrence: an edit drops it.
    this.reserveHeld.delete(automation.id);
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
    this.reserveHeld.delete(automation.id);
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
    this.resetBreaker(automation);
    this.reserveHeld.delete(automation.id);
    automation.nextRunAt = enabled ? nextOccurrenceAfter(automation.trigger, this.now()) : null;
    automation.updatedAt = this.now();
    await this.persistAutomations();
    this.emitAutomations();
    return { ok: true, automation: clone(automation) };
  }

  /** Grants `mode` at the CURRENT revision. The only writer of grantedRevision. */
  async grant(
    id: unknown,
    mode: unknown,
    allowedTools: unknown,
    expectedRevision?: unknown,
    rawIdentity?: unknown,
  ): Promise<AutomationMutationResult> {
    const automation = this.find(id);
    if (!automation) return { ok: false, error: 'Not found' };
    // The revision the human confirmed, when the caller pinned one: an edit
    // that landed while the confirm was open is not what they agreed to.
    if (expectedRevision !== undefined && expectedRevision !== automation.revision) {
      return { ok: false, error: GRANT_REVISION_CHANGED };
    }
    if (!isPermissionMode(mode)) return { ok: false, error: 'Invalid permission mode' };
    if (mode === 'auto' && !AUTOMATION_AGENT_CAPS[automation.action.agent].autoMode) return { ok: false, error: 'Auto mode is for Claude only' };
    // A browser identity is (re)bound only together with a grant pinned to
    // the revision the human confirmed; it lands at the NEXT revision, which
    // main signed into it. A schedule that has one is never granted without it.
    let identity: AutomationBrowserIdentity | null | undefined;
    if (rawIdentity !== undefined) {
      if (typeof expectedRevision !== 'number') return { ok: false, error: 'A browser identity needs a pinned revision' };
      if (rawIdentity === null) {
        identity = null;
      } else {
        const checked = validateBrowserIdentity(rawIdentity);
        if (!checked.ok) return { ok: false, error: checked.error };
        if (checked.value.boundRevision !== automation.revision + 1) return { ok: false, error: GRANT_REVISION_CHANGED };
        if (!AUTOMATION_AGENT_CAPS[automation.action.agent].unattendedBrowserIdentity && mode !== 'approval') {
          return { ok: false, error: 'A Codex schedule with a browser identity runs in approval mode only' };
        }
        identity = checked.value;
      }
    } else if (automation.action.browserIdentity) {
      return { ok: false, error: 'Confirm the browser identity again in the desktop app' };
    }
    if (identity !== undefined) {
      if (identity) automation.action = { ...automation.action, browserIdentity: identity };
      else {
        const { browserIdentity: _dropped, ...rest } = automation.action;
        automation.action = rest;
      }
      automation.revision += 1;
    }
    const before = effectiveMode(automation);
    if (mode === 'approval') {
      // An identity is a grant of its own: approval records the revision too.
      automation.permission = automation.action.browserIdentity
        ? { mode: 'approval', grantedRevision: automation.revision }
        : { mode: 'approval' };
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

  async setSettings(raw: unknown): Promise<AutomationSettingsResult> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Invalid settings' };
    const retry = (raw as Record<string, unknown>)['retryTransientErrors'];
    if (retry !== undefined && typeof retry !== 'boolean') return { ok: false, error: 'Invalid settings' };
    const previous = this.settings;
    if (typeof retry === 'boolean') this.settings = { ...this.settings, retryTransientErrors: retry };
    if (!(await this.persistAutomations())) {
      // Not saved: keep running on what is on disk, which is what the caller is told.
      if (this.settings.retryTransientErrors === retry) this.settings = previous;
      return { ok: false, error: 'Could not save the settings' };
    }
    this.emitAutomations();
    return { ok: true, settings: { ...this.settings } };
  }

  async ackAttention(ids: unknown): Promise<AutomationOkResult> {
    if (!Array.isArray(ids)) return { ok: false, error: 'Invalid ids' };
    const drop = new Set(ids.filter((x): x is string => typeof x === 'string'));
    this.attention = this.attention.filter((x) => !drop.has(x.id));
    await this.persistAutomations();
    return { ok: true };
  }

  async runNow(id: unknown, kind: unknown, endSessionOf?: unknown): Promise<AutomationRunNowResult> {
    const automation = this.find(id);
    if (!automation) return { ok: false, error: 'Not found' };
    if (kind !== 'manual' && kind !== 'test') return { ok: false, error: 'Invalid run kind' };
    if (endSessionOf !== undefined && typeof endSessionOf !== 'string') return { ok: false, error: 'Invalid run id' };
    // The same rule as the schedule: a stale grant never runs, not even by hand.
    if (needsRegrant(automation)) return { ok: false, error: 'Grant the permission again before running' };
    // #2065: the person confirmed ending a finished run's lingering session.
    // Only that session, and only while it is still the one thing in the way;
    // anything else is left to the overlap rule below.
    if (endSessionOf !== undefined) {
      const blocker = this.soleLingeringBlocker(automation.id);
      const finished = blocker?.runId === endSessionOf ? this.runs.find((r) => r.id === endSessionOf) : undefined;
      if (finished) await this.terminate(finished);
    }
    const run = await this.startRun(automation, this.now(), kind);
    // Skipped only for a finished run's lingering session: name it, so the
    // person can end it and start.
    const blocker = run.state === 'skipped' && run.detail === 'previous_session_open'
      ? this.soleLingeringBlocker(automation.id) : undefined;
    const finished = blocker && this.runs.find((r) => r.id === blocker.runId);
    return {
      ok: true,
      run: clone(run),
      ...(blocker && finished && {
        lingeringSession: { runId: finished.id, ptyId: blocker.ptyId, endedAt: finished.endedAt ?? finished.startedAt ?? finished.scheduledFor },
      }),
    };
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
        this.reserveHeld.delete(automation.id);
        if (automation.nextRunAt !== null) {
          automation.nextRunAt = null;
          automationsDirty = true;
        }
        continue;
      }
      const heldFor = this.reserveHeld.get(automation.id);
      if (heldFor !== undefined && this.reserveUntil(automation) !== null) continue;
      const plan = planDue({
        trigger: automation.trigger,
        nextRunAt: automation.nextRunAt,
        now,
        lastScheduledFor: this.lastScheduledFor(automation.id),
        booting,
        limit: AUTOMATION_DEFAULTS.runHistoryPerAutomation,
      });
      // A held run whose reserve lifted: the newest occurrence still in its
      // grace runs if one came due meanwhile, else the held one does; those
      // in between are recorded as missed.
      const fire = heldFor !== undefined ? plan.fire ?? heldFor : plan.fire;
      if (heldFor !== undefined) {
        this.reserveHeld.delete(automation.id);
        this.ports.log('info', `[automation] ${automation.id}: usage reserve lifted, starting the held run`);
      }
      for (const skip of plan.skipped) {
        if (skip.at === fire) continue;
        this.recordSkipped(automation, skip.at, skip.reason);
        runsDirty = true;
      }
      if (plan.nextRunAt !== automation.nextRunAt) {
        automation.nextRunAt = plan.nextRunAt;
        automationsDirty = true;
      }
      const reserveUntil = fire === null || heldFor !== undefined ? null : this.reserveUntil(automation);
      if (fire !== null && reserveUntil !== null) {
        // Held, not failed: it starts on the first tick after the reset. The
        // cursor stays on it, so a restart meanwhile treats it as missed.
        this.reserveHeld.set(automation.id, fire);
        automation.nextRunAt = fire;
        automationsDirty = true;
        this.ports.log('info', `[automation] ${automation.id}: held by the usage reserve until ${new Date(reserveUntil).toISOString()}`);
        this.ports.emit({
          type: 'reserve-held',
          automationId: automation.id,
          automationName: automation.name,
          account: reserveAccount(automation),
          untilMs: reserveUntil,
        });
      } else if (fire !== null) {
        this.detach(this.startRun(automation, fire, 'scheduled')
          .catch((err) => this.ports.log('error', `[automation] start failed: ${String(err)}`)));
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

  /** The usage reserve's hold on this automation's account, or null: only for an agent whose usage wmux reads. */
  private reserveUntil(automation: Automation): number | null {
    if (agentRow(automation.action.agent)?.usageReserve !== true || !this.ports.reserveHold) return null;
    return this.ports.reserveHold(reserveAccount(automation));
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
    detail?: AutomationRunDetail,
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
      ...(detail ? { detail } : {}),
      endedAt: this.now(),
    };
    this.runs.push(run);
    this.emitRun(run);
    return run;
  }

  /**
   * Overlap: an open run, or any run of this schedule whose session is still
   * live (lingering after completion, or ambiguous). A completed/failed run
   * whose session a human has opened does not count: that session is theirs
   * now, and the next occurrence gets its own PTY.
   */
  private overlapBlockers(automationId: string): { running: boolean; openSessions: LiveRun[] } {
    const running = this.runs.some((r) => r.automationId === automationId && !isFinalRunState(r.state));
    const openSessions = running ? [] : [...this.live.values()].filter((l) => {
      const r = this.runs.find((x) => x.id === l.runId);
      if (r?.automationId !== automationId) return false;
      const handedOver = (r.state === 'completed' || r.state === 'failed') && this.ports.isAttached(l.ptyId);
      return !handedOver;
    });
    return { running, openSessions };
  }

  /** The one finished run's lingering session that alone blocks a new run (#2065). */
  private soleLingeringBlocker(automationId: string): LiveRun | undefined {
    const { running, openSessions } = this.overlapBlockers(automationId);
    if (running || openSessions.length !== 1 || openSessions[0].phase !== 'lingering') return undefined;
    return openSessions[0];
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
    const { running, openSessions } = this.overlapBlockers(automation.id);
    if (running || openSessions.length > 0) {
      // #2065: a run that only waits on a finished run's lingering session
      // says so, rather than reading as "previous run still going". An
      // ambiguous run's session is not on the linger timer (it can hold the
      // slot up to the run limit), so it keeps the plain overlap reason.
      const lingering = openSessions.length > 0 && openSessions.every((l) => l.phase === 'lingering');
      const skipped = this.recordSkipped(automation, scheduledFor, 'overlap', trigger, undefined,
        lingering ? 'previous_session_open' : undefined);
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
      // The identity this run acts as, fixed at launch: main reads it from the
      // live run, never from the schedule, which may have changed since.
      ...(snapshot.action.browserIdentity && { browserIdentity: clone(snapshot.action.browserIdentity) }),
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
    this.detach(this.launch(run, snapshot, mode).catch(async (err) => {
      this.ports.log('error', `[automation] run ${run.id} launch crashed: ${String(err)}`);
      try {
        if (this.live.has(run.id)) await this.terminate(run, 'failed', 'launch_failed');
        else {
          this.finish(run, 'failed', 'launch_failed');
          delete run.ptyId;
          await this.persistRuns();
        }
      } catch { /* nothing left to do */ }
    }));
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
    // A signed-out account would sit on the agent's sign-in screen until the
    // ready check gave up; say so now instead.
    if (await this.ports.signedOut?.(action.agent, env).catch(() => false)) {
      if (isFinalRunState(run.state)) return; // cancelled while checking
      this.ports.log('warn', `[automation] run ${run.id} refused: ${action.agent} is signed out`);
      this.finish(run, 'failed', 'login_needed');
      this.ports.authLost?.(action.agent, env);
      delete run.ptyId;
      await this.persistRuns();
      return;
    }
    try {
      if (!isDirectory(action.cwd)) throw new Error('Folder is missing');
      const base = await this.ports.buildBaseCommand(
        { agent: action.agent, ...(action.model ? { model: action.model } : {}), ...(action.effort ? { effort: action.effort } : {}) },
        env,
      );
      command = buildAutomationCommand(base, action.agent, mode, automation.permission.allowedTools, {
        browserIdentity: !!action.browserIdentity,
      });
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
      // A folder-trust prompt blocks the run the way it does at launch.
      await this.terminate(run, 'failed', result === 'folder_trust' || live.folderTrustRefused ? 'first_run_blocked' : 'launch_failed');
      return;
    }
    live.deliveredAt = this.now();
    live.incarnationId = ready.incarnationId;
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
        } catch (err) {
          // A screen that cannot rule out a folder-trust prompt is waited out
          // like a busy one, within the deadline; the prompt itself ends it.
          if (err instanceof FolderTrustRefusedError && err.verdict === 'unknown') {
            await this.sleep(READY_POLL_MS);
            continue;
          }
          if (err instanceof FolderTrustRefusedError) live.folderTrustRefused = true;
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
    if (live.phase === 'launching' || live.phase === 'retrying') return;
    if (this.ports.sessionPid(live.ptyId) === null) {
      // Destroyed from outside (no session:died reaches us for that). A held
      // run's turn did fail: it ends failed, with nothing to continue.
      if (live.phase === 'held') {
        run.detail = 'retry_blocked';
        await this.terminate(run, 'failed', 'agent_error');
      } else {
        await this.terminate(run, 'unknown', 'process_exit');
      }
      return;
    }
    if (live.phase === 'held') {
      if (now >= (run.retryAt ?? now)) await this.retryTransient(run, live, now);
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
    // A continue being delivered counts too: its turn can end before the delivery returns.
    const continuing = live.phase === 'retrying' && run.retried === true;
    if ((live.phase !== 'monitoring' && !continuing) || live.deliveredAt === undefined) return;
    if (signal.status === 'running') {
      live.sawRunning = true;
      live.lastRunningAt = this.now();
    }
    const confirmed = signal.decision === undefined || CONFIRMED_DECISIONS.has(signal.decision);
    if (signal.kind === 'agent.stop_failure' && confirmed) {
      if (!signal.authFailure && signal.transientFailure && this.armRetry(run, live)) {
        this.emitRun(run);
        await this.persistRuns();
        return;
      }
      if (run.retried && !signal.authFailure) run.detail = 'retried_once';
      await this.complete(run, live, 'failed', signal.authFailure ? 'login_needed' : 'agent_error');
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

  /**
   * A confirmed StopFailure of a temporary provider error on `ptyId`: hold
   * the run for its one continue, now and synchronously, so the caller knows
   * before it sends a turn-failed push whether this failure is final. False
   * when no hold was armed (not a run's pane, already retried, turned off).
   */
  armTransientRetry(ptyId: string, decision?: string): boolean {
    if (decision !== undefined && !CONFIRMED_DECISIONS.has(decision)) return false;
    const runId = this.panes.get(ptyId);
    const run = runId ? this.runs.find((r) => r.id === runId) : undefined;
    const live = runId ? this.live.get(runId) : undefined;
    if (!run || !live || !this.armRetry(run, live)) return false;
    this.emitRun(run);
    void this.persistRuns();
    return true;
  }

  /** Is `ptyId` a live run whose one continue was sent (its next failure is final)? */
  continuedRunPane(ptyId: string): boolean {
    const runId = this.panes.get(ptyId);
    const run = runId ? this.runs.find((r) => r.id === runId) : undefined;
    return !!run && run.retried === true && !isFinalRunState(run.state) && this.live.has(run.id);
  }

  private armRetry(run: AutomationRun, live: LiveRun): boolean {
    if (live.phase !== 'monitoring' || live.deliveredAt === undefined || isFinalRunState(run.state)) return false;
    if (run.retried || run.retryAt !== undefined || !this.settings.retryTransientErrors) return false;
    const automation = this.automations.find((a) => a.id === run.automationId);
    if (!automation || automation.policy.retryTransientErrors === false) return false;
    live.phase = 'held';
    run.state = 'running';
    delete live.awaitingSince;
    run.retryAt = this.now() + TRANSIENT_RETRY_DELAY_MS;
    this.ports.log('info', `[automation] run ${run.id} held after a temporary provider error; one continue at ${new Date(run.retryAt).toISOString()}`);
    return true;
  }

  /**
   * The one continue of a held run. Written only into the run's own pane,
   * with the same agent process it delivered to, idle and quiet, no approval
   * or dialog on screen and no folder-trust prompt. A pane that is only
   * momentarily not ready is asked again on later passes, for
   * TRANSIENT_RETRY_READY_GRACE_MS from the first one; a pane that is no
   * longer the run's (or its agent's) ends the run failed at once. Nothing is
   * written in either case.
   */
  private async retryTransient(run: AutomationRun, live: LiveRun, now: number): Promise<void> {
    live.phase = 'retrying';
    const dueAt = run.retryAt ?? now;
    // From the first pass that found it due, not from the due time: a pass
    // delayed by sleep must still get its grace.
    live.retryCheckSince ??= now;
    const inGrace = now - live.retryCheckSince < TRANSIENT_RETRY_READY_GRACE_MS;
    const automation = this.automations.find((a) => a.id === run.automationId);
    const deliverContinue = this.ports.deliverContinue;
    const stillWanted = (): boolean => !isFinalRunState(run.state) && live.phase === 'retrying' &&
      this.panes.get(live.ptyId) === run.id && run.ptyId === live.ptyId;
    const refusal = automation && deliverContinue
      ? await this.retryRefusal(run, live, automation.action.agent)
      : { reason: automation ? 'no continue path' : 'schedule removed', final: true };
    // Cancelled or removed meanwhile: that ending stands.
    if (isFinalRunState(run.state) || live.phase !== 'retrying') return;
    if (refusal || !automation || !deliverContinue || !live.incarnationId) {
      if (refusal && !refusal.final && inGrace) {
        live.phase = 'held';
        return;
      }
      await this.retryBlocked(run, live, refusal?.reason ?? 'no continue path');
      return;
    }
    // The one attempt starts here. The continued turn may end before the
    // delivery returns: its hooks are taken from now on (see onAgentEvent).
    const before = { deliveredAt: live.deliveredAt, sawRunning: live.sawRunning };
    run.retried = true;
    delete run.retryAt;
    live.deliveredAt = this.now();
    live.sawRunning = false;
    let result: SessionPromptScheduleResult;
    try {
      result = await deliverContinue(live.ptyId, automation.action.agent, live.incarnationId, stillWanted);
    } catch {
      result = 'error';
    }
    // Ended meanwhile (cancelled, or the continued turn already ended): that ending stands.
    if (isFinalRunState(run.state) || live.phase !== 'retrying') return;
    if (result === 'busy' && inGrace) {
      // Nothing was written (a draft, a usage-limit hold, a turn in the way): ask again next pass.
      delete run.retried;
      run.retryAt = dueAt;
      live.deliveredAt = before.deliveredAt;
      live.sawRunning = before.sawRunning;
      live.phase = 'held';
      return;
    }
    if (result !== 'sent') {
      await this.retryBlocked(run, live, `continue ${result}`);
      return;
    }
    this.ports.log('info', `[automation] run ${run.id} continued once after a temporary provider error`);
    live.phase = 'monitoring';
    this.emitRun(run);
    await this.persistRuns();
  }

  private async retryBlocked(run: AutomationRun, live: LiveRun, reason: string): Promise<void> {
    this.ports.log('warn', `[automation] run ${run.id} not retried: ${reason}`);
    run.detail = 'retry_blocked';
    await this.complete(run, live, 'failed', 'agent_error');
  }

  /**
   * Why the held run's pane cannot take its continue now, or null. `final`:
   * the pane or its agent is no longer the run's, so waiting cannot help.
   */
  private async retryRefusal(
    run: AutomationRun, live: LiveRun, agent: AutomationAgent,
  ): Promise<{ reason: string; final: boolean } | null> {
    if (this.panes.get(live.ptyId) !== run.id || run.ptyId !== live.ptyId) return { reason: 'pane is not the run\'s own', final: true };
    if (this.ports.sessionPid(live.ptyId) === null) return { reason: 'session gone', final: true };
    const view = this.ports.readAgent(live.ptyId);
    // Another agent, or another process of it, is proof the pane moved on.
    // A verification blip on the same process is not.
    if (!live.incarnationId || (view.slug !== null && view.slug !== agent)
      || (view.incarnationId !== null && view.incarnationId !== live.incarnationId)) {
      return { reason: 'agent changed', final: true };
    }
    if (!view.verified || view.slug === null || view.incarnationId === null) return { reason: 'agent not verified', final: false };
    if (!view.inputQuiet || !['idle', 'waiting', 'complete', 'error'].includes(view.status)) {
      return { reason: `agent ${view.status}${view.inputQuiet ? '' : ', input not quiet'}`, final: false };
    }
    if (this.ports.hasPendingApproval(live.ptyId)) return { reason: 'approval pending', final: false };
    let screen = '';
    try {
      screen = await this.ports.readScreen(live.ptyId);
    } catch {
      return { reason: 'screen unreadable', final: false };
    }
    if (classifyLaunchScreen(screen)) return { reason: 'a dialog is on screen', final: false };
    let trust: 'trust' | 'clear' | 'unknown' = 'unknown';
    try {
      trust = (await this.ports.folderTrustState?.(live.ptyId)) ?? 'unknown';
    } catch {
      trust = 'unknown';
    }
    if (trust === 'clear') return null;
    return { reason: `folder trust ${trust}`, final: trust === 'trust' };
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
    const live = this.live.get(runId);
    const delivered = live?.deliveredAt !== undefined;
    if (!isFinalRunState(run.state) && (live?.phase === 'held' || live?.phase === 'retrying')) {
      // Held after a temporary provider error, or its continue still being
      // delivered: whatever the exit code, that turn failed and no continued
      // turn was seen.
      run.detail = 'retry_blocked';
      this.finish(run, 'failed', 'agent_error');
    } else if (!isFinalRunState(run.state)) {
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
    delete run.retryAt;
    run.endedAt = this.now();
    this.emitRun(run, this.noteOutcome(run));
  }

  /**
   * The failure breaker: consecutive scheduled runs that failed with one
   * reason turn the schedule off after AUTOMATION_DEFAULTS.failureBreakerRuns.
   * Manual and test runs, cancelled, skipped and unknown ends neither count
   * nor break the streak. finish() calls this once per run. True when this run
   * paused the schedule.
   */
  private noteOutcome(run: AutomationRun): boolean {
    if (run.trigger !== 'scheduled') return false;
    const automation = this.find(run.automationId);
    // Off already (by a person or by the breaker): a run still in flight changes nothing.
    if (!automation || !automation.enabled) return false;
    // A run launched before an edit changed what runs says nothing about the schedule as it is now.
    if (run.revision !== automation.revision) return false;
    if (run.state === 'completed') {
      if (!automation.failureStreak) return false;
      delete automation.failureStreak;
    } else if (run.state === 'failed' && isFailureReason(run.reason)) {
      const prev = automation.failureStreak;
      const count = prev?.reason === run.reason ? prev.count + 1 : 1;
      automation.failureStreak = { reason: run.reason, count };
      if (count >= AUTOMATION_DEFAULTS.failureBreakerRuns) {
        automation.enabled = false;
        automation.nextRunAt = null;
        automation.updatedAt = this.now();
        this.queueAttention(automation, 'failure-paused', true, run.reason);
        this.ports.log('warn', `[automation] ${automation.id} paused after ${count} scheduled runs failed (${run.reason})`);
      }
    } else {
      return false;
    }
    // The run's end is queued first: a crash between the two writes leaves a
    // failed run and the older streak, never a pause whose last run reads
    // `unknown` after the restart sweep. The streak, the pause and the notice
    // share the automations.json write.
    void this.persistRuns();
    void this.persistAutomations();
    this.emitAutomations();
    return !automation.enabled;
  }

  /** A person toggled the schedule or changed what it runs: the streak starts over and the breaker's notice is answered. */
  private resetBreaker(automation: Automation): void {
    delete automation.failureStreak;
    this.attention = this.attention.filter((x) => !(x.automationId === automation.id && x.kind === 'failure-paused'));
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
