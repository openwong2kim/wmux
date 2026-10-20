// ─── Bot routines — the wakes a bot schedules for itself ───────────────────
//
// `<wmuxDir>/factory/routines.json` (main-owned, shared/botRoutine.ts). A bot
// keeps its own routines with routine_set / routine_list / routine_pause
// (pipe/handlers/routine.rpc.ts): "every hour, check the open PRs". When one
// is due, main appends a `schedule.fired` fact addressed to that bot
// (`ref.scheduleId` = `routine:<id>@<dueAt>`, so every slot is its own fact;
// the trigger engine routes none of them) and queues a `routine` wake for that
// bot only. A routine is never the daemon's automation (that one holds PTY
// permissions).
//
// Rules:
// - every interval is at least ROUTINE_LIMITS.MIN_INTERVAL_MS; a bot keeps at
//   most ROUTINE_LIMITS.MAX_PER_BOT routines;
// - a bot creates or changes a routine only in a turn on the owner's words
//   (their message, or their answer): a routine is a standing instruction, so
//   it comes from the owner, never from text the bot read elsewhere. Pausing
//   or resuming its own is the bot's at any time;
// - a slot missed while the app was closed fires once (the latest), not once
//   per missed slot; a slot that comes while the bot cannot run (switched off,
//   parked, the factory off) is skipped;
// - a one-time (`once`) routine fires at its time, or on the first look after
//   it when that is at most ONCE_GRACE_MS late (the app was closed), and is
//   then `done`; later than that, when its bot cannot run, or when it is
//   resumed after its time, it is done as `missed` without firing.
//   A done routine never fires again (a change with a new time re-arms it);
//   a pause or stop takes back its wake still waiting, and it is dropped
//   DONE_KEEP_MS after it ended;
// - an interval routine's slot is skipped when it, or the moment it would
//   fire, falls inside the routine's quiet hours. Daily and one-time routines
//   run at the time chosen for them;
// - stopping a bot (stop_my_work, Stop all, Stop bot) pauses its routines
//   until it or the owner resumes them; parking it, switching it off or
//   switching "Run bots" off pauses them too, and lifting that resumes them.
//   A resumed routine counts from the moment it resumes, with no catch-up;
// - creating, changing, pausing or resuming one posts a `routine` card in the
//   bot's room (a park or an off switch does not: the Schedules page shows it),
//   and so does a one-time routine that was missed.
//
// A change that did not reach the file is still made in memory and retried
// with the next write (the store keeps no history worth refusing for).

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { BotEventPayload, BotProfile } from '../../shared/bot';
import type { FactDraft } from '../../shared/facts';
import type { Party } from '../../shared/handoff';
import { GENERAL_THREAD, parseThreadId, type ThreadId } from '../../shared/room';
import {
  ROUTINE_ID_RE,
  ROUTINE_LIMITS,
  type BotRoutine,
  type RoutineDoneReason,
  type RoutinePauseReason,
  type RoutineQuietHours,
  type RoutineResult,
  type RoutineSchedule,
  type RoutineSetParams,
} from '../../shared/botRoutine';
import { isClientId, oneLine, type RoomWriter } from './roomWriter';
import type { BotDirectoryApi, FactLogApi, WakeSinkApi } from './triggerEngine';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';
import type { WakeQueue } from './wakeQueue';

export const ROUTINES_VERSION = 1 as const;
export const ROUTINES_FILENAME = 'routines.json';

/** Longest interval: a far-off single wake is a `once` routine instead. */
export const ROUTINE_MAX_INTERVAL_MS = 30 * 24 * 3_600_000;
/** How late a one-time routine may still fire (the app was closed at its
 *  time); later, it is done as missed. */
export const ONCE_GRACE_MS = 6 * 3_600_000;
/** A done one-time routine is dropped on load this long after it ended. */
const DONE_KEEP_MS = 7 * 24 * 3_600_000;
/** The timer looks at the routines at least this often. */
const TICK_MAX_MS = 60_000;
const TICK_MIN_MS = 250;

