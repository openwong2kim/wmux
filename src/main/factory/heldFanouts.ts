// ─── Held fan-outs — a bot's fan-out that waits for a worker slot ──────────
//
// A bot's fan-out over its own worker slots (budget.maxConcurrentWorkers),
// the factory's (WAKE_LIMITS.GLOBAL_CONCURRENT_WORKERS) or the wmux-wide
// live fan-out cap (fanoutGuards liveTaskCap when the owner set one, the owner's fan-outs counted) is not a budget
// refusal: the bot waits for a slot. The fan-out's refusal (fanout.rpc.ts)
// keeps the request here, at most HELD_PER_BOT_MAX per bot, and once a
// slot frees for it queues one wake for the bot that carries the request
// (WakeReason `held_fanout`): the bot starts it from that turn with
// fanout_start, so every cap is checked again and no worker starts without
// the bot's turn.
//
// The release point is `releaseHeldFanouts()`. A slot frees on any path that
// drops a bot holder (workerHolders.ts): a task row that ends (its ledger
// transition kicks the agent slots), a worker reclaimed or stopped (its
// reclaim record), a verdict recorded, a booking released. AgentSlots.kick()
// calls it through its `onKick` port, and every change of the holder set's
// records does too (holderInputs.ts). A pane whose agent exits moves no
// record (a liveness read sees it), so while anything is held a timer checks
// as well, a second layer.
//
// A slot handed to a held request's wake stays counted against every cap
// (the bot's, the factory's and the live one) until that wake's turn books
// its workers (fanout_start reserved them: the booking counts from then on),
// or the wake leaves the queue without that (its turn ended, it was dropped
// or expired). Read from the wake queue on every pass, so a later pass
// before the woken turn books never hands the same slot out again.
//
// `<wmuxDir>/factory/held-fanouts.json`, version 1: a held request survives a
// restart. One held longer than HELD_MAX_MS is dropped.

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BotBudget } from '../../shared/bot';
import { parseThreadId, type ThreadId } from '../../shared/room';
import { WAKE_LIMITS, isHeldWakeKind, type HeldFanoutArgs, type HeldWakeKind, type WakeItem } from '../../shared/wake';
import { FANOUT_MAX_TASKS, FANOUT_PROMPT_MAX_BYTES } from '../../shared/workTask';
import { workerSlotsFull } from './budget';
import { onHolderInputsChanged } from './holderInputs';
import { redactStoredSecretsDeep } from './secretRedaction';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';
import type { WakeSinkApi } from './wakeQueue';

export const HELD_FANOUTS_FILENAME = 'held-fanouts.json';
export const HELD_FANOUTS_VERSION = 1 as const;
/** Requests kept per bot; past it a new one is not held (its refusal says so). */
export const HELD_PER_BOT_MAX = 3;
/** A request held this long is dropped: its wake would be a day old. */
export const HELD_MAX_MS = WAKE_LIMITS.FACT_TTL_MS;
/** The arguments kept, at most (JSON bytes); longer ones keep the titles only. */
export const HELD_ARGS_MAX_BYTES = 24 * 1024;
/** The second-layer check while anything is held. */
export const HELD_RECHECK_MS = 60_000;
/** Releases asked for within this long are run once. */
const RELEASE_COALESCE_MS = 250;

export interface HeldFanout {
  id: string;
  botId: string;
  workspaceId: string;
  heldAt: number;
  /** The workers it asks for. */
  count: number;
  titles: string[];
  /** Absent: they were too long to keep. */
  args?: HeldFanoutArgs;
  /** The arguments' fingerprint (sha256 of their redacted JSON), kept when
   *  they are not: a retry that starts it is matched by it. */
  fingerprint: string;
  /** The thread its wake runs in (the one the bot asked from, or named). */
  threadId?: ThreadId;
  tainted: boolean;
  /** The asking wake's guest provenance (wakeTaint.ts); absent on an older
   *  record reads as unknown unless clean. */
  guest?: boolean;
  handoffId?: string;
  /** A signed-in request's: the reason kind of the wake that asked for it
   *  (its `tainted` is that wake's own mark, fanout.rpc.ts). Recorded for
   *  recipe schedules; nothing reads it yet. */
  wakeKind?: HeldWakeKind;
}

