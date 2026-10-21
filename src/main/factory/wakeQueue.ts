// ─── Wake queue — `<wmuxDir>/factory/wake-queue.json` ──────────────────────
//
// One queued turn per item, per bot (shared/wake.ts). Main-owned and
// persisted, so wakes survive an app restart. Rules:
//
// - Order: priority 0 (human) before 1 (handoff/verdict/merge) before 2
//   (batched facts), then oldest first; an item whose `notBefore` is in the
//   future is held.
// - Batching: a facts wake merges into a still-queued facts item of the same
//   bot and trigger, up to the trigger's batch max. With a batch window the
//   first item is held until `enqueuedAt + windowMs`, so the window really
//   collects; without one it merges only while it still waits.
// - Duplicates: a facts wake whose facts are all already in a live or
//   finished item of that bot is dropped `duplicate`. A keyed wake — a
//   handoff (its handoff id) or a human message (its clientMessageId) — that
//   the bot already has in any state but `dropped` is not queued again:
//   enqueue returns that item, so a redelivery or a retry is idempotent.
// - Caps: at most PER_BOT_QUEUE_CAP queued items per bot (`queue_full`); a bot
//   that is disabled gets nothing (`bot_disabled`), nor a wake that names a
//   workspace other than its own (`cross_workspace`); facts, schedule and
//   routine wakes expire after FACT_TTL_MS (`expired`, checked when the item
//   would run).
//   A wake marked `overCap` (an owner's message, the answer to a bot's own
//   question) may go past the cap, by at most OVER_CAP_RESERVE of its kind.
// - Restart (R8): an item that was `running` when the app quit becomes
//   `interrupted` on load and is never replayed by itself; a
//   `wake.interrupted` hook reports it.
//
// A dropped wake is kept as a record (state `dropped` + code) and `enqueue`
// returns null for it. Finished records are pruned by age and count.

import { isGuestId, sanitizeGuestName } from '../../shared/guestBots';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { BOT_ID_RE, type BotTrigger } from '../../shared/bot';
import { WAKE_LIMITS, wakeReasonDedupeKey, type WakeItem, type WakeReason, type WakeState } from '../../shared/wake';
import { parseThreadId, type ThreadId } from '../../shared/room';
import { emitBotHook } from './botHooks';
import { sanitizeTriggers } from './botStore';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';
import { redactStoredSecretsDeep } from './secretRedaction';
import { sanitizeHeldFanoutArgs } from './heldFanouts';
import { FANOUT_MAX_TASKS } from '../../shared/workTask';

export const WAKE_QUEUE_VERSION = 1 as const;

/** What the trigger engine and the handoff router call (§14). */
export interface WakeSinkApi {
  enqueue(input: WakeEnqueueInput): WakeItem | null;
  /** The bot's `guest` wakes waiting to run (GUEST_WAKES_QUEUED_PER_BOT). */
  queuedGuestWakes?(botId: string): number;
  /** Resolves once every change so far is on disk (absent: in memory only). */
  flush?(): Promise<void>;
}

export interface WakeEnqueueInput {
  botId: string;
  workspaceId: string;
  reason: WakeReason;
  priority: 0 | 1 | 2;
  /** The room thread the wake is about; a malformed id is ignored. */
  threadId?: ThreadId;
  /** A wake that must reach the bot even when its queue is at the cap: the
   *  owner's message, or the answer to the bot's own question. Bounded by
   *  OVER_CAP_RESERVE; not persisted. */
  overCap?: true;
}

/** How far past PER_BOT_QUEUE_CAP an `overCap` wake may go, by reason kind.
 *  A handoff of this kind is an answer: one per question, and a workspace
 *  holds at most 20 open questions (HANDOFF_STORE_LIMITS.OPEN_ASKS_PER_WORKSPACE).
 *  Human messages are rare; a few are enough. Other kinds get no reserve. */
export const OVER_CAP_RESERVE: Readonly<Partial<Record<WakeReason['kind'], number>>> = { handoff: 20, human: 8 };

export type WakeDropCode = NonNullable<WakeItem['dropped']>['code'];

/** Finished records kept at most this long, and at most this many. */
export const WAKE_RECORD_RETAIN_MS = 7 * 24 * 3_600_000;
/** How long the record of an owner's message is kept whatever the count: a
 *  retry of the message within it queues no second wake. */