export function routinesPath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', ROUTINES_FILENAME);
}

/** A routine as stored: the shared shape plus the key it was created with. */
interface StoredRoutine extends BotRoutine {
  clientRoutineId?: string;
}

const PAUSE_REASONS: readonly RoutinePauseReason[] = ['bot', 'owner', 'stop', 'park', 'off'];
const DONE_REASONS: readonly RoutineDoneReason[] = ['fired', 'missed'];
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** An ISO 8601 date and time (seconds optional; no offset = local time). */
const ISO_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

// ── Schedules (pure) ───────────────────────────────────────────────────────

/** A schedule as given, or why it is not one. `minIntervalMs` is
 *  ROUTINE_LIMITS.MIN_INTERVAL_MS outside tests. With `now`, a one-time
 *  routine's time must lie ahead of it (at most ONCE_MAX_AHEAD_MS); a stored
 *  one is read without it. Pure. */
export function parseSchedule(raw: unknown, minIntervalMs: number = ROUTINE_LIMITS.MIN_INTERVAL_MS, now?: number): RoutineSchedule | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'schedule is required';
  const r = raw as Record<string, unknown>;
  if (r.kind === 'interval') {
    const every = r.everyMs;
    if (typeof every !== 'number' || !Number.isSafeInteger(every)) return 'everyMs must be a whole number of milliseconds';
    if (every < minIntervalMs) return `a routine runs at most every ${Math.round(minIntervalMs / 60_000)} minutes`;
    if (every > ROUTINE_MAX_INTERVAL_MS) return 'a routine runs at least every 30 days';
    return { kind: 'interval', everyMs: every };
  }
  if (r.kind === 'daily') {
    const { hour, minute } = r;
    if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) return 'hour must be 0..23';
    if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) return 'minute must be 0..59';
    if (r.weekdays === undefined) return { kind: 'daily', hour, minute };
    if (!Array.isArray(r.weekdays) || r.weekdays.length === 0 || r.weekdays.length > 7) return 'weekdays must list 1..7 days';
    if (!r.weekdays.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)) return 'weekdays are 0 (Sunday) .. 6';
    const weekdays = [...new Set(r.weekdays as number[])].sort((a, b) => a - b);
    return weekdays.length === 7 ? { kind: 'daily', hour, minute } : { kind: 'daily', hour, minute, weekdays };
  }
  if (r.kind === 'once') {
    const at = typeof r.at === 'string' && ISO_AT_RE.test(r.at) ? Date.parse(r.at) : r.at;
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return 'at must be an ISO 8601 date and time, e.g. 2026-10-23T09:00 (local) or 2026-10-23T09:00+09:00';
    if (now !== undefined && at <= now) return 'at must be in the future';
    if (now !== undefined && at > now + ROUTINE_LIMITS.ONCE_MAX_AHEAD_MS) return 'at must be at most a year ahead';
    return { kind: 'once', at };
  }
  return 'schedule.kind must be interval, daily or once';
}

/** Quiet hours as given (absent: undefined), or why they are not. Pure. */
export function parseQuietHours(raw: unknown): RoutineQuietHours | undefined | string {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'quietHours must be { start, end }';
  const { start, end } = raw as Record<string, unknown>;
  if (typeof start !== 'string' || !HHMM_RE.test(start) || typeof end !== 'string' || !HHMM_RE.test(end)) return 'quietHours start and end are HH:MM (00:00..23:59)';
  if (start === end) return 'quietHours start and end must differ';
  return { start, end };
}

