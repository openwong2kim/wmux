import { isRemoteTaskId } from '../../shared/a2aRemote';
import { missKindOf } from '../../shared/a2aRemoteDelivery';
import { COMPANY_RENDERER_METHOD } from '../../shared/company';
import {
  companyHoldOf,
  companyHoldPhase,
  type A2aCompanyMarkParams,
  type CompanyBlockerEnd,
  type CompanyHoldReason,
} from '../../shared/companyHold';
import { GATED_DELIVERY_DEADLINE_MARGIN_MS, GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS } from '../../shared/freshContext';
import { TERMINAL_STATES, type Task } from '../../shared/types';

/**
 * Company mode, in main: deliver each company task the daemon released from
 * its blockers (shared/companyHold.ts) to its seat's pane, and tell the
 * company's CEO pane when a held task needs a person.
 *
 * Triggers: a task ending through the a2a handlers (`pullNow`: the daemon
 * releases dependents before that commit returns), each (re)connection to the
 * daemon (a bridge is made per connection and pulls on start), and a
 * periodic backstop. Each trigger PULLS `a2a.company.pending`.
 *
 * At most once per attempt: one delivery per task in flight; `attempted` is
 * recorded in the daemon BEFORE the write and nothing is written unless it
 * was; then `delivered`, `attempted: false` (the write was refused and wrote
 * nothing) or a `held` reason. A listed task already marked `attempted` was
 * started by an earlier main and never confirmed: it is held as
 * `delivery-unconfirmed` and never written again on its own (a duplicate
 * nudge makes the seat's agent start the task twice). The renderer answers
 * `duplicate` for a task it already wrote.
 *
 * CEO lines: one line per event to the company's coordinator pane, from
 * `a2a.company.held`: a released task held for a person, or a blocker of a
 * waiting task that ended failed or canceled. The daemon keeps no mark for
 * them, so what was told is remembered in memory (`told`, kept across
 * reconnects by the caller): after an app restart a line may be told once
 * more.
 *
 * This calls the renderer straight, NOT through the pipe router: no operator
 * origin is stamped, so the renderer's approval gate applies.
 */

export const COMPANY_BRIDGE_BACKSTOP_MS = 5_000;
/** Retry delay after a write that did not land (doubles up to the max). */
export const COMPANY_BRIDGE_RETRY_MIN_MS = 10_000;
export const COMPANY_BRIDGE_RETRY_MAX_MS = 5 * 60_000;
/** A task whose pane had no agent this many times in a row, or for this long, is held as `no-agent`. */
export const COMPANY_BRIDGE_NO_AGENT_TRIES = 5;
export const COMPANY_BRIDGE_NO_AGENT_MS = 10 * 60_000;
/** A CEO line not written after this many tries is given up (the board still shows the hold). */
export const COMPANY_CEO_LINE_TRIES = 5;
/** Main's wait on the renderer for one CEO line. */
export const COMPANY_CEO_LINE_TIMEOUT_MS = 10_000;

/** The daemon's company RPCs (DaemonClient). */
export interface CompanyReleaseDaemon {
  a2aCompanyPending(): Promise<unknown>;
  a2aCompanyHeld(): Promise<unknown>;
  a2aCompanyMark(params: A2aCompanyMarkParams): Promise<unknown>;
}

export interface CompanyReleaseBridgeDeps {
  daemon: CompanyReleaseDaemon;
  /** The renderer bridge (`sendToRenderer(getWindow, …)`). */
  sendToRenderer: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
  /** CEO lines already told, by event key; pass one set to keep it across reconnects. */
  told?: Set<string>;
  /**
   * Deliveries still running and marks the daemon has not taken; pass one of
   * each to keep them across reconnects: a write a stopped bridge started is
   * not judged unconfirmed while it runs, and its mark is retried.
   */
  inFlight?: Set<string>;
  pendingMarks?: Map<string, CompanyReleaseMark>;
  backstopMs?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

/** A mark main records on a task once a delivery has an outcome. */
export type CompanyReleaseMark = { attempted: false } | { delivered: true; ptyId?: string } | { held: CompanyHoldReason };
type Mark = CompanyReleaseMark;

/** One thing the CEO is told about a held task. */
export type CompanyCeoEvent =
  | { key: string; kind: 'held'; held: CompanyHoldReason }
  | { key: string; kind: 'blocker-ended'; blocker: CompanyBlockerEnd };

export class CompanyReleaseBridge {
  private readonly deps: CompanyReleaseBridgeDeps;
  private readonly now: () => number;
  private readonly told: Set<string>;
  private readonly inFlight: Set<string>;
  /** A mark the daemon did not take yet: retried before anything else, never re-delivered. */
  private readonly pendingMarks: Map<string, Mark>;
  private readonly retry = new Map<string, { at: number; delayMs: number }>();
  /** "No agent in the pane" answers per task since the first one; a delivery or any other answer starts them again. */
  private readonly noAgent = new Map<string, { count: number; since: number }>();
  private readonly ceoInFlight = new Set<string>();
  private readonly ceoRetry = new Map<string, { at: number; delayMs: number }>();
  private readonly ceoMisses = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  /** Set by stop(): no new pull or delivery starts. */
  private stopped = false;
  /** Deliveries and CEO lines started by a pull, still running. */
  private readonly working = new Set<Promise<unknown>>();

  constructor(deps: CompanyReleaseBridgeDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.told = deps.told ?? new Set<string>();
    this.inFlight = deps.inFlight ?? new Set<string>();
    this.pendingMarks = deps.pendingMarks ?? new Map<string, Mark>();
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.trigger(), this.deps.backstopMs ?? COMPANY_BRIDGE_BACKSTOP_MS);
    void this.trigger();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once the pull and the work it started have finished. */
  async whenIdle(): Promise<void> {
    await this.running?.catch(() => undefined);
    await Promise.allSettled([...this.working]);
  }

  /** A task just ended, or a hold was released at create: pull now. */
  pullNow(): void {
    void this.trigger();
  }

  /** Pull and hand over. Concurrent triggers coalesce into one follow-up pull. */
  trigger(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.pullPending();
        await this.pullHeld();
      } while (this.rerun && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private track(run: Promise<unknown>): void {
    this.working.add(run);
    void run.finally(() => this.working.delete(run));
  }

  private async pullPending(): Promise<void> {
    if (this.stopped) return;
    let res: unknown;
    try {
      res = await this.deps.daemon.a2aCompanyPending();
    } catch {
      return; // daemon down: the next trigger retries
    }
    const tasks = tasksOf(res).filter(isOwed);
    // Forget state for tasks the daemon no longer lists (delivered, held, ended).
    const listed = new Set(tasks.map((t) => t.id));
    for (const map of [this.retry, this.pendingMarks, this.noAgent]) {
      for (const key of map.keys()) if (!listed.has(key)) map.delete(key);
    }
    for (const task of tasks) {
      if (this.stopped) break;
      if (this.inFlight.has(task.id)) continue;
      const pendingMark = this.pendingMarks.get(task.id);
      if (pendingMark) {
        // Only the mark is retried: the task is never written again for it.
        this.track(this.mark(task.id, pendingMark));
        continue;
      }
      if (companyHoldOf(task)?.attempted) {
        // A write was started and never confirmed (main restarted mid-way, or
        // the renderer did not answer). It may be in the pane already: a
        // person decides, it is never written again on its own.
        this.track(this.mark(task.id, { held: 'delivery-unconfirmed' }));
        continue;
      }
      const wait = this.retry.get(task.id);
      if (wait && wait.at > this.now()) continue;
      this.inFlight.add(task.id);
      this.track(this.deliver(task).finally(() => this.inFlight.delete(task.id)));
    }
  }

  /** Write one released task to its seat's pane and record the outcome. */
  private async deliver(task: Task): Promise<void> {
    // A company task always names its seat's pane; one that does not is held, never guessed.
    if (!task.metadata.to.paneId) {
      this.backoff(task.id);
      await this.mark(task.id, { held: 'pane-missing' });
      return;
    }
    // Durable BEFORE the write: if main dies after it, the daemon knows a
    // write may have happened and the task is not written again on its own.
    try {
      const started = await this.deps.daemon.a2aCompanyMark({ taskId: task.id, attempted: true });
      if (!isRecord(started) || started.ok !== true) {
        throw new Error(isRecord(started) && typeof started.error === 'string' ? started.error : 'not recorded');
      }
    } catch (err) {
      this.backoff(task.id);
      this.deps.log?.('warn', `[company] ${task.id}: could not record the attempt, not delivered: ${errorText(err)}`);
      return;
    }
    let res: unknown;
    try {
      res = await this.deps.sendToRenderer(COMPANY_RENDERER_METHOD.deliver, {
        task,
        // Stamped here: this call skips the router, and nothing is written after it.
        deliveryDeadlineAt: this.now() + GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS - GATED_DELIVERY_DEADLINE_MARGIN_MS,
      }, { timeoutMs: GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS });
    } catch (err) {
      this.backoff(task.id);
      const msg = errorText(err);
      this.deps.log?.('warn', `[company] delivery of ${task.id} failed: ${msg}`);
      // No window: nothing was written. Anything else (a timeout) may have
      // written it, so the attempt stands and the task goes to a person.
      if (/BrowserWindow is not available/.test(msg)) await this.mark(task.id, { attempted: false });
      return;
    }
    if (isRecord(res) && res.ok === true && res.delivered === true) {
      this.retry.delete(task.id);
      this.noAgent.delete(task.id);
      await this.mark(task.id, { delivered: true, ...(typeof res.ptyId === 'string' && res.ptyId ? { ptyId: res.ptyId } : {}) });
      return;
    }
    this.backoff(task.id);
    if (isRecord(res) && res.ok === true && res.held === 'pane-missing') {
      await this.mark(task.id, { held: 'pane-missing' });
      return;
    }
    if (isRecord(res) && typeof res.error === 'string') {
      this.deps.log?.('warn', `[company] renderer refused ${task.id}: ${res.error}`);
    }
    // Written nowhere: the attempt is cleared so a later try may write. A
    // pane with no agent is held for a person once that has gone on too
    // long; an agent behind a prompt, or a person typing, retries at the base
    // delay; anything else backs off.
    const kind = isRecord(res) && 'reason' in res ? missKindOf(res.reason) : 'retry';
    if (kind === 'no-agent') {
      const miss = this.noAgent.get(task.id) ?? { count: 0, since: this.now() };
      miss.count += 1;
      this.noAgent.set(task.id, miss);
      if (miss.count >= COMPANY_BRIDGE_NO_AGENT_TRIES || this.now() - miss.since >= COMPANY_BRIDGE_NO_AGENT_MS) {
        this.noAgent.delete(task.id);
        await this.mark(task.id, { held: 'no-agent' });
        return;
      }
    } else {
      this.noAgent.delete(task.id);
      if (kind === 'agent-prompt' || kind === 'user-typing') {
        this.retry.set(task.id, { at: this.now() + COMPANY_BRIDGE_RETRY_MIN_MS, delayMs: COMPANY_BRIDGE_RETRY_MIN_MS });
      }
    }
    await this.mark(task.id, { attempted: false });
  }

  private async mark(taskId: string, mark: Mark): Promise<void> {
    this.pendingMarks.set(taskId, mark);
    try {
      const res = await this.deps.daemon.a2aCompanyMark({ taskId, ...mark } as A2aCompanyMarkParams);
      if (isRecord(res) && res.ok === true) {
        this.pendingMarks.delete(taskId);
        return;
      }
      this.deps.log?.('warn', `[company] mark of ${taskId} not taken: ${isRecord(res) && typeof res.error === 'string' ? res.error : 'no answer'}`);
      // Refused or unreachable: kept, and only the mark is retried on the
      // next pull (it is dropped once the daemon no longer lists the task).
    } catch {
      // daemon unreachable: kept in pendingMarks, retried on the next pull
    }
  }

  private async pullHeld(): Promise<void> {
    if (this.stopped) return;
    let res: unknown;
    try {
      res = await this.deps.daemon.a2aCompanyHeld();
    } catch {
      return;
    }
    const tasks = tasksOf(res).filter((t) => !isRemoteTaskId(t.id) && !isEnded(t));
    // A task no longer listed was sent, canceled or ended: its lines are done.
    const listed = new Set(tasks.map((t) => t.id));
    for (const key of this.told) if (!listed.has(taskIdOfKey(key))) this.told.delete(key);
    for (const map of [this.ceoRetry, this.ceoMisses]) {
      for (const key of map.keys()) if (!listed.has(taskIdOfKey(key))) map.delete(key);
    }
    for (const task of tasks) {
      for (const event of companyCeoEventsOf(task)) {
        if (this.stopped) return;
        if (this.told.has(event.key) || this.ceoInFlight.has(event.key)) continue;
        const wait = this.ceoRetry.get(event.key);
        if (wait && wait.at > this.now()) continue;
        this.ceoInFlight.add(event.key);
        this.track(this.tellCeo(task, event).finally(() => this.ceoInFlight.delete(event.key)));
      }
    }
  }

  /** One line to the company's CEO pane. Told once written; given up after a few misses. */
  private async tellCeo(task: Task, event: CompanyCeoEvent): Promise<void> {
    let res: unknown;
    try {
      res = await this.deps.sendToRenderer(COMPANY_RENDERER_METHOD.ceoLine, {
        task,
        kind: event.kind,
        ...(event.kind === 'held' ? { held: event.held } : { blocker: event.blocker }),
      }, { timeoutMs: COMPANY_CEO_LINE_TIMEOUT_MS });
    } catch (err) {
      const msg = errorText(err);
      // No window: nothing was written, try again. Anything else (a timeout)
      // may have written it: it counts as told rather than said twice.
      if (/BrowserWindow is not available/.test(msg)) {
        this.ceoMiss(event.key);
        return;
      }
      this.deps.log?.('warn', `[company] CEO line for ${task.id} unconfirmed: ${msg}`);
      this.told.add(event.key);
      return;
    }
    if (isRecord(res) && res.ok === true && res.delivered === true) {
      this.told.add(event.key);
      this.ceoMisses.delete(event.key);
      this.ceoRetry.delete(event.key);
      return;
    }
    const reason = isRecord(res) && typeof res.reason === 'string' ? res.reason : isRecord(res) && typeof res.error === 'string' ? res.error : 'not written';
    // No CEO pane, or no agent in it: nobody would read the line; the hold
    // stays on the board for a person.
    if (reason === 'no_coordinator' || reason === 'no_agent_pane') {
      this.deps.log?.('info', `[company] CEO line for ${task.id} not written: ${reason}`);
      this.told.add(event.key);
      return;
    }
    this.ceoMiss(event.key);
  }

  private ceoMiss(key: string): void {
    const misses = (this.ceoMisses.get(key) ?? 0) + 1;
    if (misses >= COMPANY_CEO_LINE_TRIES) {
      this.deps.log?.('warn', `[company] CEO line ${key} given up after ${misses} tries`);
      this.told.add(key);
      this.ceoMisses.delete(key);
      this.ceoRetry.delete(key);
      return;
    }
    this.ceoMisses.set(key, misses);
    const prev = this.ceoRetry.get(key);
    const delayMs = prev ? Math.min(prev.delayMs * 2, COMPANY_BRIDGE_RETRY_MAX_MS) : COMPANY_BRIDGE_RETRY_MIN_MS;
    this.ceoRetry.set(key, { at: this.now() + delayMs, delayMs });
  }

  private backoff(taskId: string): void {
    const prev = this.retry.get(taskId);
    const delayMs = prev ? Math.min(prev.delayMs * 2, COMPANY_BRIDGE_RETRY_MAX_MS) : COMPANY_BRIDGE_RETRY_MIN_MS;
    this.retry.set(taskId, { at: this.now() + delayMs, delayMs });
  }
}

/**
 * What the CEO is told about one task from `a2a.company.held`: it is held for
 * a person (its reason), and each blocker it still waits on that ended
 * failed or canceled (each end once, by when it ended). Each has a key naming
 * the task first.
 */
export function companyCeoEventsOf(task: Task): CompanyCeoEvent[] {
  const marker = companyHoldOf(task);
  if (!marker) return [];
  const events: CompanyCeoEvent[] = [];
  const phase = companyHoldPhase(marker);
  if (phase === 'held' && marker.held) {
    events.push({ key: `${task.id}|held|${marker.held}`, kind: 'held', held: marker.held });
  }
  // A delivered task is the seat's now: a blocker that ends later is not news for it.
  if (phase === 'delivered') return events;
  for (const ended of marker.blockerEnded ?? []) {
    if (!marker.waitingOn.includes(ended.id)) continue;
    // When it ended, so a blocker that ends again after a reopen is told again.
    const at = 'at' in ended && typeof ended.at === 'string' && ended.at ? `|${ended.at}` : '';
    events.push({ key: `${task.id}|ended|${ended.id}|${ended.state}${at}`, kind: 'blocker-ended', blocker: ended });
  }
  return events;
}

function taskIdOfKey(key: string): string {
  const bar = key.indexOf('|');
  return bar < 0 ? key : key.slice(0, bar);
}

function tasksOf(res: unknown): Task[] {
  const tasks = isRecord(res) && Array.isArray(res.tasks) ? (res.tasks as unknown[]) : [];
  return tasks.filter((t): t is Task => isRecord(t) && typeof t.id === 'string' && isRecord(t.metadata) && isRecord(t.status));
}

function isEnded(task: Task): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(task.status.state);
}

/** A local company task released from its blockers, not delivered, not held, not ended. */
function isOwed(task: Task): boolean {
  const marker = companyHoldOf(task);
  return !isRemoteTaskId(task.id) && !!marker && !isEnded(task) && companyHoldPhase(marker) === 'owed';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
