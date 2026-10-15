// ─── Stop the factory's running work, as the owner ─────────────────────────
//
// "Run bots" off stops the bots' work (owner decision 2026-10-15). The switch
// is written first, so from that moment no wake runs and no worker starts
// (BotRuntime, fanout.rpc's launch check); then the same stop as Stop all
// runs (factory.handler.ts factorySettingsSetHandler, `off: true`), and for
// as long as the switch stays off any bot task that still registers (a
// launch that was already past its check) is stopped as it registers.
// Turning bots on again reopens nothing: a cancelled task stays cancelled,
// an interrupted wake is not replayed, and paused routines stay paused.
// Nothing is deleted by a stop: worktrees, branches, scratch folders, logs
// and the workers' conversations all stay.
// Stop all (and Stop for one bot) is the same stop while bots keep running
// (they answer chat again at once), and a bot can stop its own work
// (`stop_my_work`, which leaves its own turn running):
//   1. every running bot turn is interrupted (BotRuntime.interrupt: the wake
//      ends `interrupted`, is not replayed, and launches nothing more);
//   2. every open task a bot started is moved to `cancelled` ("stopped by
//      owner", a system write). The move wakes nobody (markStoppedByOwner),
//      and a gate that was running on the task settles nothing once it ends;
//   3. a gate running on such a task is cancelled (its process group killed);
//   4. the worker's processes are stopped: its agent and everything below it
//      first (asked to exit, killed after a grace, checked gone), then the
//      task's own panes (the daemon sessions of its workspace started in its
//      worktree, checked gone). A terminal the owner started elsewhere is
//      never touched. The worktree, its branch and the task's workspace stay,
//      so the owner can look;
//   5. the bots' routines are paused (routines.ts), until resumed;
//   6. a worker resumed after its task ended (workerReclaim.ts) has its agent
//      stopped again.
// The wake is marked stopped before it is interrupted, so the fan-out launch
// check refuses at once; a task that fan-out was already launching (it held
// an agent slot at the stop, agentSlots.ts) is stopped when it registers,
// and only such a task: new work the bot starts afterwards runs. 3 and 4 run
// even when the row could not be
// written. Rows that ended by themselves are left alone (on "Run bots" off
// their worker is stopped all the same); a task stopped before has its
// worker stopped again (a session that outlived that stop), counted only
// when one was left, so a second stop counts nothing. Only workers whose
// processes were confirmed gone are counted, and a turn that could not be
// interrupted or a gate that could not be cancelled makes the stop partial.

import type { LedgerEntry } from '../../shared/ledger';
import type { LedgerListFilter, LedgerUpdateInput, LedgerUpdateResult } from '../../daemon/ledger/TaskLedger';
import { markStoppedByOwner, unmarkStoppedByOwner } from '../deck/fanoutCallerNotify';
import { getAgentSlots } from './agentSlots';

/** The ledger summary of a task the owner stopped. */
export const STOPPED_BY_OWNER = 'stopped by owner';

/** The workspace id a stop is written as (the daemon's, like the gate). */
export const STOP_SYSTEM_WORKSPACE = 'ws-daemon';

export interface FactoryStopResult {
  ok: boolean;
  /** Bot turns that were running and were interrupted. */
  botsInterrupted: number;
  /** Workers whose processes this stop confirmed gone. */
  workersStopped: number;
  /** Open bot tasks moved to `cancelled`. */
  tasksCancelled: number;
  /** Gates that were running on those tasks and were cancelled. */
  gatesCancelled: number;
  /** Routines paused by this stop (absent: no routines are kept). */
  routinesPaused?: number;
  code?: string;
  message?: string;
}