function minuteOfDay(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** `at` falls inside the window (local time; start inclusive, end
 *  exclusive; start after end wraps past midnight). Pure. */
export function inQuietHours(q: RoutineQuietHours, at: number): boolean {
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  const start = minuteOfDay(q.start);
  const end = minuteOfDay(q.end);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

function dailyAt(base: number, dayOffset: number, s: Extract<RoutineSchedule, { kind: 'daily' }>): number {
  const d = new Date(base);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, s.hour, s.minute, 0, 0).getTime();
}

function dayAllowed(at: number, s: Extract<RoutineSchedule, { kind: 'daily' }>): boolean {
  return !s.weekdays || s.weekdays.includes(new Date(at).getDay());
}

/** The first slot strictly after `after` (local time for a daily one). A
 *  one-time routine has one slot, its time, past or not. Pure. */
export function nextSlot(s: RoutineSchedule, after: number): number {
  if (s.kind === 'interval') return after + s.everyMs;
  if (s.kind === 'once') return s.at;
  for (let i = 0; i <= 8; i++) {
    const at = dailyAt(after, i, s);
    if (at > after && dayAllowed(at, s)) return at;
  }
  return after + 24 * 3_600_000;
}

/** The latest slot at or before `now` of a routine due at `dueAt` (≤ now):
 *  the one slot a run of missed slots fires. Pure. */
export function latestSlot(s: RoutineSchedule, dueAt: number, now: number): number {
  if (now <= dueAt || s.kind === 'once') return dueAt;
  if (s.kind === 'interval') return dueAt + Math.floor((now - dueAt) / s.everyMs) * s.everyMs;
  for (let i = 0; i <= 8; i++) {
    const at = dailyAt(now, -i, s);
    if (at <= now && at >= dueAt && dayAllowed(at, s)) return at;
  }
  return dueAt;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The schedule in a few words, e.g. "every 60 min", "daily at 09:00". Pure. */
export function scheduleLabel(s: RoutineSchedule): string {
  if (s.kind === 'interval') {
    const min = Math.round(s.everyMs / 60_000);
    return min % 60 === 0 && min >= 60 ? `every ${min / 60} h` : `every ${min} min`;
  }
  if (s.kind === 'once') {
    const d = new Date(s.at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `once on ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const hhmm = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  return s.weekdays ? `${s.weekdays.map((d) => WEEKDAY[d]).join(', ')} at ${hhmm}` : `daily at ${hhmm}`;
}

function textField(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\r\n?/g, '\n').trim();
  if (t.length === 0 || t.length > max) return null;
  return /[\p{Cc}\u2028\u2029]/u.test(t.replace(/[\n\t]/g, ' ')) ? null : t;
}

function parseStored(raw: unknown): StoredRoutine | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ROUTINE_ID_RE.test(r.id)) return null;
  if (typeof r.botId !== 'string' || typeof r.workspaceId !== 'string' || !r.botId || !r.workspaceId) return null;
  const title = oneLine(r.title, ROUTINE_LIMITS.TITLE_MAX);
  const prompt = textField(r.prompt, ROUTINE_LIMITS.PROMPT_MAX);
  // A stored schedule is held to the floor of its time, not today's.
  const schedule = parseSchedule(r.schedule, 1);
  const quietHours = parseQuietHours(r.quietHours);
  if (!title || !prompt || typeof schedule === 'string' || typeof quietHours === 'string') return null;
  if (r.state !== 'active' && r.state !== 'paused' && r.state !== 'done') return null;
  for (const k of ['createdAt', 'updatedAt'] as const) if (!Number.isSafeInteger(r[k])) return null;
  const threadId = r.threadId === undefined ? undefined : parseThreadId(r.threadId) ?? undefined;
  const p = r.paused as { reason?: unknown; at?: unknown } | undefined;
  const paused = r.state === 'paused' && p && PAUSE_REASONS.includes(p.reason as RoutinePauseReason) && Number.isSafeInteger(p.at)
    ? { reason: p.reason as RoutinePauseReason, at: p.at as number }
    : r.state === 'paused' ? { reason: 'owner' as const, at: r.updatedAt as number } : undefined;
  const d = r.done as { reason?: unknown; at?: unknown } | undefined;
  const done = r.state === 'done' && d && DONE_REASONS.includes(d.reason as RoutineDoneReason) && Number.isSafeInteger(d.at)
    ? { reason: d.reason as RoutineDoneReason, at: d.at as number }
    : r.state === 'done' ? { reason: 'missed' as const, at: r.updatedAt as number } : undefined;
  return {
    id: r.id,
    botId: r.botId,
    workspaceId: r.workspaceId,
    title,
    prompt,
    schedule,
    ...(quietHours ? { quietHours } : {}),
    ...(threadId ? { threadId } : {}),
    state: r.state,
    ...(paused ? { paused } : {}),
    ...(done ? { done } : {}),
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
    ...(Number.isSafeInteger(r.lastFiredAt) ? { lastFiredAt: r.lastFiredAt as number } : {}),
    ...(r.state === 'active' && Number.isSafeInteger(r.nextDueAt) ? { nextDueAt: r.nextDueAt as number } : {}),
    ...(isClientId(r.clientRoutineId) ? { clientRoutineId: r.clientRoutineId } : {}),
  };
}

function publicCopy(r: StoredRoutine): BotRoutine {
  const out: StoredRoutine = {
    ...r,
    schedule: { ...r.schedule } as RoutineSchedule,
    ...(r.quietHours ? { quietHours: { ...r.quietHours } } : {}),
    ...(r.paused ? { paused: { ...r.paused } } : {}),
    ...(r.done ? { done: { ...r.done } } : {}),
  };
  delete out.clientRoutineId;
  return out;
}

// ── Store ──────────────────────────────────────────────────────────────────

/** The caller of a routine change: a bot (its binding) or the owner. */
export type RoutineActor = { kind: 'bot'; botId: string; workspaceId: string } | { kind: 'owner' };

export interface RoutineStoreDeps {
  file: string;
  now?: () => number;
  /** Shortest interval accepted (ROUTINE_LIMITS.MIN_INTERVAL_MS). */
  minIntervalMs?: number;
  bots: () => Pick<BotDirectoryApi, 'get'> | null;
  /** Where a routine's wake is queued; `list` and `drop` let a pause take
   *  back a wake that is still waiting. */
  wakes: () => (WakeSinkApi & Partial<Pick<WakeQueue, 'list' | 'drop'>>) | null;
  factLog: () => Pick<FactLogApi, 'append'> | null;
  rooms: () => Pick<RoomWriter, 'append'> | null;
  /** The card a bot's routine card answers now: the owner message its
   *  running wake is about, when in that room and thread (wakeReplyTo).
   *  Missing: none. */
  replyTo?: (botId: string, workspaceId: string, threadId: ThreadId) => string | undefined;
  /** "Run bots" is on. */
  factoryEnabled: () => boolean;
  /** Told after every change, for the renderer (BOT_EVENT). */
  emit?: (payload: BotEventPayload) => void;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string) => void;
}

export class RoutineStore {
  private routines: StoredRoutine[] = [];
  private readonly persister: FilePersister;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (msg: string) => void;
  private timer: unknown = null;
  private running = false;

  constructor(private readonly deps: RoutineStoreDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `r-${randomBytes(8).toString('hex')}`);
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.log = deps.log ?? ((m) => console.warn(`[factory] routines: ${m}`));
    this.persister = createFilePersister(deps.file, () => ({ version: ROUTINES_VERSION, routines: this.routines }));
  }

  /** Read the file (missing → empty). Throws on another version. */
  load(): void {
    const raw = readVersionedFile(this.deps.file, ROUTINES_VERSION);
    const list = raw && Array.isArray(raw.routines) ? raw.routines : [];
    const seen = new Set<string>();
    this.routines = [];
    for (const entry of list) {
      const r = parseStored(entry);
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      if (expired(r, this.now())) continue;
      // An active routine always has a due time.
      if (r.state === 'active' && r.nextDueAt === undefined) r.nextDueAt = nextSlot(r.schedule, this.now());
      this.routines.push(r);
    }
  }

  /** Start the timer: a slot missed while the app was closed fires on the
   *  first look. */
  start(): void {
    this.running = true;
    this.arm();
  }

  dispose(): void {
    this.running = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  flush(): Promise<void> {
    return this.persister.schedule();
  }

  private changed(botIds: Iterable<string>): void {
    void this.persister.schedule().catch((err) => this.log(`routines.json write failed: ${String(err)}`));
    for (const botId of new Set(botIds)) {
      try {
        this.deps.emit?.({ type: 'routines-changed', botId });
      } catch {
        /* a listener never breaks the store */
      }
    }
    this.arm();
  }

  // ── reads ──

  /** Every routine, or one bot's, oldest first (copies). */
  list(botId?: string): BotRoutine[] {
    return this.routines.filter((r) => botId === undefined || r.botId === botId).map(publicCopy);
  }

  get(routineId: string): BotRoutine | null {
    const r = this.routines.find((x) => x.id === routineId);
    return r ? publicCopy(r) : null;
  }

  // ── writes ──

  /** A bot creates a routine, or changes one of its own (`routineId`). The
   *  caller has checked that the bot runs a turn on the owner's words.
   *  `clientRoutineId` makes a create idempotent. */
  set(bot: { botId: string; workspaceId: string }, params: RoutineSetParams): RoutineResult {
    const p = (params ?? {}) as Partial<RoutineSetParams>;
    const title = oneLine(p.title, ROUTINE_LIMITS.TITLE_MAX);
    if (!title) return bad(`title is required (one line, at most ${ROUTINE_LIMITS.TITLE_MAX} characters)`);
    const prompt = textField(p.prompt, ROUTINE_LIMITS.PROMPT_MAX);
    if (!prompt) return bad(`prompt is required (at most ${ROUTINE_LIMITS.PROMPT_MAX} characters)`);
    const now = this.now();
    const schedule = parseSchedule(p.schedule, this.deps.minIntervalMs ?? ROUTINE_LIMITS.MIN_INTERVAL_MS, now);
    if (typeof schedule === 'string') return bad(schedule);
    const quietHours = parseQuietHours(p.quietHours);
    if (typeof quietHours === 'string') return bad(quietHours);
    const threadId = p.threadId === undefined ? undefined : parseThreadId(p.threadId);
    if (threadId === null) return bad('threadId is not a thread id');
    if (p.clientRoutineId !== undefined && !isClientId(p.clientRoutineId)) return bad('clientRoutineId is not a valid key');
    if (p.routineId !== undefined) {
      const r = this.routines.find((x) => x.id === p.routineId);
      if (!r || r.botId !== bot.botId) return { ok: false, code: 'not_found', message: `you have no routine ${String(p.routineId)}` };
      if (r.state === 'done' && this.atCap(bot.botId)) return tooMany();
      r.title = title;
      r.prompt = prompt;
      r.schedule = schedule;
      if (quietHours) r.quietHours = quietHours;
      else delete r.quietHours;
      if (threadId) r.threadId = threadId;
      else delete r.threadId;
      r.updatedAt = now;
      // A wake of it still waiting would run the changed routine early (and
      // a one-time routine again at its new time), so it goes.
      this.dropQueued(r);
      // A done one-time routine given a new time runs again.
      if (r.state === 'done') {
        r.state = 'active';
        delete r.done;
      }
      if (r.state === 'active') r.nextDueAt = nextSlot(schedule, now);
      this.card(r, { kind: 'bot', workspaceId: r.workspaceId, botId: r.botId }, 'Routine changed');
      this.changed([r.botId]);
      return { ok: true, routine: publicCopy(r) };
    }
    if (p.clientRoutineId) {
      const prior = this.routines.find((x) => x.botId === bot.botId && x.clientRoutineId === p.clientRoutineId);
      if (prior) return { ok: true, routine: publicCopy(prior) };
    }
    if (this.atCap(bot.botId)) return tooMany();
    const r: StoredRoutine = {
      id: this.newId(),
      botId: bot.botId,
      workspaceId: bot.workspaceId,
      title,
      prompt,
      schedule,
      ...(quietHours ? { quietHours } : {}),
      ...(threadId ? { threadId } : {}),
      state: 'active',
      createdAt: now,
      updatedAt: now,
      nextDueAt: nextSlot(schedule, now),
      ...(p.clientRoutineId ? { clientRoutineId: p.clientRoutineId } : {}),
    };
    this.routines.push(r);
    this.card(r, { kind: 'bot', workspaceId: r.workspaceId, botId: r.botId }, 'Routine created');
    this.changed([r.botId]);
    return { ok: true, routine: publicCopy(r) };
  }

  /** A done one-time routine is history, not a routine the bot keeps. */
  private atCap(botId: string): boolean {
    return this.routines.filter((x) => x.botId === botId && x.state !== 'done').length >= ROUTINE_LIMITS.MAX_PER_BOT;
  }

  /** Pause (`paused`) or resume a routine: a bot its own, the owner any. */
  pause(actor: RoutineActor, routineId: unknown, paused: unknown): RoutineResult {
    if (typeof routineId !== 'string' || !ROUTINE_ID_RE.test(routineId)) return bad('routineId is not a routine id');
    if (typeof paused !== 'boolean') return bad('paused must be true or false');
    const r = this.routines.find((x) => x.id === routineId);
    if (!r || (actor.kind === 'bot' && r.botId !== actor.botId)) return { ok: false, code: 'not_found', message: `you have no routine ${routineId}` };
    if (!paused && r.state === 'done') return bad('this one-time routine is done; give it a new time with routine_set (routineId)');
    const party: Party = actor.kind === 'bot' ? { kind: 'bot', workspaceId: r.workspaceId, botId: r.botId } : { kind: 'human' };
    if (paused && r.state === 'active') {
      this.pauseOne(r, actor.kind === 'bot' ? 'bot' : 'owner');
      this.card(r, party, 'Routine paused');
      this.changed([r.botId]);
    } else if (paused && r.state === 'done' && this.cancelDone(r)) {
      this.card(r, party, 'Routine paused');
      this.changed([r.botId]);
    } else if (!paused && r.state === 'paused') {
      this.resumeOne(r);
      // resumeOne marks a one-shot past its time missed instead of active.
      if ((r.state as StoredRoutine['state']) === 'active') this.card(r, party, 'Routine resumed');
      this.changed([r.botId]);
    }
    return { ok: true, routine: publicCopy(r) };
  }

  private pauseOne(r: StoredRoutine, reason: RoutinePauseReason): void {
    const now = this.now();
    r.state = 'paused';
    r.paused = { reason, at: now };
    r.updatedAt = now;
    delete r.nextDueAt;
    this.dropQueued(r);
  }

  /** A paused routine runs no more: its wake still waiting in the queue or
   *  parked with its bot is taken back (one already running goes on to its
   *  end). */
  private dropQueued(r: StoredRoutine): number {
    let n = 0;
    try {
      const q = this.deps.wakes();
      if (!q?.list || !q.drop) return 0;
      for (const w of q.list({ botId: r.botId, states: ['queued', 'parked'] })) {
        if (w.reason.kind === 'routine' && w.reason.routineId === r.id && q.drop(w.id, 'expired')) n++;
      }
    } catch (err) {
      this.log(`routine ${r.id}: queued wake not dropped: ${String(err)}`);
    }
    return n;
  }

  /** A pause or stop reaches a one-time routine that fired but whose wake
   *  has not started: the wake is taken back and the routine counts as
   *  missed. Returns whether a wake was taken back. */
  private cancelDone(r: StoredRoutine): boolean {
    if (r.done?.reason !== 'fired' || this.dropQueued(r) === 0) return false;
    const now = this.now();
    r.done = { reason: 'missed', at: now };
    r.updatedAt = now;
    return true;
  }

  /** A resumed routine counts from now, with no catch-up: a one-time
   *  routine whose time passed while paused is done as missed. */
  private resumeOne(r: StoredRoutine): void {
    const now = this.now();
    delete r.paused;
    r.updatedAt = now;
    if (r.schedule.kind === 'once' && r.schedule.at <= now) {
      r.state = 'done';
      r.done = { reason: 'missed', at: now };
      delete r.nextDueAt;
      this.card(r, { kind: 'system' }, 'Routine missed');
      return;
    }
    r.state = 'active';
    r.nextDueAt = nextSlot(r.schedule, now);
  }

  /** Pause every active routine of one bot (or of every bot) for `reason`.
   *  A stop also takes over a park or off-switch pause, so lifting those
   *  later does not resume what the owner stopped. A stop posts one card per
   *  routine; a park or an off switch none. Returns how many it paused. */
  pauseFor(botId: string | undefined, reason: 'stop' | 'park' | 'off'): number {
    const takesOver = (r: StoredRoutine): boolean => reason === 'stop' && r.state === 'paused' && (r.paused?.reason === 'park' || r.paused?.reason === 'off');
    const hit = this.routines.filter((r) => (r.state === 'active' || takesOver(r)) && (botId === undefined || r.botId === botId));
    for (const r of hit) {
      this.pauseOne(r, reason);
      if (reason === 'stop') this.card(r, { kind: 'system' }, 'Routine paused (stopped)');
    }
    // A one-time routine that fired with its wake still waiting is stopped too.
    const cancelled = this.routines.filter((r) => r.state === 'done' && (botId === undefined || r.botId === botId) && this.cancelDone(r));
    if (hit.length + cancelled.length > 0) this.changed([...hit, ...cancelled].map((r) => r.botId));
    return hit.length;
  }

  /** Resume what `reason` paused: a lifted park or off switch. Every bot's
   *  (botId undefined) resumes only the bots that are on. */
  resumeFor(botId: string | undefined, reason: 'park' | 'off'): number {
    const on = (id: string): boolean => botId !== undefined || this.botOf(id)?.enabled === true;
    const hit = this.routines.filter((r) => r.state === 'paused' && r.paused?.reason === reason && (botId === undefined || r.botId === botId) && on(r.botId));
    for (const r of hit) this.resumeOne(r);
    if (hit.length > 0) this.changed(hit.map((r) => r.botId));
    return hit.length;
  }

  /** A removed bot's routines go with it. */
  removeBot(botId: string): number {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.botId !== botId);
    const n = before - this.routines.length;
    if (n > 0) this.changed([botId]);
    return n;
  }

  // ── firing ──

  private arm(): void {
    if (!this.running) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    // A done routine is due too: it is pruned DONE_KEEP_MS after it ended.
    const due = this.routines.flatMap((r) => r.state === 'active' && r.nextDueAt !== undefined ? [r.nextDueAt]
      : r.done ? [r.done.at + DONE_KEEP_MS + 1] : []);
    if (due.length === 0) return;
    const wait = Math.min(TICK_MAX_MS, Math.max(TICK_MIN_MS, Math.min(...due) - this.now()));
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.tick();
    }, wait);
  }

  /** Fire every routine that is due (once each, at its latest slot) and
   *  skip the slots of bots that cannot run or that fall in quiet hours; a
   *  due one-time routine fires or is missed, and is done. Returns the ids
   *  fired. */
  tick(): string[] {
    const now = this.now();
    const fired: string[] = [];
    const touched = new Set<string>();
    // Done routines kept long enough go, while the app stays open too.
    for (const r of this.routines) if (expired(r, now)) touched.add(r.botId);
    if (touched.size > 0) this.routines = this.routines.filter((r) => !expired(r, now));
    for (const r of this.routines) {
      if (r.state !== 'active' || r.nextDueAt === undefined || r.nextDueAt > now) continue;
      touched.add(r.botId);
      const bot = this.botOf(r.botId);
      const runner = bot && bot.enabled && bot.parked?.reason !== 'human' && bot.parked?.reason !== 'error' && this.deps.factoryEnabled() ? bot : null;
      if (r.schedule.kind === 'once') {
        // Its one slot, after a restart too: it fires when at most
        // ONCE_GRACE_MS late and its bot can run; otherwise it is missed.
        const dueAt = r.nextDueAt;
        const ok = runner !== null && now - dueAt <= ONCE_GRACE_MS && this.fire(r, runner, dueAt);
        r.state = 'done';
        r.done = { reason: ok ? 'fired' : 'missed', at: now };
        r.updatedAt = now;
        delete r.nextDueAt;
        if (ok) {
          r.lastFiredAt = now;
          fired.push(r.id);
        } else {
          this.card(r, { kind: 'system' }, 'Routine missed');
        }
        continue;
      }
      // The latest slot due is the one that fires; the next is the slot
      // after it (after now, on the routine's own grid).
      const dueAt = latestSlot(r.schedule, r.nextDueAt, now);
      r.nextDueAt = nextSlot(r.schedule, dueAt);
      if (!runner) continue;
      if (r.quietHours && r.schedule.kind === 'interval' && (inQuietHours(r.quietHours, dueAt) || inQuietHours(r.quietHours, now))) continue;
      if (this.fire(r, runner, dueAt)) {
        r.lastFiredAt = now;
        fired.push(r.id);
      }
    }
    if (touched.size > 0) this.changed(touched);
    else this.arm();
    return fired;
  }

  private fire(r: StoredRoutine, bot: BotProfile, dueAt: number): boolean {
    const draft: FactDraft = {
      kind: 'schedule.fired',
      at: this.now(),
      workspaceId: bot.workspaceId,
      ref: { botId: bot.id, scheduleId: `routine:${r.id}@${dueAt}` },
      actor: { kind: 'system' },
      payload: { routineId: r.id, title: r.title, dueAt },
    };
    try {
      this.deps.factLog()?.append(draft);
    } catch (err) {
      this.log(`fact for routine ${r.id} not written: ${String(err)}`);
    }
    try {
      const item = this.deps.wakes()?.enqueue({
        botId: bot.id,
        workspaceId: bot.workspaceId,
        reason: { kind: 'routine', routineId: r.id, dueAt },
        priority: 2,
        threadId: r.threadId ?? GENERAL_THREAD,
      });
      return !!item;
    } catch (err) {
      this.log(`wake for routine ${r.id} not queued: ${String(err)}`);
      return false;
    }
  }

  private botOf(botId: string): BotProfile | null {
    try {
      return this.deps.bots()?.get(botId) ?? null;
    } catch {
      return null;
    }
  }

  private card(r: StoredRoutine, actor: Party, verb: string): void {
    try {
      const threadId = (r.threadId ?? GENERAL_THREAD) as ThreadId;
      const replyTo = actor.kind === 'bot' ? this.deps.replyTo?.(actor.botId, r.workspaceId, threadId) : undefined;
      this.deps.rooms()?.append({
        workspaceId: r.workspaceId,
        threadId,
        kind: 'routine',
        actor,
        title: `${verb}: ${r.title}`,
        body: `${scheduleLabel(r.schedule)}${r.quietHours && r.schedule.kind === 'interval' ? `, quiet ${r.quietHours.start}–${r.quietHours.end}` : ''}\n\n${r.prompt}`,
        refs: { routineId: r.id, botId: r.botId },
      }, replyTo ? { replyTo } : undefined);
    } catch (err) {
      this.log(`routine card not written: ${String(err)}`);
    }
  }
}

function bad(message: string): RoutineResult {
  return { ok: false, code: 'invalid_argument', message };
}

function expired(r: StoredRoutine, now: number): boolean {
  return r.done !== undefined && now - r.done.at > DONE_KEEP_MS;
}

function tooMany(): RoutineResult {
  return { ok: false, code: 'too_many', message: `a bot keeps at most ${ROUTINE_LIMITS.MAX_PER_BOT} routines; change or pause one instead` };
}

let current: RoutineStore | null = null;

/** Set by the routines module's start() (null on dispose). */
export function setRoutineStore(store: RoutineStore | null): void {
  current = store;
}

export function getRoutineStore(): RoutineStore | null {
  return current;
}