export const HUMAN_RETRY_WINDOW_MS = 24 * 3_600_000;
/** Most external guests' wakes one bot holds queued at once: the rest of
 *  its queue stays for the owner's and the factory's work. */
export const GUEST_WAKES_QUEUED_PER_BOT = 3;
export const WAKE_RECORD_MAX = 500;
const FACT_IDS_MAX = 100;
const HUMAN_TEXT_MAX = 16 * 1024;
const ID_MAX = 200;

const LIVE: ReadonlySet<WakeState> = new Set(['queued', 'running']);

/** The dedupe key of a wake that carries one (shared/wake.ts). */
const keyOf = wakeReasonDedupeKey;

function triggerKey(t: BotTrigger): string {
  return JSON.stringify([t.kind, t.filter ?? null]);
}

function boundedId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= ID_MAX;
}

/** A well-formed reason (a fresh object), or null. */
export function sanitizeWakeReason(raw: unknown): WakeReason | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case 'facts': {
      if (!Array.isArray(r.factIds) || r.factIds.length === 0 || r.factIds.length > FACT_IDS_MAX) return null;
      if (!r.factIds.every(boundedId)) return null;
      const triggers = sanitizeTriggers([r.trigger]);
      if (!triggers) return null;
      return { kind: 'facts', factIds: [...new Set(r.factIds as string[])], trigger: triggers[0] };
    }
    case 'handoff':
      return boundedId(r.handoffId) ? { kind: 'handoff', handoffId: r.handoffId } : null;
    case 'human': {
      if (typeof r.text !== 'string' || r.text.trim().length === 0 || r.text.length > HUMAN_TEXT_MAX) return null;
      if (r.source !== 'desktop' && r.source !== 'phone') return null;
      if (r.clientMessageId !== undefined && !boundedId(r.clientMessageId)) return null;
      if (r.runId !== undefined && !boundedId(r.runId)) return null;
      if (r.room !== undefined && r.room !== true) return null;
      if (r.lead !== undefined && r.lead !== true) return null;
      if (r.roomWide !== undefined && r.roomWide !== true) return null;
      if (r.roomAnswerer !== undefined && !boundedId(r.roomAnswerer)) return null;
      return {
        kind: 'human',
        text: r.text,
        source: r.source,
        ...(r.clientMessageId !== undefined ? { clientMessageId: r.clientMessageId as string } : {}),
        ...(r.runId !== undefined ? { runId: r.runId as string } : {}),
        ...(r.room === true ? { room: true as const } : {}),
        ...(r.lead === true ? { lead: true as const } : {}),
        ...(r.roomWide === true ? { roomWide: true as const } : {}),
        ...(r.roomAnswerer !== undefined ? { roomAnswerer: r.roomAnswerer as string } : {}),
      };
    }
    case 'schedule':
      return boundedId(r.scheduleId) ? { kind: 'schedule', scheduleId: r.scheduleId } : null;
    case 'manual':
      return r.by === 'human' ? { kind: 'manual', by: 'human' } : null;
    case 'routine':
      return boundedId(r.routineId) && Number.isSafeInteger(r.dueAt) ? { kind: 'routine', routineId: r.routineId, dueAt: r.dueAt as number } : null;
    case 'mention':
      return boundedId(r.cardId) && boundedId(r.handoffId) && typeof r.fromBotId === 'string' && BOT_ID_RE.test(r.fromBotId)
        ? { kind: 'mention', cardId: r.cardId, handoffId: r.handoffId, fromBotId: r.fromBotId }
        : null;
    case 'intro':
      return { kind: 'intro' };
    case 'guest': {
      if (!isGuestId(r.guestId) || !boundedId(r.cardId)) return null;
      const guestName = sanitizeGuestName(r.guestName);
      if (!guestName || typeof r.text !== 'string' || r.text.trim().length === 0 || r.text.length > HUMAN_TEXT_MAX) return null;
      return { kind: 'guest', guestId: r.guestId, guestName, cardId: r.cardId, text: r.text };
    }
    case 'held_fanout': {
      if (!boundedId(r.heldId) || !Number.isSafeInteger(r.heldAt) || typeof r.tainted !== 'boolean') return null;
      if (!Array.isArray(r.titles) || r.titles.length === 0 || r.titles.length > FANOUT_MAX_TASKS || !r.titles.every((t) => typeof t === 'string' && t.length <= 256)) return null;
      const args = r.args === undefined ? undefined : sanitizeHeldFanoutArgs(r.args);
      if (args === null) return null;
      if (r.handoffId !== undefined && !boundedId(r.handoffId)) return null;
      if (r.fingerprint !== undefined && (typeof r.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(r.fingerprint))) return null;
      return {
        kind: 'held_fanout', heldId: r.heldId, heldAt: r.heldAt as number, titles: [...(r.titles as string[])],
        ...(args ? { args } : {}), ...(r.fingerprint !== undefined ? { fingerprint: r.fingerprint as string } : {}), tainted: r.tainted,
        ...(typeof r.guest === 'boolean' ? { guest: r.guest } : {}),
        ...(r.handoffId !== undefined ? { handoffId: r.handoffId as string } : {}),
      };
    }
    default:
      return null;
  }
}