export interface FactoryStopPorts {
  /** The bot runtime's running turns (BotRuntime.currentTurn / interrupt). */
  runtime: () => { currentTurn(botId: string): { wakeId?: string } | null; interrupt(botId: string): { ok: boolean; code?: string } } | null;
  /** Every bot id the store holds. */
  botIds: () => string[];
  ledger: {
    list(filter: LedgerListFilter): LedgerEntry[];
    get(id: string): LedgerEntry | null;
    update(input: LedgerUpdateInput): Promise<LedgerUpdateResult>;
  };
  /** The shared gate runner (isRunning / cancel), or null before it is up. */
  gates: () => { isRunning(taskId: string): boolean; cancel(taskId: string): boolean } | null;
  /** Stop the processes of a task's worker; how many sessions it confirmed
   *  stopped (0: none were left). Throws when it could not. */
  stopWorker: (entry: LedgerEntry) => Promise<number>;
  /** Whether "Run bots" is off now: while it is, every bot task that
   *  registers is stopped (installLateStopSweep). Absent: never. */
  isOff?: () => boolean;
  /** Pause the routines of one bot, or of every bot (routines.ts); how many
   *  it paused. Absent: no routines are kept. */
  pauseRoutines?: (botId?: string) => number;
  /** Stop the resumed workers of one bot, or of every bot (workerReclaim.ts):
   *  their tasks ended, so step 2 does not reach them; how many it stopped
   *  (and how many it could not). */
  stopResumed?: (botId?: string) => Promise<number | { stopped: number; failed: number }>;
  /** The tasks of a bot whose launch is under way past its launch check (an
   *  agent slot granted, not yet registered), or null when that cannot be
   *  told. Default: the factory's agent slots. */
  launchesInFlight?: (botId: string) => string[] | null;
  log?: (msg: string) => void;
  now?: () => number;
}

/** Whether a row is an open task bot `botId` (any bot when omitted) started. */
export function isOpenBotTask(row: LedgerEntry, botId?: string): boolean {
  const origin = row.dispatch?.origin;
  if (origin?.kind !== 'bot' || typeof origin.botId !== 'string' || !origin.botId) return false;
  if (botId !== undefined && origin.botId !== botId) return false;
  return row.status === 'working' || row.status === 'input_required' || row.status === 'review_requested';
}

type CancelOutcome = 'cancelled' | 'ended' | 'failed';

/** Move one open task to `cancelled` as the system; one retry on a lost race.
 *  `ended`: the row left the open statuses by itself; `failed`: the write
 *  did not land and the row is still open. */
async function cancelRow(ledger: FactoryStopPorts['ledger'], taskId: string, botId: string | undefined): Promise<CancelOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = ledger.get(taskId);
    if (!row || !isOpenBotTask(row, botId)) return 'ended';
    const r = await ledger.update({
      id: taskId,
      status: 'cancelled',
      actor: { kind: 'system', workspaceId: STOP_SYSTEM_WORKSPACE },
      expectedRev: row.rev,
      summary: STOPPED_BY_OWNER,
    });
    if (r.ok) return r.noop === true ? 'ended' : 'cancelled';
    if (r.error !== 'stale_rev') return 'failed';
  }
  const row = ledger.get(taskId);
  return row && isOpenBotTask(row, botId) ? 'failed' : 'ended';
}

/** How long after a stop a task the stopped bot's fan-out still registers
 *  (it was already launching) is stopped as it registers. */
export const LATE_STOP_WINDOW_MS = 120_000;
/** How far back a stopped task's worker is stopped again by a later stop. */
export const STOP_RETRY_MS = 24 * 3_600_000;

/** How long a stopped wake is remembered: longer than any launch of it can
 *  still be waiting (a slot wait, an approval). */
export const STOPPED_WAKE_KEEP_MS = 24 * 3_600_000;
/** wakeId → when it was stopped. */
const stoppedWakes = new Map<string, number>();
/** botId → until when, and which of its tasks (their launch was under way at
 *  the stop) are stopped as they register. `taskIds` null: which ones could
 *  not be told, so any task it registers until then is. */