export type HoldInput = Omit<HeldFanout, 'id' | 'heldAt' | 'titles' | 'count' | 'fingerprint' | 'args'> & {
  args: HeldFanoutArgs;
  /** Hold it only with its arguments kept (a request the bot is not asked to resend). */
  requireArgs?: boolean;
};

/** Where a request came from: its thread and the handoff its wake delivered. */
export type HeldContext = Pick<HeldFanout, 'threadId' | 'handoffId'>;

/** The fingerprint of a request's arguments, as `hold` and `started` see them. */
export function heldFanoutFingerprint(args: HeldFanoutArgs): string {
  return createHash('sha256').update(JSON.stringify(redactStoredSecretsDeep(args))).digest('hex');
}

export interface HeldFanoutPorts {
  /** The bot's budget, or null when the bot is gone or off. */
  budget(botId: string): Pick<BotBudget, 'maxConcurrentWorkers'> | null;
  /** Open workers of the bot and of every bot, as the fan-out counts them;
   *  `live`: every live fan-out task across wmux (absent: not known). */
  openWorkers(botId: string): { bot: number; factory: number; live?: number };
  /** Brings openWorkers up to date (never rejects). */
  refreshLiveness?(): Promise<void>;
  wakes(): Pick<WakeSinkApi, 'enqueue' | 'flush'> | null | undefined;
  /** The wakes queued or running now (any reason; the held fan-outs' are
   *  read from it). Absent: a slot is counted only within one pass. */
  liveWakes?: () => readonly Pick<WakeItem, 'id' | 'botId' | 'reason' | 'enqueuedAt' | 'state'>[];
  factoryLimit?: () => number;
  /** The wmux-wide live fan-out cap (fanoutGuards liveTaskCap; null: none set). Absent: not
   *  checked here (the bot's retry is refused and held again). */
  liveLimit?: () => number | null;
  /** Whether the usage reserve holds what a bot's workers would spend in
   *  this workspace: a held request waits for it to lift (the recheck timer
   *  sees it). */
  reserveHeld?: (held: Pick<HeldFanout, 'botId' | 'workspaceId'>) => boolean;
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const SHA_RE = /^[0-9a-f]{40}$/;
// A review head ref: GitHub's `pull/<n>/head` or GitLab's `merge-requests/<n>/head`.
const FETCH_REF_RE = /^(?:pull|merge-requests)\/[1-9][0-9]{0,8}\/head$/;
const NAME_MAX = 256;

function strings(v: unknown, max: number, each: number): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  return v.every((x) => typeof x === 'string' && x.length <= each) ? [...(v as string[])] : null;
}