const STATES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'dropped', 'parked', 'interrupted']);
const DROP_CODES: ReadonlySet<string> = new Set(['budget', 'duplicate', 'bot_disabled', 'expired', 'queue_full', 'cross_workspace']);

function parseWakeItem(raw: unknown): WakeItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!boundedId(r.id) || !boundedId(r.botId) || !boundedId(r.workspaceId)) return null;
  const reason = sanitizeWakeReason(r.reason);
  if (!reason) return null;
  if (r.priority !== 0 && r.priority !== 1 && r.priority !== 2) return null;
  if (!Number.isSafeInteger(r.enqueuedAt) || !Number.isSafeInteger(r.attempts)) return null;
  if (r.notBefore !== undefined && !Number.isSafeInteger(r.notBefore)) return null;
  if (typeof r.state !== 'string' || !STATES.has(r.state)) return null;
  const threadId = r.threadId === undefined ? undefined : parseThreadId(r.threadId);
  if (threadId === null) return null;
  let dropped: WakeItem['dropped'];
  if (r.dropped !== undefined) {
    const code = (r.dropped as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !DROP_CODES.has(code)) return null;
    dropped = { code: code as WakeDropCode };
  }
  return {
    id: r.id,
    botId: r.botId,
    workspaceId: r.workspaceId,
    reason,
    ...(threadId ? { threadId } : {}),
    priority: r.priority,
    enqueuedAt: r.enqueuedAt as number,
    ...(r.notBefore !== undefined ? { notBefore: r.notBefore as number } : {}),
    attempts: r.attempts as number,
    state: r.state as WakeState,
    ...(dropped ? { dropped } : {}),
  };
}

function copyItem(i: WakeItem): WakeItem {
  return parseWakeItem(JSON.parse(JSON.stringify(i))) as WakeItem;
}

export interface WakeQueueOptions {
  now?: () => number;
  newId?: () => string;
  /** Whether a bot exists and is enabled. Absent: every bot is. */
  isBotEnabled?: (botId: string) => boolean;
  /** A bot's own workspace (null: not known). A wake that names another
   *  is dropped `cross_workspace`: a bot runs in its own workspace only,
   *  which keeps a guest workspace an island. Absent: not checked. */
  botWorkspace?: (botId: string) => string | null;
  /** Called after every change (the runtime re-schedules on it). */
  onChange?: () => void;
}

export function wakeQueuePath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', 'wake-queue.json');
}