const lateStops = new Map<string, { until: number; taskIds: ReadonlySet<string> | null }>();
/** botId → the wake of a bot that stopped itself (keepTurn): a task it
 *  registers while that wake still runs is stopped on registration; once the
 *  turn has ended the bot may start work again at once. */
const turnStops = new Map<string, string>();

/** Whether the owner stopped this wake: its fan-out launches nothing more,
 *  from the moment of the stop (fanout.rpc's launch check). */
export function isWakeStoppedByOwner(wakeId: string): boolean {
  return stoppedWakes.has(wakeId);
}

function rememberStoppedWake(wakeId: string, now: number): void {
  for (const [id, at] of stoppedWakes) if (now - at > STOPPED_WAKE_KEEP_MS) stoppedWakes.delete(id);
  stoppedWakes.delete(wakeId);
  stoppedWakes.set(wakeId, now);
}

function pruneLateStops(now: number): void {
  for (const [botId, l] of lateStops) if (now > l.until) lateStops.delete(botId);
}

/** Tests only: how many bots have a late stop remembered. */
export function __lateStopCountForTesting(): number {
  return lateStops.size;
}

/** Tests only. */
export function __resetFactoryStopForTesting(): void {
  stoppedWakes.clear();
  lateStops.clear();
  turnStops.clear();
}

/** Whether a row is a task the owner stopped recently (its worker is stopped again). */
function isRecentlyStopped(row: LedgerEntry, botId: string | undefined, since: number): boolean {
  const origin = row.dispatch?.origin;
  if (origin?.kind !== 'bot' || !origin.botId || (botId !== undefined && origin.botId !== botId)) return false;
  return row.status === 'cancelled' && row.summary === STOPPED_BY_OWNER && row.updatedBy.kind === 'system' && row.updatedAt >= since;
}

/** Stop one task: cancel its row, its gate and its worker. The physical
 *  stops run even when the row could not be written. `stopped`: its worker's
 *  processes were confirmed gone (some were running). `off` ("Run bots"
 *  off): a task that ended by itself meanwhile has its worker stopped too. */
async function stopTask(
  ports: FactoryStopPorts,
  row: LedgerEntry,
  botId: string | undefined,
  log: (m: string) => void,
  off = false,
): Promise<{ cancelled: boolean; stopped: boolean; gate: boolean; failed: boolean }> {
  markStoppedByOwner(row.id);
  let outcome: CancelOutcome = 'failed';
  try {
    outcome = await cancelRow(ports.ledger, row.id, botId);
  } catch (err) {
    log(`[factory] stop: task ${row.id} not cancelled: ${String(err)}`);
  }
  if (outcome !== 'cancelled') unmarkStoppedByOwner(row.id);
  // A task that ended by itself in the meantime keeps its worker, unless
  // bots are being switched off.
  if (outcome === 'ended' && !off) return { cancelled: false, stopped: false, gate: false, failed: false };
  let gate = false;
  let gateFailed = false;
  try {
    const gates = ports.gates();
    if (gates?.isRunning(row.id)) {
      gate = gates.cancel(row.id);
      gateFailed = !gate;
      if (gateFailed) log(`[factory] stop: the gate of ${row.id} was not cancelled`);
    }
  } catch (err) {
    gateFailed = true;
    log(`[factory] stop: the gate of ${row.id} was not cancelled: ${String(err)}`);
  }
  let workerOk = true;
  let sessions = 0;
  try {
    sessions = await ports.stopWorker(row);
  } catch (err) {
    workerOk = false;
    log(`[factory] stop: the worker of ${row.id} was not stopped: ${String(err)}`);
  }
  return { cancelled: outcome === 'cancelled', stopped: workerOk && sessions > 0, gate, failed: outcome === 'failed' || !workerOk || gateFailed };
}

/**
 * Stop the running work of every bot, or of `scope.botId` only, and pause
 * their routines. Never throws; the counts say what this call changed (0 for
 * work that had already ended). `ok:false` (`code: 'partial'`) when a task
 * could not be cancelled or its worker not stopped; a later stop tries those
 * again.
 *
 * `keepTurn` (a bot stopping its own work, `stop_my_work`): the running turn
 * is not interrupted — it is the caller's, and it ends by itself with the
 * bot's one line — but its wake is marked stopped all the same, so it
 * launches no further worker.
 */