/** Well-formed held arguments (a fresh object), or null. */
export function sanitizeHeldFanoutArgs(raw: unknown): HeldFanoutArgs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const titles = strings(r.titles, FANOUT_MAX_TASKS, NAME_MAX);
  if (!titles || titles.length === 0) return null;
  const out: HeldFanoutArgs = { titles };
  if (r.prompt !== undefined) {
    if (typeof r.prompt !== 'string' || Buffer.byteLength(r.prompt, 'utf8') > FANOUT_PROMPT_MAX_BYTES) return null;
    out.prompt = r.prompt;
  }
  if (r.task_prompts !== undefined) {
    const p = strings(r.task_prompts, FANOUT_MAX_TASKS, FANOUT_PROMPT_MAX_BYTES);
    if (!p) return null;
    out.task_prompts = p;
  }
  if (r.preset !== undefined) {
    if (typeof r.preset !== 'string' || r.preset.length === 0 || r.preset.length > 64) return null;
    out.preset = r.preset;
  }
  if (r.files !== undefined) {
    if (!Array.isArray(r.files) || r.files.length > FANOUT_MAX_TASKS) return null;
    const files: string[][] = [];
    for (const f of r.files) {
      const one = strings(f, 32, NAME_MAX);
      if (!one) return null;
      files.push(one);
    }
    out.files = files;
  }
  if (r.checkout !== undefined) {
    const c = r.checkout as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || typeof c.sha !== 'string' || !SHA_RE.test(c.sha)) return null;
    if (c.fetch_ref !== undefined && (typeof c.fetch_ref !== 'string' || !FETCH_REF_RE.test(c.fetch_ref))) return null;
    out.checkout = { sha: c.sha, ...(typeof c.fetch_ref === 'string' ? { fetch_ref: c.fetch_ref } : {}) };
  }
  for (const key of ['secret_names', 'connectors'] as const) {
    if (r[key] === undefined) continue;
    const list = strings(r[key], 32, 64);
    if (!list) return null;
    out[key] = list;
  }
  if (r.thread_id !== undefined) {
    if (typeof r.thread_id !== 'string' || r.thread_id.length === 0 || r.thread_id.length > 240) return null;
    out.thread_id = r.thread_id;
  }
  return Buffer.byteLength(JSON.stringify(out), 'utf8') <= HELD_ARGS_MAX_BYTES ? out : null;
}

/** What makes two held requests the same one: the bot's arguments, its
 *  thread and its handoff. */
function requestIdentity(h: Pick<HeldFanout, 'fingerprint' | 'threadId' | 'handoffId'>): string {
  return JSON.stringify([h.fingerprint, h.threadId ?? null, h.handoffId ?? null]);
}

/** Whether a fan-out that started is the held request: the same arguments
 *  and thread. The handoff counts only when the hold has one: a hold made
 *  outside a handoff is still the request a later turn (an answer's
 *  handoff) retries. */
function startedIsHeld(
  held: Pick<HeldFanout, 'fingerprint' | 'threadId' | 'handoffId'>,
  fingerprint: string,
  context: HeldContext,
): boolean {
  return held.fingerprint === fingerprint
    && (held.threadId ?? null) === (context.threadId ?? null)
    && (held.handoffId === undefined || held.handoffId === context.handoffId);
}

function parseHeld(raw: unknown): HeldFanout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
  if (!ok(r.id) || !ok(r.botId) || !ok(r.workspaceId) || !Number.isSafeInteger(r.heldAt)) return null;
  if (!Number.isSafeInteger(r.count) || (r.count as number) < 1 || (r.count as number) > FANOUT_MAX_TASKS) return null;
  const titles = strings(r.titles, FANOUT_MAX_TASKS, NAME_MAX);
  if (!titles || titles.length === 0 || typeof r.tainted !== 'boolean') return null;
  const args = r.args === undefined ? undefined : sanitizeHeldFanoutArgs(r.args);
  if (args === null) return null;
  const threadId = r.threadId === undefined ? undefined : parseThreadId(r.threadId);
  if (threadId === null) return null;
  if (r.handoffId !== undefined && !ok(r.handoffId)) return null;
  if (typeof r.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(r.fingerprint)) return null;
  return {
    id: r.id, botId: r.botId, workspaceId: r.workspaceId, heldAt: r.heldAt as number, count: r.count as number, titles,
    ...(args ? { args } : {}), fingerprint: r.fingerprint, ...(threadId ? { threadId } : {}), tainted: r.tainted,
    ...(typeof r.guest === 'boolean' ? { guest: r.guest } : {}),
    ...(typeof r.handoffId === 'string' ? { handoffId: r.handoffId } : {}),
    ...(isHeldWakeKind(r.wakeKind) ? { wakeKind: r.wakeKind } : {}),
  };
}

export class HeldFanouts {
  private held: HeldFanout[] = [];
  private readonly persister: FilePersister | null;
  private releaseTimer: unknown = null;
  private recheckTimer: unknown = null;
  private releasing = false;
  private again = false;
  private seq = 0;
  private disposed = false;
  /** Held wakes whose turn booked its workers: their slot is the booking's. */
  private readonly booked = new Set<string>();
  /** The held wakes queued or running at the last wake-queue change. */
  private liveHeldWakes = new Set<string>();