export class WakeQueue implements WakeSinkApi {
  private items: WakeItem[] = [];
  private readonly persister: FilePersister;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly file: string, private readonly opts: WakeQueueOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `w-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`);
    this.persister = createFilePersister(file, () => ({ version: WAKE_QUEUE_VERSION, items: this.items }));
  }

  /** Read the file (missing → empty) and turn every `running` item into
   *  `interrupted` (R8). Throws on another version. Returns those items. */
  load(): WakeItem[] {
    const raw = readVersionedFile(this.file, WAKE_QUEUE_VERSION);
    const list = raw && Array.isArray(raw.items) ? raw.items : [];
    this.items = [];
    const seen = new Set<string>();
    for (const entry of list) {
      const item = parseWakeItem(entry);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      this.items.push(item);
    }
    const interrupted: WakeItem[] = [];
    for (const item of this.items) {
      if (item.state !== 'running') continue;
      item.state = 'interrupted';
      interrupted.push(copyItem(item));
    }
    if (interrupted.length > 0) this.changed();
    const at = this.now();
    for (const item of interrupted) {
      emitBotHook({
        type: 'wake.interrupted', botId: item.botId, workspaceId: item.workspaceId, wakeId: item.id,
        ...(item.threadId ? { threadId: item.threadId } : {}),
        at,
      });
    }
    return interrupted;
  }

  flush(): Promise<void> {
    return this.persister.schedule();
  }

  private changed(): void {
    this.prune();
    void this.persister.schedule().catch((err) => console.warn(`[factory] wake-queue.json write failed: ${String(err)}`));
    try {
      this.opts.onChange?.();
    } catch {
      /* the listener never breaks the queue */
    }
  }

  private prune(): void {
    const now = this.now();
    const finished = this.items.filter((i) => !LIVE.has(i.state) && i.state !== 'parked');
    let drop = new Set(finished.filter((i) => i.enqueuedAt < now - WAKE_RECORD_RETAIN_MS).map((i) => i.id));
    // An owner's or a guest's message that was taken keeps its record,
    // whatever the count, for HUMAN_RETRY_WINDOW_MS: a retry of it within
    // that time must find it (humanMessage.ts, guestMessage.ts). Past that it
    // counts like any other record (a group room makes one message a wake
    // per bot).
    const countable = finished.filter((i) => !drop.has(i.id)
      && !(i.state !== 'dropped' && (i.reason.kind === 'human' || i.reason.kind === 'guest') && keyOf(i.reason) !== null && i.enqueuedAt >= now - HUMAN_RETRY_WINDOW_MS));
    if (countable.length > WAKE_RECORD_MAX) {
      const oldest = [...countable].sort((a, b) => a.enqueuedAt - b.enqueuedAt).slice(0, countable.length - WAKE_RECORD_MAX);
      drop = new Set([...drop, ...oldest.map((i) => i.id)]);
    }
    if (drop.size > 0) this.items = this.items.filter((i) => !drop.has(i.id));
  }

  private record(input: WakeEnqueueInput, code: WakeDropCode): null {
    this.items.push({
      id: this.newId(),
      botId: input.botId,
      workspaceId: input.workspaceId,
      reason: input.reason,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      priority: input.priority,
      enqueuedAt: this.now(),
      attempts: 0,
      state: 'dropped',
      dropped: { code },
    });
    this.changed();
    return null;
  }

  enqueue(input: WakeEnqueueInput): WakeItem | null {
    if (!input || !boundedId(input.botId) || !boundedId(input.workspaceId)) return null;
    if (input.priority !== 0 && input.priority !== 1 && input.priority !== 2) return null;
    // A stored bot secret never lands in wake-queue.json (secretRedaction.ts).
    const reason = redactStoredSecretsDeep(sanitizeWakeReason(input.reason));
    if (!reason) return null;
    const threadId = input.threadId === undefined ? undefined : parseThreadId(input.threadId) ?? undefined;
    const req: WakeEnqueueInput = {
      botId: input.botId,
      workspaceId: input.workspaceId,
      reason,
      priority: input.priority,
      ...(threadId ? { threadId } : {}),
    };
    if (this.opts.isBotEnabled && !this.opts.isBotEnabled(input.botId)) return this.record(req, 'bot_disabled');
    if (this.opts.botWorkspace && this.opts.botWorkspace(input.botId) !== input.workspaceId) return this.record(req, 'cross_workspace');
    const mine = this.items.filter((i) => i.botId === input.botId);

    if (reason.kind === 'facts') {
      const known = new Set<string>();
      for (const i of mine) {
        if (i.reason.kind === 'facts' && i.state !== 'dropped') for (const f of i.reason.factIds) known.add(f);
      }
      const fresh = reason.factIds.filter((f) => !known.has(f));
      if (fresh.length === 0) return this.record(req, 'duplicate');
      const max = reason.trigger.batch?.max ?? FACT_IDS_MAX;
      const key = triggerKey(reason.trigger);
      const target = mine.find(
        (i) => i.state === 'queued'
          && i.reason.kind === 'facts'
          && triggerKey(i.reason.trigger) === key
          && i.threadId === threadId
          && i.reason.factIds.length + fresh.length <= max,
      );
      if (target && target.reason.kind === 'facts') {
        target.reason.factIds.push(...fresh);
        this.changed();
        return copyItem(target);
      }
      reason.factIds = fresh;
    }
    const key = keyOf(reason);
    if (key) {
      const prior = mine.find((i) => i.state !== 'dropped' && keyOf(i.reason) === key);
      if (prior) return copyItem(prior);
    }
    if (reason.kind === 'guest' && this.queuedGuestWakes(input.botId) >= GUEST_WAKES_QUEUED_PER_BOT) return this.record(req, 'queue_full');
    const cap = WAKE_LIMITS.PER_BOT_QUEUE_CAP + (input.overCap === true ? OVER_CAP_RESERVE[reason.kind] ?? 0 : 0);
    if (mine.filter((i) => i.state === 'queued').length >= cap) return this.record(req, 'queue_full');
    const now = this.now();
    const windowMs = reason.kind === 'facts' ? reason.trigger.batch?.windowMs ?? 0 : 0;
    const item: WakeItem = {
      id: this.newId(),
      botId: input.botId,
      workspaceId: input.workspaceId,
      reason,
      ...(threadId ? { threadId } : {}),
      priority: input.priority,
      enqueuedAt: now,
      ...(windowMs > 0 ? { notBefore: now + windowMs } : {}),
      attempts: 0,
      state: 'queued',
    };
    this.items.push(item);
    this.changed();
    return copyItem(item);
  }

  get(id: string): WakeItem | null {
    const i = this.items.find((x) => x.id === id);
    return i ? copyItem(i) : null;
  }

  queuedGuestWakes(botId: string): number {
    return this.items.filter((i) => i.botId === botId && i.state === 'queued' && i.reason.kind === 'guest').length;
  }

  list(filter: { botId?: string; states?: readonly WakeState[] } = {}): WakeItem[] {
    return this.items
      .filter((i) => (!filter.botId || i.botId === filter.botId) && (!filter.states || filter.states.includes(i.state)))
      .map(copyItem);
  }

  /** Queued items of a bot. */
  depth(botId: string): number {
    return this.items.filter((i) => i.botId === botId && i.state === 'queued').length;
  }

  private expired(i: WakeItem, now: number): boolean {
    if (i.reason.kind !== 'facts' && i.reason.kind !== 'schedule' && i.reason.kind !== 'routine' && i.reason.kind !== 'held_fanout') return false;
    return now - i.enqueuedAt > WAKE_LIMITS.FACT_TTL_MS;
  }

  /** The item the bot should run next (expired ones are dropped on the way),
   *  or null. Does not start it. */
  next(botId: string): WakeItem | null {
    const now = this.now();
    let dirty = false;
    for (const i of this.items) {
      if (i.botId === botId && i.state === 'queued' && this.expired(i, now)) {
        i.state = 'dropped';
        i.dropped = { code: 'expired' };
        dirty = true;
      }
    }
    if (dirty) this.changed();
    const ready = this.items
      .filter((i) => i.botId === botId && i.state === 'queued' && (i.notBefore === undefined || i.notBefore <= now))
      .sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
    return ready[0] ? copyItem(ready[0]) : null;
  }

  /** The earliest `notBefore` among a bot's held items, or null. */
  nextHeldAt(botId: string): number | null {
    const now = this.now();
    const held = this.items
      .filter((i) => i.botId === botId && i.state === 'queued' && i.notBefore !== undefined && i.notBefore > now)
      .map((i) => i.notBefore as number);
    return held.length > 0 ? Math.min(...held) : null;
  }

  /** The item the bot is running now, or null. */
  running(botId: string): WakeItem | null {
    const i = this.items.find((x) => x.botId === botId && x.state === 'running');
    return i ? copyItem(i) : null;
  }

  /** Bots that have at least one queued item. */
  botsWithQueued(): string[] {
    return [...new Set(this.items.filter((i) => i.state === 'queued').map((i) => i.botId))];
  }

  /** Running wakes that run no attempt more (endRunningGuestWakes): a retry
   *  or park drops them. In memory: a running wake is interrupted on restart. */
  private readonly lastAttempt = new Set<string>();

  /** Whether `i`, leaving `running` for the queue, is dropped instead: its
   *  guest was revoked or turned off while it ran, or its bot already holds
   *  GUEST_WAKES_QUEUED_PER_BOT guest wakes. Marks it dropped when so. */
  private dropInsteadOfQueue(i: WakeItem): boolean {
    const code: WakeDropCode | null = this.lastAttempt.delete(i.id) ? 'expired'
      : i.reason.kind === 'guest' && this.queuedGuestWakes(i.botId) >= GUEST_WAKES_QUEUED_PER_BOT ? 'queue_full'
      : null;
    if (!code) return false;
    i.state = 'dropped';
    i.dropped = { code };
    return true;
  }

  /** The running wakes `match` names run no attempt more: a retry or park
   *  of one drops it. Returns how many. */
  endRunning(match: (i: WakeItem) => boolean): number {
    let n = 0;
    for (const i of this.items) {
      if (i.state === 'running' && match(i)) {
        this.lastAttempt.add(i.id);
        n++;
      }
    }
    return n;
  }

  private transition(id: string, from: readonly WakeState[], apply: (i: WakeItem) => void): WakeItem | null {
    const i = this.items.find((x) => x.id === id);
    if (!i || !from.includes(i.state)) return null;
    apply(i);
    this.changed();
    return copyItem(i);
  }

  /** queued → running (one attempt more). */
  start(id: string): WakeItem | null {
    return this.transition(id, ['queued'], (i) => {
      i.state = 'running';
      i.attempts += 1;
    });
  }

  /** running → done. */
  finish(id: string): WakeItem | null {
    return this.transition(id, ['running'], (i) => {
      i.state = 'done';
    });
  }

  /** running → queued (a failed attempt that may run again). `notBefore`
   *  holds it until then; `refundAttempt` gives the attempt back (a network
   *  failure is not the wake's fault). */
  retry(id: string, opts: { notBefore?: number; refundAttempt?: boolean } = {}): WakeItem | null {
    return this.transition(id, ['running'], (i) => {
      if (this.dropInsteadOfQueue(i)) return;
      i.state = 'queued';
      if (opts.notBefore !== undefined) i.notBefore = opts.notBefore;
      if (opts.refundAttempt) i.attempts = Math.max(0, i.attempts - 1);
    });
  }

  /** queued/running → parked (held with its parked bot). */
  park(id: string): WakeItem | null {
    return this.transition(id, ['queued', 'running'], (i) => {
      if (i.state === 'running' && this.dropInsteadOfQueue(i)) return;
      i.state = 'parked';
    });
  }

  /** running → interrupted (stopped by a person; never replayed). */
  interrupt(id: string): WakeItem | null {
    return this.transition(id, ['running'], (i) => {
      i.state = 'interrupted';
    });
  }

  drop(id: string, code: WakeDropCode): WakeItem | null {
    return this.transition(id, ['queued', 'running', 'parked'], (i) => {
      i.state = 'dropped';
      i.dropped = { code };
    });
  }

  /** A resumed bot's parked items go back to the queue with fresh attempts. */
  unparkAll(botId: string): number {
    let n = 0;
    for (const i of this.items) {
      if (i.botId === botId && i.state === 'parked') {
        if (i.reason.kind === 'guest' && this.queuedGuestWakes(botId) >= GUEST_WAKES_QUEUED_PER_BOT) {
          i.state = 'dropped';
          i.dropped = { code: 'queue_full' };
          n++;
          continue;
        }
        i.state = 'queued';
        i.attempts = 0;
        n++;
      }
    }
    if (n > 0) this.changed();
    return n;
  }

  /** Drop a bot's queued and parked PR-event wakes (pr.opened,
   *  pr.head_moved, ci.failed) whose kind is no longer among its triggers
   *  (`kept`): a reviewer moved to on-request verification was never asked
   *  for those heads, and a parked one would run once its park lifts. Only
   *  triggers enqueue these kinds. Code `expired`. */
  dropPrEventWakes(botId: string, kept: ReadonlySet<string>): number {
    let n = 0;
    for (const i of this.items) {
      if (i.botId !== botId || (i.state !== 'queued' && i.state !== 'parked') || i.reason.kind !== 'facts') continue;
      const k = i.reason.trigger.kind;
      if ((k === 'pr.opened' || k === 'pr.head_moved' || k === 'ci.failed') && !kept.has(k)) {
        i.state = 'dropped';
        i.dropped = { code: 'expired' };
        n++;
      }
    }
    if (n > 0) this.changed();
    return n;
  }

  /** Drop the queued issue wakes of a bot whose trigger does not check the
   *  author (queued under triggers that no longer apply). Code `expired`. */
  dropUnfilteredIssueWakes(botId: string): number {
    let n = 0;
    for (const i of this.items) {
      if (i.botId !== botId || i.state !== 'queued' || i.reason.kind !== 'facts') continue;
      const t = i.reason.trigger;
      if ((t.kind === 'issue.opened' || t.kind === 'issue.labelled') && t.filter?.authorTrusted !== true) {
        i.state = 'dropped';
        i.dropped = { code: 'expired' };
        n++;
      }
    }
    if (n > 0) this.changed();
    return n;
  }

  /** Drop every live or parked item of a bot (removed or disabled). */
  dropAllFor(botId: string, code: WakeDropCode): number {
    let n = 0;
    for (const i of this.items) {
      if (i.botId === botId && (i.state === 'queued' || i.state === 'parked')) {
        i.state = 'dropped';
        i.dropped = { code };
        n++;
      }
    }
    if (n > 0) this.changed();
    return n;
  }
}

