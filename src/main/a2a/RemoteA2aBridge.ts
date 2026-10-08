import { isRemoteTaskId } from '../../shared/a2aRemote';
import {
  A2A_REMOTE_INBOUND_EVENT,
  A2A_REMOTE_NOTIFY_METHOD,
  A2A_REMOTE_RPC,
  BRAIN_UNAVAILABLE,
  canonicalPcName,
  isBrainRemoteTask,
  localSideOf,
  type A2aRemoteDeliveryResult,
  type A2aRemoteHeldReason,
  type A2aRemoteInboxItem,
  type A2aRemoteTaskState,
} from '../../shared/a2aRemoteDelivery';
import { GATED_DELIVERY_DEADLINE_MARGIN_MS, GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS } from '../../shared/freshContext';
import { TERMINAL_STATES, type Task } from '../../shared/types';
import { eventBus, type EmitInput } from '../events/EventBus';
import { brainCanReceive, onBrainReceiverChanged } from './brainReceiver';

/**
 * Cross-host A2A, receiving side in main: hand the remote work the daemon
 * holds to the renderer, then record the outcome in the daemon ledger. Two
 * kinds of work:
 *   - an inbound remote task, not yet delivered: the gated new-task delivery
 *     into its linked pane;
 *   - a reply or state change the peer sent into a remote task (an "inbox
 *     item"): a reply is written to our local pane like a local reply, a
 *     state change is announced on the event bus. Items of an inbound task
 *     wait until the task itself was delivered.
 *
 * Triggers: the daemon's `a2a.remote.inbound` broadcast, (re)connection to the
 * daemon, and a periodic backstop — so a lost broadcast only delays work by
 * one backstop period. Each trigger PULLS `listRemotePending`, which carries no
 * held work: a hold waits for a person (`retryHeld`) or the daemon's hold TTL.
 *
 * Exactly once: one delivery per task / item in flight, a delivered mark is
 * recorded before the work can be handed over again (a lost mark is retried on
 * its own, never by re-delivering), and the renderer answers `duplicate` for a
 * task it already delivered.
 *
 * A task on a brain link (this PC's Moa, which owns no pane) never reaches the
 * renderer: its delivery is an event on main's bus that wakes Moa through the
 * commander coalescer (`deliverToBrain`). Only while Moa can take it: until
 * then it is held as `brain-unavailable` (still listed as pending) and goes
 * out when the deck says Moa's state changed, or on the next pull.
 *
 * This is a main-internal call straight to the renderer, NOT through the pipe
 * router: no operator origin is stamped, so the renderer's approval gate
 * applies. LanLink's RemoteInboxBridge is deliberately not reused — it avoids
 * the A2A path on purpose.
 */

export const REMOTE_BRIDGE_BACKSTOP_MS = 5_000;
/** Retry delay after a delivery that did not land (doubles up to the max). */
export const REMOTE_BRIDGE_RETRY_MIN_MS = 10_000;
export const REMOTE_BRIDGE_RETRY_MAX_MS = 5 * 60_000;
/** A unit that found no agent this many times in a row, or for this long, is held as `no-agent`. */
export const REMOTE_BRIDGE_NO_AGENT_TRIES = 5;
export const REMOTE_BRIDGE_NO_AGENT_MS = 10 * 60_000;