  constructor(private readonly ports: HeldFanoutPorts, private readonly file?: string) {
    this.persister = file ? createFilePersister(file, () => ({ version: HELD_FANOUTS_VERSION, held: this.held })) : null;
  }

  static at(wmuxDir: string, ports: HeldFanoutPorts): HeldFanouts {
    return new HeldFanouts(ports, path.join(wmuxDir, 'factory', HELD_FANOUTS_FILENAME));
  }

  /** Read the file (missing → none held). A file of another version throws. */
  load(): void {
    if (!this.file) return;
    const raw = readVersionedFile(this.file, HELD_FANOUTS_VERSION);
    const list = raw && Array.isArray(raw.held) ? raw.held : [];
    this.held = list.map(parseHeld).filter((h): h is HeldFanout => h !== null);
    this.armRecheck();
  }

  list(botId?: string): HeldFanout[] {
    return this.held.filter((h) => botId === undefined || h.botId === botId).map((h) => ({ ...h, titles: [...h.titles] }));
  }

  /** Keep a request refused only for a slot. Returns it, or null when it
   *  has no titles or the bot already holds HELD_PER_BOT_MAX others (a held
   *  request is never pushed out by a newer one). */
  hold(input: HoldInput): HeldFanout | null {
    const now = (this.ports.now ?? Date.now)();
    // A stored bot secret never lands in held-fanouts.json (secretRedaction.ts):
    // the titles kept beside the arguments come from the redacted copy too.
    const redacted = redactStoredSecretsDeep(input.args);
    const titles = (Array.isArray(redacted.titles) ? redacted.titles : [])
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
    if (titles.length === 0) return null;
    const args = sanitizeHeldFanoutArgs(redacted);
    if (!args && input.requireArgs) return null;
    const id = (this.ports.newId ?? (() => `held-${now.toString(36)}-${(++this.seq).toString(36)}`))();
    const entry: HeldFanout = {
      id,
      botId: input.botId,
      workspaceId: input.workspaceId,
      heldAt: now,
      count: titles.length,
      titles: titles.map((t) => t.slice(0, NAME_MAX)),
      ...(args ? { args } : {}),
      fingerprint: heldFanoutFingerprint(input.args),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      tainted: input.tainted,
      ...(typeof input.guest === 'boolean' ? { guest: input.guest } : {}),
      ...(input.handoffId ? { handoffId: input.handoffId } : {}),
      ...(input.wakeKind ? { wakeKind: input.wakeKind } : {}),
    };
    // The same request refused again (a retry from the same thread and
    // handoff) is held once, as the latest.
    const same = requestIdentity(entry);
    const others = this.held.filter((h) => h.botId !== input.botId || requestIdentity(h) !== same);
    if (others.filter((h) => h.botId === input.botId).length >= HELD_PER_BOT_MAX) return null;
    this.held = [...others, entry];
    this.save();
    this.armRecheck();
    return { ...entry };
  }

  /** The bot started this request after all (a retry that found a free
   *  slot): it is no longer held. */
  started(botId: string, args: HeldFanoutArgs, context: HeldContext): void {
    const fingerprint = heldFanoutFingerprint(args);
    const before = this.held.length;
    this.held = this.held.filter((h) => h.botId !== botId || !startedIsHeld(h, fingerprint, context));
    if (this.held.length !== before) this.save();
  }

  /** The turn of this wake reserved its workers (fanout_start passed the
   *  reserve): the slot its held wake was handed is the booking's now. */
  reserved(wakeId: string): void {
    this.booked.add(wakeId);
  }

  /** Forget a bot's held requests (its work was stopped, or it was removed). */
  dropFor(botId: string): void {
    const before = this.held.length;
    this.held = this.held.filter((h) => h.botId !== botId);
    if (this.held.length !== before) this.save();
  }