export async function stopFactoryWork(ports: FactoryStopPorts, scope: { botId?: string; keepTurn?: boolean; off?: boolean } = {}): Promise<FactoryStopResult> {
  const log = ports.log ?? ((m: string) => console.warn(m));
  const now = (ports.now ?? Date.now)();
  const off = scope.off === true;
  let botsInterrupted = 0;
  let workersStopped = 0;
  let tasksCancelled = 0;
  let gatesCancelled = 0;
  let failures = 0;

  // 1. Turns first: the wake is marked stopped at once (no further launch
  //    passes the fan-out check), then interrupted; a task its fan-out was
  //    already launching is stopped when it registers (installLateStopSweep).
  let ids: string[] = [];
  try {
    ids = scope.botId !== undefined ? [scope.botId] : ports.botIds();
  } catch {
    ids = scope.botId !== undefined ? [scope.botId] : [];
  }
  const runtime = ports.runtime();
  pruneLateStops(now);
  const inFlight = ports.launchesInFlight ?? ((botId: string) => getAgentSlots()?.inFlight(botId) ?? null);
  for (const botId of ids) {
    if (scope.keepTurn !== true) {
      let taskIds: string[] | null = null;
      try {
        taskIds = inFlight(botId);
      } catch {
        taskIds = null;
      }
      lateStops.set(botId, { until: now + LATE_STOP_WINDOW_MS, taskIds: taskIds ? new Set(taskIds) : null });
    }
    if (!runtime) continue;
    try {
      const turn = runtime.currentTurn(botId);
      if (!turn) continue;
      if (turn.wakeId) rememberStoppedWake(turn.wakeId, now);
      if (scope.keepTurn === true) {
        if (turn.wakeId) turnStops.set(botId, turn.wakeId);
        continue;
      }
      const r = runtime.interrupt(botId);
      if (r.ok) botsInterrupted++;
      // A turn that ended by itself meanwhile is no failure.
      else if (r.code !== 'not_running') {
        failures++;
        log(`[factory] stop: interrupting ${botId} failed: ${r.code ?? 'refused'}`);
      }
    } catch (err) {
      failures++;
      log(`[factory] stop: interrupting ${botId} failed: ${String(err)}`);
    }
  }

  // 2–4. The open tasks, then the workers of tasks stopped before whose
  // processes may have outlived that stop.
  let open: LedgerEntry[] = [];
  let retry: LedgerEntry[] = [];
  try {
    open = ports.ledger.list({ openOnly: true }).filter((r) => isOpenBotTask(r, scope.botId));
    retry = ports.ledger.list({}).filter((r) => isRecentlyStopped(r, scope.botId, now - STOP_RETRY_MS));
  } catch (err) {
    log(`[factory] stop: the task ledger could not be read: ${String(err)}`);
    failures++;
  }
  // 5–6 begin here, before the first await: everything this stop acts on
  // is read at the moment of the stop, so work started after it (bots
  // switched on again while it runs) is left alone.
  let routinesPaused: number | undefined;
  if (ports.pauseRoutines) {
    try {
      routinesPaused = ports.pauseRoutines(scope.botId);
    } catch (err) {
      failures++;
      log(`[factory] stop: routines were not paused: ${String(err)}`);
    }
  }
  let resumed: Promise<number | { stopped: number; failed: number }> | null = null;
  try {
    resumed = ports.stopResumed?.(scope.botId) ?? null;
  } catch (err) {
    failures++;
    log(`[factory] stop: resumed workers were not stopped: ${String(err)}`);
  }
  for (const row of open) {
    const r = await stopTask(ports, row, scope.botId, log, off);
    if (r.cancelled) tasksCancelled++;
    if (r.stopped) workersStopped++;
    if (r.gate) gatesCancelled++;
    if (r.failed) failures++;
  }
  for (const row of retry) {
    // A gate an earlier stop could not cancel is cancelled now.
    try {
      const gates = ports.gates();
      if (gates?.isRunning(row.id)) {
        if (gates.cancel(row.id)) gatesCancelled++;
        else {
          failures++;
          log(`[factory] stop: the gate of ${row.id} was not cancelled`);
        }
      }
    } catch (err) {
      failures++;
      log(`[factory] stop: the gate of ${row.id} was not cancelled: ${String(err)}`);
    }
    try {
      if ((await ports.stopWorker(row)) > 0) workersStopped++;
    } catch (err) {
      failures++;
      log(`[factory] stop: the worker of ${row.id} was not stopped: ${String(err)}`);
    }
  }
  if (resumed) {
    try {
      const r = await resumed;
      if (typeof r === 'number') workersStopped += r;
      else {
        workersStopped += r.stopped;
        if (r.failed > 0) {
          failures++;
          log(`[factory] stop: ${r.failed} resumed worker(s) were not stopped`);
        }
      }
    } catch (err) {
      failures++;
      log(`[factory] stop: resumed workers were not stopped: ${String(err)}`);
    }
  }
  const counts = { botsInterrupted, workersStopped, tasksCancelled, gatesCancelled, ...(routinesPaused !== undefined ? { routinesPaused } : {}) };
  return failures > 0
    ? { ok: false, ...counts, code: 'partial', message: 'Some work could not be stopped; stop again to retry.' }
    : { ok: true, ...counts };
}