let current: WakeQueue | null = null;

/** Set by the bot runtime module's start(). */
export function setWakeQueue(queue: WakeQueue | null): void {
  current = queue;
}

/** The wake sink for the trigger engine and the handoff router, or null
 *  before the factory started. */
export function getWakeQueue(): WakeSinkApi | null {
  return current;
}

/** The id of the wake the bot is running now (tools derive per-wake keys
 *  such as `wake:<wakeId>:<n>` from it), or null. */
export function currentWakeId(botId: string): string | null {
  return current?.running(botId)?.id ?? null;
}

/** Drop the bot's held fan-out wakes that have not run, queued or parked
 *  (the owner stopped its work): what the bot had held does not start
 *  later; `only`: those it says yes to. Returns how many. */
export function dropQueuedHeldFanoutWakes(botId: string, only?: (wake: WakeItem) => boolean): number {
  if (!current) return 0;
  let n = 0;
  for (const i of current.list({ botId, states: ['queued', 'parked'] })) {
    if (i.reason.kind !== 'held_fanout') continue;
    if (only && !only(i)) continue;
    if (current.drop(i.id, 'expired')) n++;
  }
  return n;
}

/** Drop the external guests' wakes that have not run, queued or parked:
 *  `guestId`'s only, or every guest's when it is omitted (the owner revoked
 *  a guest or turned guest bots off). Returns how many. */