  /** A worker slot may have freed: check the held requests soon (calls
   *  within RELEASE_COALESCE_MS run once). Never throws. */
  release(): void {
    if (this.disposed || this.held.length === 0 || this.releaseTimer !== null) return;
    this.releaseTimer = this.setTimer(() => {
      this.releaseTimer = null;
      void this.releaseNow();
    }, RELEASE_COALESCE_MS);
  }

  /** Wake each bot a slot now frees for, oldest held request first, one
   *  wake per request; the factory's free slots are shared out in that
   *  order. Resolves with the requests it woke a bot for. Never rejects. */
  async releaseNow(): Promise<HeldFanout[]> {
    if (this.releasing) {
      this.again = true;
      return [];
    }
    this.releasing = true;
    const woken: HeldFanout[] = [];
    try {
      if (this.held.length === 0) return woken;
      try {
        await this.ports.refreshLiveness?.();
      } catch {
        /* counted as last read */
      }
      const now = (this.ports.now ?? Date.now)();
      const limit = (this.ports.factoryLimit ?? (() => WAKE_LIMITS.GLOBAL_CONCURRENT_WORKERS))();
      const liveLimit = this.ports.liveLimit?.() ?? undefined;
      let changed = false;
      // Slots handed out to a held wake, in this pass or an earlier one,
      // whose turn has not booked its workers yet.
      const { all: handed, byBot: handedBot, queued } = this.handedOut(now);
      let factoryTaken = handed;
      const botTaken = new Map<string, number>(handedBot);
      for (const h of [...this.held].sort((a, b) => a.heldAt - b.heldAt)) {
        let budget: Pick<BotBudget, 'maxConcurrentWorkers'> | null = null;
        let open: { bot: number; factory: number; live?: number } | null = null;
        try {
          budget = this.ports.budget(h.botId);
          if (budget) open = this.ports.openWorkers(h.botId);
        } catch (err) {
          this.log(`[factory] held fan-out ${h.id}: the worker count could not be read: ${String(err)}`);
          continue;
        }
        const expired = now - h.heldAt > HELD_MAX_MS;
        if (!budget || !open || expired || h.count > budget.maxConcurrentWorkers || h.count > limit) {
          // Gone, off, too old, or more than the bot's slots could ever hold.
          this.held.splice(this.held.indexOf(h), 1);
          changed = true;
          continue;
        }
        if (queued.has(h.id)) {
          // Its wake is queued already (counted above): only its write is
          // retried, and the queue answers with the same wake.
          if (this.wake(h)) woken.push(h);
          continue;
        }
        if (this.ports.reserveHeld?.(h)) continue;
        const taken = botTaken.get(h.botId) ?? 0;
        // A bot slot handed out in this pass is a live wmux task too.
        const wmux = liveLimit !== undefined && open.live !== undefined ? { live: open.live + factoryTaken, limit: liveLimit } : undefined;
        if (workerSlotsFull(budget, open.bot + taken, open.factory + factoryTaken, h.count, limit, wmux)) continue;
        // Held until its wake is queued: a full queue keeps it for a later check.
        if (!this.wake(h)) continue;
        woken.push(h);
        factoryTaken += h.count;
        botTaken.set(h.botId, taken + h.count);
      }
      // A hold leaves only once its wake is on disk: a failed write keeps it,
      // and the queue answers its next enqueue with the same wake (keyed).
      if (woken.length > 0) {
        try {
          await this.ports.wakes()?.flush?.();
          for (const h of woken) {
            const i = this.held.indexOf(h);
            if (i >= 0) this.held.splice(i, 1);
          }
          changed = true;
        } catch (err) {
          this.log(`[factory] held fan-outs: the wake queue was not written; they stay held: ${String(err)}`);
          woken.length = 0;
        }
      }
      if (changed) this.save();
      return woken;
    } finally {
      this.releasing = false;
      this.armRecheck();
      if (this.again) {
        this.again = false;
        this.release();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.releaseTimer !== null) this.clearTimer(this.releaseTimer);
    if (this.recheckTimer !== null) this.clearTimer(this.recheckTimer);
    this.releaseTimer = null;
    this.recheckTimer = null;
  }

  /** Resolves once every change so far is on disk. */
  async flush(): Promise<void> {
    await this.persister?.schedule();
  }

  /** The slots handed to held wakes still queued or running whose turn has
   *  not booked them, in all and per bot; `queued`: the holds whose wake is
   *  among them (its queue write failed, so the hold is still here). */
  private handedOut(now: number): { all: number; byBot: Map<string, number>; queued: Set<string> } {
    const byBot = new Map<string, number>();
    const queued = new Set<string>();
    let all = 0;
    const wakes = this.readLiveWakes();
    if (!wakes) return { all, byBot, queued };
    const live = new Set<string>();
    for (const w of wakes) {
      if (w.reason.kind !== 'held_fanout') continue;
      live.add(w.id);
      queued.add(w.reason.heldId);
      // Booked, or queued too long to run (the queue drops it unrun; a
      // running one counts until its turn ends).
      if (this.booked.has(w.id) || (w.state === 'queued' && now - w.enqueuedAt > HELD_MAX_MS)) continue;
      const n = w.reason.titles.length;
      all += n;
      byBot.set(w.botId, (byBot.get(w.botId) ?? 0) + n);
    }
    for (const id of this.booked) if (!live.has(id)) this.booked.delete(id);
    return { all, byBot, queued };
  }

  /** The wake queue changed: a held wake that left it (its turn ended, it
   *  was dropped or expired) may have handed its slot back. A change that
   *  only adds one checks nothing. Never throws. */
  wakesChanged(): void {
    const wakes = this.readLiveWakes();
    if (!wakes) return;
    const now = new Set(wakes.filter((w) => w.reason.kind === 'held_fanout').map((w) => w.id));
    const left = [...this.liveHeldWakes].some((id) => !now.has(id));
    this.liveHeldWakes = now;
    if (left) this.release();
  }

  private readLiveWakes(): readonly Pick<WakeItem, 'id' | 'botId' | 'reason' | 'enqueuedAt' | 'state'>[] | undefined {
    try {
      return this.ports.liveWakes?.();
    } catch (err) {
      this.log(`[factory] held fan-outs: the wake queue could not be read: ${String(err)}`);
      return undefined;
    }
  }

  private wake(h: HeldFanout): boolean {
    try {
      const item = this.ports.wakes()?.enqueue({
        botId: h.botId,
        workspaceId: h.workspaceId,
        reason: {
          kind: 'held_fanout', heldId: h.id, heldAt: h.heldAt, titles: h.titles,
          ...(h.args ? { args: h.args } : {}), fingerprint: h.fingerprint, tainted: h.tainted,
          ...(typeof h.guest === 'boolean' ? { guest: h.guest } : {}), ...(h.handoffId ? { handoffId: h.handoffId } : {}),
          ...(h.wakeKind ? { wakeKind: h.wakeKind } : {}),
        },
        priority: 1,
        ...(h.threadId ? { threadId: h.threadId } : {}),
      });
      if (!item) this.log(`[factory] held fan-out ${h.id}: the wake for bot ${h.botId} was not queued`);
      return !!item;
    } catch (err) {
      this.log(`[factory] held fan-out ${h.id}: the wake for bot ${h.botId} was not queued: ${String(err)}`);
      return false;
    }
  }

  private armRecheck(): void {
    if (this.disposed || this.recheckTimer !== null || this.held.length === 0) return;
    this.recheckTimer = this.setTimer(() => {
      this.recheckTimer = null;
      void this.releaseNow();
    }, HELD_RECHECK_MS);
  }

  private save(): void {
    void this.persister?.schedule().catch((err: unknown) => this.log(`[factory] ${this.file} not written: ${String(err)}`));
  }

  private log(line: string): void {
    (this.ports.log ?? ((l: string) => console.warn(l)))(line);
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.ports.setTimer) return this.ports.setTimer(fn, ms);
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  }