/**
 * A task whose launch was under way when the owner stopped its bot (it held
 * an agent slot then) is stopped as it registers, within
 * LATE_STOP_WINDOW_MS; a task the bot starts after the stop is not. So is
 * one a bot that stopped itself registers while the turn that stopped is
 * still running, and any bot task that registers while "Run bots" is off
 * (for as long as it is off, however late). Returns the unsubscribe.
 */
export function installLateStopSweep(ports: FactoryStopPorts & { onTransition: (fn: (t: { entry: LedgerEntry; from: string | null }) => void) => () => void }): () => void {
  const log = ports.log ?? ((m: string) => console.warn(m));
  return ports.onTransition((t) => {
    const botId = t.entry.dispatch?.origin.kind === 'bot' ? t.entry.dispatch.origin.botId : undefined;
    if (t.from !== null || !botId) return;
    let isOff = false;
    try {
      isOff = ports.isOff?.() === true;
    } catch {
      isOff = false;
    }
    if (isOff) {
      void stopTask(ports, t.entry, botId, log, true).catch((err) => log(`[factory] stop: task ${t.entry.id} registered while bots are off: ${String(err)}`));
      return;
    }
    const now = (ports.now ?? Date.now)();
    pruneLateStops(now);
    const l = lateStops.get(botId);
    const late = l !== undefined && now <= l.until && (l.taskIds === null || l.taskIds.has(t.entry.id));
    const stoppedWake = turnStops.get(botId);
    let inStoppedTurn = false;
    if (stoppedWake !== undefined) {
      try {
        inStoppedTurn = ports.runtime()?.currentTurn(botId)?.wakeId === stoppedWake;
      } catch {
        inStoppedTurn = false;
      }
      if (!inStoppedTurn) turnStops.delete(botId);
    }
    if (!late && !inStoppedTurn) return;
    void stopTask(ports, t.entry, botId, log).catch((err) => log(`[factory] stop: late task ${t.entry.id}: ${String(err)}`));
  });
}

let stopPorts: FactoryStopPorts | null = null;

/** Set by the wiring module on start (null on dispose). */
export function setFactoryStopPorts(next: FactoryStopPorts | null): void {
  stopPorts = next;
}

export function getFactoryStopPorts(): FactoryStopPorts | null {
  return stopPorts;
}