export function dropQueuedGuestWakes(guestId?: string): number {
  if (!current) return 0;
  const mine = (i: WakeItem): boolean => i.reason.kind === 'guest' && (guestId === undefined || i.reason.guestId === guestId);
  let n = 0;
  for (const i of current.list({ states: ['queued', 'parked'] })) {
    if (mine(i) && current.drop(i.id, 'expired')) n++;
  }
  // One running now finishes its turn and runs no attempt more.
  current.endRunning(mine);
  return n;
}

/** Wake `id`'s record (a copy), or null when it is gone or there is no queue. */
export function wakeItemById(id: string): WakeItem | null {
  return current?.get(id) ?? null;
}

/** The wake the bot is running now (a copy), or null. */
export function currentWakeItem(botId: string): WakeItem | null {
  return current?.running(botId) ?? null;
}

/** The thread of the wake the bot is running now (a room post without a
 *  thread lands there), or null. */
export function currentWakeThread(botId: string): ThreadId | null {
  return current?.running(botId)?.threadId ?? null;
}

/** The thread of the owner's latest message to the bot: its newest
 *  owner-message wake that was not dropped (`general` when that wake had no
 *  thread), or null when the queue holds none. */
export function latestOwnerWakeThread(botId: string): ThreadId | null {
  const latest = (current?.list({ botId }) ?? [])
    .filter((i) => i.reason.kind === 'human' && i.state !== 'dropped')
    .sort((a, b) => b.enqueuedAt - a.enqueuedAt)[0];
  return latest ? latest.threadId ?? 'general' : null;
}