  private clearTimer(handle: unknown): void {
    if (this.ports.clearTimer) this.ports.clearTimer(handle);
    else clearTimeout(handle as NodeJS.Timeout);
  }
}

let instance: HeldFanouts | null = null;

/** The owner stopped a bot's work: what it had held does not start later.
 *  Never throws. */
export function forgetHeldFanouts(botId: string): void {
  try {
    instance?.dropFor(botId);
  } catch {
    /* nothing held */
  }
}

/** A bot's fan-out was accepted: the same request held earlier is done.
 *  Never throws. */
export function heldFanoutStarted(botId: string, args: HeldFanoutArgs, context: HeldContext): void {
  try {
    instance?.started(botId, args, context);
  } catch {
    /* the held wake says to end the turn when the work is done */
  }
}

/** The wake queue changed (HeldFanouts.wakesChanged). Never throws. */
export function heldFanoutWakesChanged(): void {
  try {
    instance?.wakesChanged();
  } catch {
    /* the recheck timer checks again */
  }
}

/** A bot's turn reserved its fan-out's workers: the slot its held wake was
 *  handed (if it is one) is counted by the booking from now on. Never throws. */
export function heldFanoutReserved(wakeId: string): void {
  try {
    instance?.reserved(wakeId);
  } catch {
    /* counted until the wake ends */
  }
}