export interface RemoteA2aBridgeDeps {
  /** Daemon RPC (DaemonClient.rpc in the wiring step). */
  daemonRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** The renderer bridge (`sendToRenderer(getWindow, …)`). */
  sendToRenderer: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
  /** Subscribe to daemon broadcasts; returns an unsubscribe. */
  onDaemonEvent: (listener: (event: { type?: unknown; [key: string]: unknown }) => void) => () => void;
  /** Main's event bus emit, for brain-link work (default: the `eventBus` singleton). */
  emitEvent?: (input: EmitInput) => void;
  /** Can this PC's Moa (HQ `workspaceId`) take work now? Default: the deck's answer (brainReceiver.ts). */
  brainReady?: (hqWorkspaceId: string) => boolean;
  /** Subscribe to changes of that answer. Default: brainReceiver.ts. */
  onBrainReadyChanged?: (listener: () => void) => () => void;
  backstopMs?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

type Mark =
  | { delivered: true; ptyId?: string; note?: 'pasted-not-submitted' }
  | { held: A2aRemoteHeldReason }
  | { attempted: false };

/** One unit of work: the task itself, or one inbox item of it. */
interface Work {
  key: string;
  task: Task;
  item?: A2aRemoteInboxItem;
}

export interface RetryHeldResult {
  ok: boolean;
  /** One entry per held unit tried: delivered, still held (reason), or not written. */
  results: Array<{ messageId?: string; outcome: 'delivered' | A2aRemoteHeldReason | 'not-delivered' }>;
  error?: string;
}

export class RemoteA2aBridge {
  private readonly deps: RemoteA2aBridgeDeps;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  /** A mark the daemon did not take yet: retried before anything else, never re-delivered. */
  private readonly pendingMarks = new Map<string, { taskId: string; messageId?: string; mark: Mark }>();
  private readonly retry = new Map<string, { at: number; delayMs: number }>();
  /** Brain-link work held because Moa could not take it. */
  private readonly brainWaiting = new Set<string>();
  /** Consecutive "written nowhere" answers per unit (no agent in the pane). */
  private readonly misses = new Map<string, { count: number; since: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeBrain: (() => void) | null = null;
  private running: Promise<void> | null = null;
  /** Set by stop(): no new pull or delivery starts. */
  private stopped = false;
  /** Deliveries started by a pull, still running. */
  private readonly working = new Set<Promise<unknown>>();
  private rerun = false;

  constructor(deps: RemoteA2aBridgeDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.unsubscribe = this.deps.onDaemonEvent((event) => {
      if (event?.type === A2A_REMOTE_INBOUND_EVENT) void this.trigger();
    });
    // Moa came up (or its HQ did): what was held for it goes now.
    this.unsubscribeBrain = (this.deps.onBrainReadyChanged ?? onBrainReceiverChanged)(() => {
      for (const key of [...this.retry.keys()]) if (this.brainWaiting.has(key)) this.retry.delete(key);
      void this.trigger();
    });
    this.timer = setInterval(() => void this.trigger(), this.deps.backstopMs ?? REMOTE_BRIDGE_BACKSTOP_MS);
    void this.trigger();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeBrain?.();
    this.unsubscribeBrain = null;
  }

  /** Resolves once the pull and the deliveries already started have finished (after stop()). */
  async whenIdle(): Promise<void> {
    await this.running?.catch(() => undefined);
    await Promise.allSettled([...this.working]);
  }

  /** The daemon connection (re)opened: pull at once. */
  onConnected(): void {
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
        await this.pullOnce();
      } while (this.rerun);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * A person approved delivering a HELD task to its pane as the pane is NOW:
   * the pty snapshot is retaken from the pane's current occupant and every
   * held unit of the task is handed over again (the task first). Call only on
   * that explicit approval — never automatically.
   */
  async retryHeld(taskId: string): Promise<RetryHeldResult> {
    let res: unknown;
    try {
      res = await this.deps.daemonRpc(A2A_REMOTE_RPC.held, {});
    } catch (err) {
      return { ok: false, results: [], error: err instanceof Error ? err.message : String(err) };
    }
    const task = (isRecord(res) && Array.isArray(res.tasks) ? (res.tasks as Task[]) : []).find((t) => t?.id === taskId);
    const marker = task?.metadata?.remote as A2aRemoteTaskState | undefined;
    if (!task || !marker) return { ok: false, results: [], error: 'not-held' };
    const units: Work[] = [];
    if (marker.held) units.push({ key: task.id, task });
    for (const item of marker.inbox ?? []) if (item.held) units.push({ key: itemKey(task.id, item.messageId), task, item });
    const results: RetryHeldResult['results'] = [];
    for (const unit of units) {
      if (this.inFlight.has(unit.key)) continue;
      this.inFlight.add(unit.key);
      try {
        // eslint-disable-next-line no-await-in-loop -- the task lands before its replies
        const outcome = await this.deliver(unit, true);
        results.push({ ...(unit.item ? { messageId: unit.item.messageId } : {}), outcome });
        if (!unit.item && outcome !== 'delivered') break; // its replies wait for the task
      } finally {
        this.inFlight.delete(unit.key);
      }
    }
    return { ok: true, results };
  }

  /** Test/diagnostic view: keys with a delivery in flight. */
  get inFlightIds(): string[] {
    return [...this.inFlight];
  }

  private async pullOnce(): Promise<void> {
    if (this.stopped) return;
    let res: unknown;
    try {
      res = await this.deps.daemonRpc(A2A_REMOTE_RPC.pending, {});
    } catch {
      return; // daemon down: the next trigger retries
    }
    const tasks = (isRecord(res) && Array.isArray(res.tasks) ? (res.tasks as Task[]) : [])
      .filter((t) => t && typeof t.id === 'string' && isRemoteTaskId(t.id));
    const work = tasks.flatMap(workOf);
    // Forget state for work the daemon no longer lists (delivered, held, ended).
    const listed = new Set(work.map((w) => w.key));
    for (const key of this.retry.keys()) if (!listed.has(key)) this.retry.delete(key);
    for (const key of this.pendingMarks.keys()) if (!listed.has(key)) this.pendingMarks.delete(key);
    for (const key of this.brainWaiting) if (!listed.has(key)) this.brainWaiting.delete(key);
    for (const key of this.misses.keys()) if (!listed.has(key)) this.misses.delete(key);
    for (const unit of work) {
      if (this.inFlight.has(unit.key)) continue;
      const pendingMark = this.pendingMarks.get(unit.key);
      if (pendingMark) {
        // Only the mark is retried: the body is never written again for it.
        void this.mark(unit.key, pendingMark);
        continue;
      }
      if ((unit.item ?? (unit.task.metadata.remote as A2aRemoteTaskState)).attempted) {
        // A paste was started and never confirmed (main restarted mid-way, or
        // the renderer did not answer). It may be in the pane already: a
        // person decides, it is never pasted again on its own.
        const ref = { taskId: unit.task.id, ...(unit.item ? { messageId: unit.item.messageId } : {}) };
        void this.mark(unit.key, { ...ref, mark: { held: 'delivery-unconfirmed' } });
        continue;
      }
      const wait = this.retry.get(unit.key);
      if (wait && wait.at > this.now()) continue;
      if (this.stopped) break;
      this.inFlight.add(unit.key);
      const run = this.deliver(unit, false).finally(() => {
        this.inFlight.delete(unit.key);
        this.working.delete(run);
      });
      this.working.add(run);
    }
  }

  /** Hand one unit to the renderer and record the outcome. */
  private async deliver(unit: Work, resnapshot: boolean): Promise<RetryHeldResult['results'][number]['outcome']> {
    if (isBrainRemoteTask(unit.task)) return this.deliverToBrain(unit);
    const { task, item } = unit;
    const marker = task.metadata.remote as A2aRemoteTaskState;
    // A pane task always names its local pane; one that does not is held, never guessed.
    if (!task.metadata[localSideOf(task)].paneId) {
      this.backoff(unit.key);
      if ((item ? item.held : marker.held) !== 'pane-missing') {
        await this.mark(unit.key, { taskId: task.id, ...(item ? { messageId: item.messageId } : {}), mark: { held: 'pane-missing' } });
      }
      return 'pane-missing';
    }
    const ref = { taskId: task.id, ...(item ? { messageId: item.messageId } : {}) };
    // Durable BEFORE the write: if main dies after the paste, the daemon knows
    // a paste may have happened and the unit is not pasted again on its own.
    try {
      const started = await this.deps.daemonRpc(A2A_REMOTE_RPC.mark, { ...ref, attempted: true });
      if (!isRecord(started) || started.ok !== true) throw new Error(isRecord(started) && typeof started.error === 'string' ? started.error : 'not recorded');
    } catch (err) {
      this.backoff(unit.key);
      this.deps.log?.('warn', `[a2a-remote] ${unit.key}: could not record the attempt, not delivered: ${err instanceof Error ? err.message : String(err)}`);
      return 'not-delivered';
    }
    let res: unknown;
    try {
      res = item
        ? await this.deps.sendToRenderer(A2A_REMOTE_NOTIFY_METHOD, { task, messageId: item.messageId, ...(resnapshot ? { resnapshot: true } : {}) })
        : await this.deps.sendToRenderer('a2a.task.send', this.taskParams(task, marker, resnapshot), { timeoutMs: GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS });
    } catch (err) {
      this.backoff(unit.key);
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log?.('warn', `[a2a-remote] delivery of ${unit.key} failed: ${msg}`);
      // No window: nothing was written. Anything else (a timeout) may have
      // pasted, so the attempt stands and the unit goes to a person.
      if (/BrowserWindow is not available/.test(msg)) await this.mark(unit.key, { ...ref, mark: { attempted: false } });
      return 'not-delivered';
    }
    const result = res as A2aRemoteDeliveryResult;
    if (isRecord(result) && result.ok === true && result.delivered === true) {
      this.retry.delete(unit.key);
      this.misses.delete(unit.key);
      await this.mark(unit.key, {
        ...ref,
        mark: { delivered: true, ...(result.ptyId ? { ptyId: result.ptyId } : {}), ...(result.note ? { note: result.note } : {}) },
      });
      return 'delivered';
    }
    this.backoff(unit.key);
    if (isRecord(result) && result.ok === true && result.delivered === false && result.held) {
      const current = item ? item.held : marker.held;
      if (current !== result.held) await this.mark(unit.key, { ...ref, mark: { held: result.held } });
      return result.held;
    }
    if (isRecord(result) && 'error' in result && typeof result.error === 'string') {
      this.deps.log?.('warn', `[a2a-remote] renderer refused ${unit.key}: ${result.error}`);
    }
    // Written nowhere (no agent in the pane, a person typing): the attempt is
    // cleared so a later try may write. A pane that keeps having no agent is
    // held for a person instead of being retried forever.
    const miss = this.misses.get(unit.key) ?? { count: 0, since: this.now() };
    miss.count += 1;
    this.misses.set(unit.key, miss);
    if (miss.count >= REMOTE_BRIDGE_NO_AGENT_TRIES || this.now() - miss.since >= REMOTE_BRIDGE_NO_AGENT_MS) {
      this.misses.delete(unit.key);
      await this.mark(unit.key, { ...ref, mark: { held: 'no-agent' } });
      return 'no-agent';
    }
    await this.mark(unit.key, { ...ref, mark: { attempted: false } });
    return 'not-delivered';
  }

  /**
   * Brain-link work: announce it on main's bus, then mark it delivered. A new
   * task, a reply, or a state change on a task the other PC's Moa sent is an
   * `a2a.received` (a wake-worthy kind of its own); a state change on a task
   * this Moa sent is the ordinary `a2a.task` receipt, so the existing
   * completed / failed / input-required / canceled wakes apply unchanged.
   * Pointer-only: Moa reads the body with a2a_task_query.
   */
  private async deliverToBrain(unit: Work): Promise<'delivered' | 'not-delivered' | typeof BRAIN_UNAVAILABLE> {
    const { task, item } = unit;
    const side = localSideOf(task);
    const hq = task.metadata[side].workspaceId;
    const peer = task.metadata[side === 'from' ? 'to' : 'from'];
    const state = task.status.state;
    const ref = { taskId: task.id, ...(item ? { messageId: item.messageId } : {}) };
    // Moa off, no HQ, another HQ, or the wake runtime not up: nobody would
    // see the event. Hold it (once) instead of marking it delivered.
    if (!(this.deps.brainReady ?? brainCanReceive)(hq)) {
      this.brainWaiting.add(unit.key);
      this.backoff(unit.key);
      const current = item ? item.held : (task.metadata.remote as A2aRemoteTaskState).held;
      if (current !== BRAIN_UNAVAILABLE) await this.mark(unit.key, { ...ref, mark: { held: BRAIN_UNAVAILABLE } });
      return BRAIN_UNAVAILABLE;
    }
    this.brainWaiting.delete(unit.key);
    try {
      const emit = this.deps.emitEvent ?? ((input: EmitInput): void => void eventBus.emit(input));
      if (item?.kind === 'state' && side === 'from') {
        emit({ type: 'a2a.task', workspaceId: hq, from: hq, to: peer.workspaceId, taskId: task.id, kind: state === 'canceled' ? 'cancelled' : 'updated', state });
      } else {
        // The peer names itself: only a host-name token of it travels on.
        const host = canonicalPcName(peer.name.split('/')[0]);
        emit({ type: 'a2a.received', workspaceId: hq, taskId: task.id, from: `${host}/Moa`, to: hq, item: item?.kind ?? 'task', state, host });
      }
    } catch (err) {
      this.backoff(unit.key);
      this.deps.log?.('warn', `[a2a-remote] could not announce ${unit.key} to Moa: ${err instanceof Error ? err.message : String(err)}`);
      return 'not-delivered';
    }
    this.retry.delete(unit.key);
    await this.mark(unit.key, { ...ref, mark: { delivered: true } });
    return 'delivered';
  }

  private taskParams(task: Task, marker: A2aRemoteTaskState, resnapshot: boolean): Record<string, unknown> {
    const first = task.history[0]?.parts.find((p) => p.kind === 'text');
    return {
      workspaceId: task.metadata.to.workspaceId,
      to: task.metadata.to.workspaceId,
      ...(task.metadata.to.paneId ? { paneId: task.metadata.to.paneId } : {}),
      title: task.metadata.title,
      message: first && first.kind === 'text' ? first.text : '',
      presetTaskId: task.id,
      remoteFrom: { workspaceId: task.metadata.from.workspaceId, name: task.metadata.from.name },
      // The contract marker only: local bookkeeping stays in the daemon.
      remoteMarker: { v: marker.v, linkId: marker.linkId, hostId: marker.hostId, messageId: marker.messageId, direction: marker.direction, delivered: false },
      gatedDelivery: true,
      execute: false,
      ...(resnapshot ? { resnapshot: true } : {}),
      // Stamped here because this call skips the router, which stamps it
      // for every other gated new task: nothing is written after it.
      deliveryDeadlineAt: this.now() + GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS - GATED_DELIVERY_DEADLINE_MARGIN_MS,
    };
  }

  private async mark(key: string, entry: { taskId: string; messageId?: string; mark: Mark }): Promise<void> {
    this.pendingMarks.set(key, entry);
    try {
      const res = await this.deps.daemonRpc(A2A_REMOTE_RPC.mark, {
        taskId: entry.taskId,
        ...(entry.messageId ? { messageId: entry.messageId } : {}),
        ...entry.mark,
      });
      if (isRecord(res) && res.ok === true) {
        this.pendingMarks.delete(key);
        if ('delivered' in entry.mark) this.retry.delete(key);
        return;
      }
      // Refused or unreachable: kept, and only the mark is retried on the
      // next pull (it is dropped once the daemon no longer lists the unit).
    } catch {
      // daemon unreachable: kept in pendingMarks, retried on the next pull
    }
  }

  private backoff(key: string): void {
    const prev = this.retry.get(key);
    const delayMs = prev ? Math.min(prev.delayMs * 2, REMOTE_BRIDGE_RETRY_MAX_MS) : REMOTE_BRIDGE_RETRY_MIN_MS;
    this.retry.set(key, { at: this.now() + delayMs, delayMs });
  }
}

/** The deliverable, unheld units of one listed task, the task itself first. */
function workOf(task: Task): Work[] {
  const marker = task.metadata?.remote as A2aRemoteTaskState | undefined;
  if (!marker || marker.v !== 1) return [];
  const ended = (TERMINAL_STATES as readonly string[]).includes(task.status.state);
  const out: Work[] = [];
  const taskOwed = marker.direction === 'inbound' && marker.delivered !== true;
  // `brain-unavailable` waits only for Moa: retried on every pull.
  const open = (held: string | undefined): boolean => !held || held === BRAIN_UNAVAILABLE;
  if (taskOwed && open(marker.held) && !ended) out.push({ key: task.id, task });
  for (const item of marker.inbox ?? []) {
    if (item.delivered === true || !open(item.held)) continue;
    // A reply into an inbound task waits until the task itself is in the pane.
    if (item.kind === 'reply' && taskOwed) continue;
    out.push({ key: itemKey(task.id, item.messageId), task, item });
  }
  return out;
}

function itemKey(taskId: string, messageId: string): string {
  return `${taskId}#${messageId}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