/** Whether a held fan-out's wake is for this request (its fingerprint and
 *  thread, and its handoff when the hold had one). Pure. */
export function heldWakeIsFor(wake: Pick<WakeItem, 'reason' | 'threadId'>, args: HeldFanoutArgs, context: HeldContext): boolean {
  const r = wake.reason;
  if (r.kind !== 'held_fanout' || !r.fingerprint) return false;
  return startedIsHeld({ fingerprint: r.fingerprint, threadId: wake.threadId, handoffId: r.handoffId }, heldFanoutFingerprint(args), context);
}
let offHolderInputs: (() => void) | null = null;

export function setHeldFanouts(next: HeldFanouts | null): void {
  offHolderInputs?.();
  offHolderInputs = null;
  instance?.dispose();
  instance = next;
  if (next) offHolderInputs = onHolderInputsChanged(() => next.release());
}

export function getHeldFanouts(): HeldFanouts | null {
  return instance;
}

/**
 * The release point: a worker slot may have freed (a worker ended, was
 * reclaimed or stopped, a booking was released). Every path that frees one
 * reaches it, through AgentSlots.kick() or a holder record's change; a new
 * path calls `getAgentSlots()?.kick()` after freeing. Cheap with nothing
 * held. Never throws.
 */
export function releaseHeldFanouts(): void {
  try {
    instance?.release();
  } catch {
    /* the next free slot checks again */
  }
}

/**
 * The release points no holder record moves for, wired by the worker
 * lifecycle host. A slot of the wmux-wide live cap is also freed by the
 * owner's own fan-out tasks, which move no bot record: a task row that
 * ends (any task's, the owner's too) and a task workspace that closes (the
 * open workspaces change) check the held requests again. A pane whose agent
 * exits in a workspace left open moves neither; the recheck timer covers it.
 * Returns the unsubscribe.
 */
export function installHeldFanoutReleases(ports: {
  onTransition: (fn: () => void) => () => void;
  onWorkspaces: (fn: () => void) => () => void;
  /** The open workspace ids now, or null before the renderer pushed its tree. */
  openWorkspaces: () => readonly string[] | null;
  release?: () => void;
}): () => void {
  const release = ports.release ?? releaseHeldFanouts;
  const key = (): string | null => {
    try {
      const ids = ports.openWorkspaces();
      return ids ? [...ids].sort().join('\n') : null;
    } catch {
      return null;
    }
  };
  let last = key();
  const offTransition = ports.onTransition(() => release());
  const offWorkspaces = ports.onWorkspaces(() => {
    const now = key();
    if (now === last) return;
    last = now;
    release();
  });
  return () => {
    offTransition();
    offWorkspaces();
  };
}
