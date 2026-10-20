// A bot's own routines: validation, the per-bot cap, firing once per slot
// (a run of missed slots fires once), skipping bots that cannot run, the
// pause reasons and what lifts them, cards, and persistence; one-time
// routines and their grace window; quiet hours.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotEventPayload, BotProfile } from '../../../shared/bot';
import type { FactDraft } from '../../../shared/facts';
import { ROUTINE_LIMITS, type RoutineSchedule } from '../../../shared/botRoutine';
import type { WakeEnqueueInput } from '../wakeQueue';
import type { RoomCardInput } from '../roomWriter';
import { ONCE_GRACE_MS, RoutineStore, inQuietHours, latestSlot, nextSlot, parseQuietHours, parseSchedule, routinesPath, scheduleLabel } from '../routines';

const MIN = 60_000;
const HOUR = 60 * MIN;
const A = 'bot-0000000a';
const B = 'bot-0000000b';

let dir = '';
let clock = 0;
const stores: RoutineStore[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-w2-routines-'));
  clock = new Date(2026, 9, 13, 8, 0, 0).getTime();
});
afterEach(async () => {
  // Let every write land before the folder goes.
  await Promise.all(stores.splice(0).map((s) => s.flush().catch(() => undefined)));
  fs.rmSync(dir, { recursive: true, force: true });
});

function profile(id: string, extra: Partial<BotProfile> = {}): BotProfile {
  return {
    version: 1, id, workspaceId: 'ws-1', role: 'lead', name: id, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerDay: 10, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 60_000 },
    enabled: true, createdAt: 1, updatedAt: 1, ...extra,
  };
}

function track(s: RoutineStore): RoutineStore {
  stores.push(s);
  return s;
}

function rig(over: { bots?: BotProfile[]; enabled?: boolean; replyTo?: (botId: string, workspaceId: string, threadId: string) => string | undefined } = {}) {
  const bots = over.bots ?? [profile(A), profile(B)];
  const facts: FactDraft[] = [];
  const wakes: WakeEnqueueInput[] = [];
  const queued: Array<{ id: string; botId: string; reason: WakeEnqueueInput['reason']; state: string }> = [];
  const cards: RoomCardInput[] = [];
  const events: BotEventPayload[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let n = 0;
  const state = { enabled: over.enabled ?? true };
  const make = () => track(new RoutineStore({
    file: routinesPath(dir),
    now: () => clock,
    bots: () => ({ get: (id: string) => bots.find((b) => b.id === id) ?? null }),
    wakes: () => ({
      enqueue: (i) => { wakes.push(i); queued.push({ id: `w-${wakes.length}`, botId: i.botId, reason: i.reason, state: 'queued' }); return { id: `w-${wakes.length}` } as never; },
      list: (f: { botId?: string; states?: readonly string[] } = {}) => queued.filter((w) => (!f.botId || w.botId === f.botId) && (!f.states || f.states.includes(w.state))) as never,
      drop: (id: string) => { const w = queued.find((x) => x.id === id); if (w) w.state = 'dropped'; return (w ?? null) as never; },
    }),
    factLog: () => ({ append: (d) => { facts.push(d); return null; } }),
    rooms: () => ({ append: (c, extra) => { cards.push(extra?.replyTo ? { ...c, replyTo: extra.replyTo } as RoomCardInput : c); return null; } }),
    ...(over.replyTo ? { replyTo: over.replyTo } : {}),
    factoryEnabled: () => state.enabled,
    emit: (e) => events.push(e),
    newId: () => `r-test${String(n += 1).padStart(6, '0')}`,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => undefined,
    log: () => undefined,
  }));
  const store = make();
  store.load();
  return { store, make, bots, facts, wakes, queued, cards, events, timers, state };
}

const hourly: RoutineSchedule = { kind: 'interval', everyMs: HOUR };
const set = (r: ReturnType<typeof rig>, botId = A, extra: Record<string, unknown> = {}) =>
  r.store.set({ botId, workspaceId: 'ws-1' }, { title: 'Check PRs', prompt: 'Read the open PRs and say what needs me.', schedule: hourly, ...extra });

describe('routine cards answer the owner message', () => {
  it('a bot\'s routine card replies to the owner message its wake is about; the owner\'s does not', () => {
    const asked: string[] = [];
    const r = rig({ replyTo: (botId, ws, thread) => { asked.push(`${botId} ${ws} ${thread}`); return 'c-owner'; } });
    const made = set(r);
    if (!made.ok) throw new Error('set failed');
    expect(r.cards[0]).toMatchObject({ kind: 'routine', actor: { kind: 'bot', botId: A }, replyTo: 'c-owner' });
    expect(asked).toEqual([`${A} ws-1 general`]);
    r.store.pause({ kind: 'owner' }, made.routine.id, true);
    expect(r.cards[1]).toMatchObject({ kind: 'routine', actor: { kind: 'human' } });
    expect(r.cards[1]).not.toHaveProperty('replyTo');
    expect(asked).toHaveLength(1);
  });
});

describe('schedules', () => {
  it('parseSchedule: an interval between the floor and 30 days; a daily time with optional weekdays', () => {
    expect(parseSchedule({ kind: 'interval', everyMs: 15 * MIN })).toEqual({ kind: 'interval', everyMs: 15 * MIN });
    expect(parseSchedule({ kind: 'interval', everyMs: 14 * MIN })).toMatch(/at most every 15 minutes/);
    expect(parseSchedule({ kind: 'interval', everyMs: 31 * 24 * HOUR })).toMatch(/30 days/);
    expect(parseSchedule({ kind: 'interval', everyMs: 1.5 })).toMatch(/whole number/);
    expect(parseSchedule({ kind: 'interval', everyMs: 5_000 }, 1_000)).toEqual({ kind: 'interval', everyMs: 5_000 });
    expect(parseSchedule({ kind: 'daily', hour: 9, minute: 30 })).toEqual({ kind: 'daily', hour: 9, minute: 30 });
    expect(parseSchedule({ kind: 'daily', hour: 9, minute: 0, weekdays: [5, 1, 1] })).toEqual({ kind: 'daily', hour: 9, minute: 0, weekdays: [1, 5] });
    expect(parseSchedule({ kind: 'daily', hour: 9, minute: 0, weekdays: [0, 1, 2, 3, 4, 5, 6] })).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    for (const bad of [{ kind: 'daily', hour: 24, minute: 0 }, { kind: 'daily', hour: 1, minute: 60 }, { kind: 'daily', hour: 1, minute: 0, weekdays: [] }, { kind: 'daily', hour: 1, minute: 0, weekdays: [7] }, { kind: 'cron' }, null]) {
      expect(typeof parseSchedule(bad), JSON.stringify(bad)).toBe('string');
    }
  });

  it('nextSlot / latestSlot: intervals step from the due time; daily slots are local times on allowed days', () => {
    expect(nextSlot(hourly, 1000)).toBe(1000 + HOUR);
    expect(latestSlot(hourly, 1000, 1000 + 3.5 * HOUR)).toBe(1000 + 3 * HOUR);
    expect(latestSlot(hourly, 1000, 500)).toBe(1000);
    const nine: RoutineSchedule = { kind: 'daily', hour: 9, minute: 0 };
    const today9 = new Date(2026, 9, 13, 9, 0).getTime();
    expect(nextSlot(nine, clock)).toBe(today9);
    expect(nextSlot(nine, today9)).toBe(new Date(2026, 9, 14, 9, 0).getTime());
    // Tuesday 2026-10-13: a Mondays-only routine waits until next Monday.
    expect(nextSlot({ ...nine, weekdays: [1] }, clock)).toBe(new Date(2026, 9, 19, 9, 0).getTime());
    expect(latestSlot(nine, today9, new Date(2026, 9, 16, 12, 0).getTime())).toBe(new Date(2026, 9, 16, 9, 0).getTime());
    expect(scheduleLabel(hourly)).toBe('every 1 h');
    expect(scheduleLabel({ kind: 'interval', everyMs: 15 * MIN })).toBe('every 15 min');
    expect(scheduleLabel({ ...nine, weekdays: [1, 3] })).toBe('Mon, Wed at 09:00');
  });
});

describe('RoutineStore', () => {
  it('a bot creates a routine: active, due one interval on, a routine card in its room, a routines-changed event', () => {
    const r = rig();
    const res = set(r);
    expect(res).toMatchObject({ ok: true, routine: { id: 'r-test000001', botId: A, workspaceId: 'ws-1', state: 'active', nextDueAt: clock + HOUR } });
    expect(r.cards).toEqual([expect.objectContaining({
      workspaceId: 'ws-1', threadId: 'general', kind: 'routine', actor: { kind: 'bot', workspaceId: 'ws-1', botId: A },
      title: 'Routine created: Check PRs', refs: { routineId: 'r-test000001', botId: A },
    })]);
    expect(r.cards[0].body).toContain('every 1 h');
    expect(r.events).toEqual([{ type: 'routines-changed', botId: A }]);
    expect(r.store.list(A)).toHaveLength(1);
    expect(r.store.list(B)).toHaveLength(0);
  });

  it('refuses bad fields, keeps a create idempotent by its key, and caps routines per bot', () => {
    const r = rig();
    expect(set(r, A, { title: '' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(set(r, A, { prompt: 'x'.repeat(ROUTINE_LIMITS.PROMPT_MAX + 1) })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(set(r, A, { prompt: 'bad\u0007bell' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(set(r, A, { schedule: { kind: 'interval', everyMs: MIN } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(set(r, A, { threadId: 'nope' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    const first = set(r, A, { clientRoutineId: 'wake:w-1:r1' });
    const again = set(r, A, { clientRoutineId: 'wake:w-1:r1' });
    expect(again).toEqual(first);
    for (let i = 1; i < ROUTINE_LIMITS.MAX_PER_BOT; i++) expect(set(r).ok).toBe(true);
    expect(set(r)).toMatchObject({ ok: false, code: 'too_many' });
    expect(set(r, B).ok).toBe(true);
  });

  it('a bot changes only its own routine', () => {
    const r = rig();
    const made = set(r);
    if (!made.ok) throw new Error('create');
    clock += 10 * MIN;
    const changed = set(r, A, { routineId: made.routine.id, title: 'Check PRs and CI', schedule: { kind: 'interval', everyMs: 30 * MIN } });
    expect(changed).toMatchObject({ ok: true, routine: { title: 'Check PRs and CI', nextDueAt: clock + 30 * MIN } });
    expect(r.cards.at(-1)?.title).toBe('Routine changed: Check PRs and CI');
    expect(set(r, B, { routineId: made.routine.id })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('fires when due: a directed schedule.fired fact and a routine wake for its bot only; then the next slot', () => {
    const r = rig();
    const made = set(r, A, { threadId: 'pr:github.com/acme/app#4' });
    if (!made.ok) throw new Error('create');
    expect(r.store.tick()).toEqual([]);
    clock += HOUR;
    expect(r.store.tick()).toEqual([made.routine.id]);
    const due = clock;
    expect(r.facts).toEqual([expect.objectContaining({
      kind: 'schedule.fired', workspaceId: 'ws-1', ref: { botId: A, scheduleId: `routine:${made.routine.id}@${due}` }, actor: { kind: 'system' },
    })]);
    expect(r.wakes).toEqual([{ botId: A, workspaceId: 'ws-1', reason: { kind: 'routine', routineId: made.routine.id, dueAt: due }, priority: 2, threadId: 'pr:github.com/acme/app#4' }]);
    expect(r.store.get(made.routine.id)).toMatchObject({ lastFiredAt: due, nextDueAt: due + HOUR });
    expect(r.store.tick()).toEqual([]);
  });

  it('a run of missed slots fires once, at the latest slot, after a restart too', async () => {
    const r = rig();
    const made = set(r);
    if (!made.ok) throw new Error('create');
    const created = clock;
    await r.store.flush();
    clock = created + 5.5 * HOUR;
    const again = r.make();
    again.load();
    expect(again.tick()).toEqual([made.routine.id]);
    expect(r.wakes).toHaveLength(1);
    expect(r.wakes[0].reason).toEqual({ kind: 'routine', routineId: made.routine.id, dueAt: created + 5 * HOUR });
    expect(again.get(made.routine.id)?.nextDueAt).toBe(created + 6 * HOUR);
    expect(again.tick()).toEqual([]);
  });

  it('a slot of a bot that cannot run is skipped, not queued: off, parked by hand or by error, or Run bots off', () => {
    for (const [why, bot, enabled] of [
      ['disabled', profile(A, { enabled: false }), true],
      ['parked', profile(A, { parked: { reason: 'human', at: 1 } }), true],
      ['error', profile(A, { parked: { reason: 'error', at: 1 } }), true],
      ['factory off', profile(A), false],
      ['gone', profile(B), true],
    ] as const) {
      const r = rig({ bots: [bot], enabled });
      const made = set(r);
      if (!made.ok) throw new Error('create');
      clock += HOUR;
      expect(r.store.tick(), why).toEqual([]);
      expect(r.wakes, why).toEqual([]);
      expect(r.store.get(made.routine.id)?.nextDueAt, why).toBe(clock + HOUR);
      clock -= HOUR;
    }
    // A bot out of turns still gets its wake; the budget judges it there.
    const r = rig({ bots: [profile(A, { parked: { reason: 'budget', at: 1 } })] });
    set(r);
    clock += HOUR;
    expect(r.store.tick()).toHaveLength(1);
  });

  it('pause and resume: a bot its own (cards), the owner any; a resumed routine counts from now', () => {
    const r = rig();
    const made = set(r);
    if (!made.ok) throw new Error('create');
    expect(r.store.pause({ kind: 'bot', botId: B, workspaceId: 'ws-1' }, made.routine.id, true)).toMatchObject({ ok: false, code: 'not_found' });
    expect(r.store.pause({ kind: 'bot', botId: A, workspaceId: 'ws-1' }, 'bad', true)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(r.store.pause({ kind: 'bot', botId: A, workspaceId: 'ws-1' }, made.routine.id, 'yes')).toMatchObject({ ok: false, code: 'invalid_argument' });
    const paused = r.store.pause({ kind: 'bot', botId: A, workspaceId: 'ws-1' }, made.routine.id, true);
    expect(paused).toMatchObject({ ok: true, routine: { state: 'paused', paused: { reason: 'bot', at: clock } } });
    expect(paused.ok && paused.routine.nextDueAt).toBeUndefined();
    expect(r.cards.at(-1)?.title).toBe('Routine paused: Check PRs');
    clock += 3 * HOUR;
    expect(r.store.tick()).toEqual([]);
    const resumed = r.store.pause({ kind: 'owner' }, made.routine.id, false);
    expect(resumed).toMatchObject({ ok: true, routine: { state: 'active', nextDueAt: clock + HOUR } });
    expect(r.cards.at(-1)).toMatchObject({ title: 'Routine resumed: Check PRs', actor: { kind: 'human' } });
    expect(r.store.tick()).toEqual([]);
  });

  it('pauseFor / resumeFor: a stop stays until resumed by hand; a park or an off switch lifts with its cause', () => {
    const bots = [profile(A), profile(B)];
    const r = rig({ bots });
    const a = set(r, A);
    const b = set(r, B);
    if (!a.ok || !b.ok) throw new Error('create');
    const cardsBefore = r.cards.length;
    expect(r.store.pauseFor(A, 'stop')).toBe(1);
    expect(r.cards.slice(cardsBefore)).toEqual([expect.objectContaining({ title: 'Routine paused (stopped): Check PRs', actor: { kind: 'system' } })]);
    expect(r.store.pauseFor(B, 'park')).toBe(1);
    expect(r.cards).toHaveLength(cardsBefore + 1);
    expect(r.store.resumeFor(A, 'park')).toBe(0);
    expect(r.store.resumeFor(B, 'park')).toBe(1);
    expect(r.store.get(a.routine.id)?.state).toBe('paused');
    // Run bots off pauses every active one; on again resumes those of bots that are on.
    expect(r.store.pauseFor(undefined, 'off')).toBe(1);
    bots[1] = profile(B, { enabled: false });
    expect(r.store.resumeFor(undefined, 'off')).toBe(0);
    bots[1] = profile(B);
    expect(r.store.resumeFor(undefined, 'off')).toBe(1);
    expect(r.store.get(b.routine.id)).toMatchObject({ state: 'active', nextDueAt: clock + HOUR });
    expect(r.store.get(a.routine.id)).toMatchObject({ state: 'paused', paused: { reason: 'stop' } });
  });

  it('a pause takes back the routine\'s wake still queued; a stop takes over a park or off pause', () => {
    const r = rig();
    const a = set(r, A);
    const b = set(r, B);
    if (!a.ok || !b.ok) throw new Error('create');
    clock += HOUR;
    r.store.tick();
    expect(r.queued.map((w) => [w.botId, w.state])).toEqual([[A, 'queued'], [B, 'queued']]);
    expect(r.store.pauseFor(A, 'stop')).toBe(1);
    expect(r.queued.map((w) => [w.botId, w.state])).toEqual([[A, 'dropped'], [B, 'queued']]);
    // Parked, then stopped: lifting the park does not resume it.
    expect(r.store.pauseFor(B, 'park')).toBe(1);
    expect(r.queued[1].state).toBe('dropped');
    expect(r.store.pauseFor(B, 'stop')).toBe(1);
    expect(r.store.get(b.routine.id)).toMatchObject({ state: 'paused', paused: { reason: 'stop' } });
    expect(r.store.resumeFor(B, 'park')).toBe(0);
    expect(r.store.resumeFor(undefined, 'off')).toBe(0);
    // A stop again changes nothing; a bot's own pause is left as it is.
    expect(r.store.pauseFor(B, 'stop')).toBe(0);
  });

  it('a pause also takes back the routine\'s wake parked with its bot, so a resumed bot does not run it', () => {
    const r = rig();
    const a = set(r, A);
    if (!a.ok) throw new Error('create');
    clock += HOUR;
    r.store.tick();
    r.queued[0].state = 'parked';
    r.store.pause({ kind: 'owner' }, a.routine.id, true);
    expect(r.queued.map((w) => w.state)).toEqual(['dropped']);
  });

  it('a removed bot\'s routines go; the store reloads what it wrote and drops what is malformed', async () => {
    const r = rig();
    set(r, A);
    set(r, B);
    expect(r.store.removeBot(A)).toBe(1);
    await r.store.flush();
    const raw = JSON.parse(fs.readFileSync(routinesPath(dir), 'utf8')) as { version: number; routines: unknown[] };
    raw.routines.push({ id: 'not-an-id' }, { ...(raw.routines[0] as object), id: 'r-dupe0000001', schedule: { kind: 'cron' } });
    fs.writeFileSync(routinesPath(dir), JSON.stringify(raw));
    const again = r.make();
    again.load();
    expect(again.list().map((x) => x.botId)).toEqual([B]);
    fs.writeFileSync(routinesPath(dir), JSON.stringify({ version: 2, routines: [] }));
    expect(() => r.make().load()).toThrow(/version/);
  });

  it('the timer is armed for the earliest due routine, at most a minute out', () => {
    const r = rig();
    r.store.start();
    expect(r.timers).toHaveLength(0);
    set(r, A, { schedule: { kind: 'interval', everyMs: 20 * MIN } });
    expect(r.timers.at(-1)?.ms).toBe(60_000);
    clock += 19.9 * MIN;
    r.timers.at(-1)?.fn();
    expect(r.timers.at(-1)?.ms).toBe(6_000);
    clock += 0.1 * MIN;
    r.timers.at(-1)?.fn();
    expect(r.wakes).toHaveLength(1);
    r.store.dispose();
  });
});

describe('one-time routines and quiet hours', () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

  it('parseSchedule: a once time is ISO 8601 or epoch ms, ahead of now and within a year; a stored one may be past', () => {
    expect(parseSchedule({ kind: 'once', at: '2026-10-16T09:00' }, 1, clock)).toEqual({ kind: 'once', at: at(16, 9) });
    expect(parseSchedule({ kind: 'once', at: '2026-10-16T09:00:00Z' }, 1, clock)).toEqual({ kind: 'once', at: Date.UTC(2026, 9, 16, 9) });
    expect(parseSchedule({ kind: 'once', at: at(16, 9) }, 1, clock)).toEqual({ kind: 'once', at: at(16, 9) });
    expect(parseSchedule({ kind: 'once', at: '2026-10-12T09:00' }, 1, clock)).toMatch(/future/);
    expect(parseSchedule({ kind: 'once', at: clock + 366 * 24 * HOUR }, 1, clock)).toMatch(/year/);
    for (const bad of ['2026-10-16', 'Friday 9am', '2026-10-16T25:00', 1.5, undefined]) {
      expect(typeof parseSchedule({ kind: 'once', at: bad }, 1, clock), String(bad)).toBe('string');
    }
    expect(parseSchedule({ kind: 'once', at: at(1, 9) })).toEqual({ kind: 'once', at: at(1, 9) });
    expect(nextSlot({ kind: 'once', at: at(16, 9) }, at(17, 9))).toBe(at(16, 9));
    expect(scheduleLabel({ kind: 'once', at: at(16, 9) })).toBe('once on 2026-10-16 at 09:00');
  });

  it('parseQuietHours / inQuietHours: HH:MM pairs, start inclusive, end exclusive, wrapping past midnight', () => {
    expect(parseQuietHours(undefined)).toBeUndefined();
    expect(parseQuietHours({ start: '22:00', end: '07:00' })).toEqual({ start: '22:00', end: '07:00' });
    for (const bad of [{ start: '22:00' }, { start: '24:00', end: '07:00' }, { start: '9:00', end: '10:00' }, { start: '08:00', end: '08:00' }, 'night', null]) {
      expect(typeof parseQuietHours(bad), JSON.stringify(bad)).toBe('string');
    }
    const night = { start: '22:00', end: '07:00' };
    expect([at(13, 21, 59), at(13, 22), at(13, 23, 30), at(14, 2), at(14, 6, 59), at(14, 7), at(14, 12)].map((t) => inQuietHours(night, t)))
      .toEqual([false, true, true, true, true, false, false]);
    const lunch = { start: '12:00', end: '13:00' };
    expect([at(13, 11, 59), at(13, 12), at(13, 12, 59), at(13, 13)].map((t) => inQuietHours(lunch, t))).toEqual([false, true, true, false]);
  });

  it('a once routine fires at its time, is then done, and never fires again, after a restart too', async () => {
    const r = rig();
    const made = set(r, A, { schedule: { kind: 'once', at: '2026-10-13T09:30' } });
    if (!made.ok) throw new Error('create');
    expect(made.routine).toMatchObject({ state: 'active', nextDueAt: at(13, 9, 30) });
    clock = at(13, 9, 30);
    expect(r.store.tick()).toEqual([made.routine.id]);
    expect(r.wakes[0].reason).toEqual({ kind: 'routine', routineId: made.routine.id, dueAt: at(13, 9, 30) });
    expect(r.store.get(made.routine.id)).toMatchObject({ state: 'done', done: { reason: 'fired', at: clock }, lastFiredAt: clock });
    expect(r.store.get(made.routine.id)?.nextDueAt).toBeUndefined();
    clock += 24 * HOUR;
    expect(r.store.tick()).toEqual([]);
    await r.store.flush();
    const again = r.make();
    again.load();
    expect(again.tick()).toEqual([]);
    expect(r.wakes).toHaveLength(1);
    // A done one cannot resume, and a new time runs it again.
    expect(again.pause({ kind: 'owner' }, made.routine.id, false)).toMatchObject({ ok: false, code: 'invalid_argument' });
    const rearm = (s: RoutineStore) => s.set({ botId: A, workspaceId: 'ws-1' }, { routineId: made.routine.id, title: 'Standup', prompt: 'Remind me.', schedule: { kind: 'once', at: at(15, 9) } });
    const rearmed = rearm(r.store);
    expect(rearmed).toMatchObject({ ok: true, routine: { state: 'active', nextDueAt: at(15, 9) } });
    expect(rearmed.ok && rearmed.routine.done).toBeUndefined();
    // A done one does not count toward the cap, until it is re-armed.
    for (let i = 0; i < ROUTINE_LIMITS.MAX_PER_BOT; i++) expect(set({ ...r, store: again }).ok).toBe(true);
    expect(set({ ...r, store: again })).toMatchObject({ ok: false, code: 'too_many' });
    expect(rearm(again)).toMatchObject({ ok: false, code: 'too_many' });
  });

  it('a once routine missed while the app was closed fires on start within the grace window, else is done as missed', async () => {
    for (const [late, outcome] of [[ONCE_GRACE_MS - MIN, 'fired'], [ONCE_GRACE_MS + MIN, 'missed']] as const) {
      fs.rmSync(routinesPath(dir), { force: true });
      clock = at(13, 8);
      const r = rig();
      const made = set(r, A, { schedule: { kind: 'once', at: at(13, 9) } });
      if (!made.ok) throw new Error('create');
      await r.store.flush();
      clock = at(13, 9) + late;
      const again = r.make();
      again.load();
      expect(again.tick(), outcome).toEqual(outcome === 'fired' ? [made.routine.id] : []);
      expect(r.wakes, outcome).toHaveLength(outcome === 'fired' ? 1 : 0);
      expect(again.get(made.routine.id), outcome).toMatchObject({ state: 'done', done: { reason: outcome } });
      if (outcome === 'missed') expect(r.cards.at(-1)).toMatchObject({ title: 'Routine missed: Check PRs', actor: { kind: 'system' } });
      await again.flush();
    }
  });

  it('a once routine whose bot cannot run at its time is missed, not held', () => {
    const r = rig({ bots: [profile(A, { enabled: false })] });
    const made = set(r, A, { schedule: { kind: 'once', at: at(13, 9) } });
    if (!made.ok) throw new Error('create');
    clock = at(13, 9);
    expect(r.store.tick()).toEqual([]);
    expect(r.store.get(made.routine.id)).toMatchObject({ state: 'done', done: { reason: 'missed' } });
  });

  it('an interval slot inside quiet hours is skipped, not queued; a daily or once routine runs through them', () => {
    clock = at(13, 20);
    const r = rig();
    const quietHours = { start: '22:00', end: '07:00' };
    const hourlyRoutine = set(r, A, { quietHours });
    const daily = set(r, A, { schedule: { kind: 'daily', hour: 23, minute: 0 }, quietHours });
    const once = set(r, A, { schedule: { kind: 'once', at: at(14, 2) }, quietHours });
    if (!hourlyRoutine.ok || !daily.ok || !once.ok) throw new Error('create');
    expect(r.cards[0].body).toContain('every 1 h, quiet 22:00–07:00');
    const firedAt = (h: number, d = 13) => { clock = at(d, h); return r.store.tick(); };
    expect(firedAt(21)).toEqual([hourlyRoutine.routine.id]);
    expect(firedAt(22)).toEqual([]);
    expect(firedAt(23)).toEqual([daily.routine.id]);
    expect(firedAt(2, 14)).toEqual([once.routine.id]);
    expect(r.store.get(hourlyRoutine.routine.id)?.nextDueAt).toBe(at(14, 3));
    expect(firedAt(6, 14)).toEqual([]);
    expect(firedAt(7, 14)).toEqual([hourlyRoutine.routine.id]);
    expect(set(r, A, { quietHours: { start: '22:00', end: '22:00' } })).toMatchObject({ ok: false, code: 'invalid_argument' });
  });

  it('a pause or stop takes back a fired once routine\'s wake still waiting; it is then missed', () => {
    const r = rig();
    const a = set(r, A, { schedule: { kind: 'once', at: at(13, 9) } });
    const b = set(r, B, { schedule: { kind: 'once', at: at(13, 9) } });
    if (!a.ok || !b.ok) throw new Error('create');
    clock = at(13, 9);
    expect(r.store.tick()).toEqual([a.routine.id, b.routine.id]);
    expect(r.queued.map((w) => w.state)).toEqual(['queued', 'queued']);
    // Stop bot A: its waiting wake goes, the other bot's stays.
    r.store.pauseFor(A, 'stop');
    expect(r.queued.map((w) => w.state)).toEqual(['dropped', 'queued']);
    expect(r.store.get(a.routine.id)).toMatchObject({ state: 'done', done: { reason: 'missed' } });
    // The owner pauses B's routine: same.
    expect(r.store.pause({ kind: 'owner' }, b.routine.id, true)).toMatchObject({ ok: true, routine: { state: 'done', done: { reason: 'missed' } } });
    expect(r.queued.map((w) => w.state)).toEqual(['dropped', 'dropped']);
    expect(r.cards.at(-1)).toMatchObject({ title: 'Routine paused: Check PRs', actor: { kind: 'human' } });
  });

  it('re-arming a done once routine takes back the wake of its last firing still waiting', () => {
    const r = rig();
    const made = set(r, A, { schedule: { kind: 'once', at: at(13, 9) } });
    if (!made.ok) throw new Error('create');
    clock = at(13, 9);
    r.store.tick();
    expect(r.queued.map((w) => w.state)).toEqual(['queued']);
    const rearmed = r.store.set({ botId: A, workspaceId: 'ws-1' }, { routineId: made.routine.id, title: 'Later', prompt: 'New prompt.', schedule: { kind: 'once', at: at(13, 10) } });
    expect(rearmed).toMatchObject({ ok: true, routine: { state: 'active', nextDueAt: at(13, 10) } });
    expect(r.queued.map((w) => w.state)).toEqual(['dropped']);
    clock = at(13, 10);
    expect(r.store.tick()).toEqual([made.routine.id]);
    expect(r.queued.map((w) => w.state)).toEqual(['dropped', 'queued']);
  });

  it('a once routine resumed after its time is missed, not caught up; one resumed before it still fires', () => {
    const r = rig();
    const late = set(r, A, { schedule: { kind: 'once', at: at(13, 9) } });
    const early = set(r, A, { schedule: { kind: 'once', at: at(13, 11) } });
    if (!late.ok || !early.ok) throw new Error('create');
    clock = at(13, 8, 30);
    expect(r.store.pauseFor(A, 'park')).toBe(2);
    clock = at(13, 10);
    expect(r.store.resumeFor(A, 'park')).toBe(2);
    expect(r.store.get(late.routine.id)).toMatchObject({ state: 'done', done: { reason: 'missed', at: clock } });
    expect(r.store.get(late.routine.id)).not.toHaveProperty('paused');
    expect(r.cards.at(-1)).toMatchObject({ title: 'Routine missed: Check PRs', actor: { kind: 'system' } });
    expect(r.store.get(early.routine.id)).toMatchObject({ state: 'active', nextDueAt: at(13, 11) });
    expect(r.store.tick()).toEqual([]);
    expect(r.wakes).toEqual([]);
    // The owner's own resume after its time: missed too, with no "resumed" card.
    r.store.pause({ kind: 'owner' }, early.routine.id, true);
    clock = at(13, 12);
    const cards = r.cards.length;
    expect(r.store.pause({ kind: 'owner' }, early.routine.id, false)).toMatchObject({ ok: true, routine: { state: 'done', done: { reason: 'missed' } } });
    expect(r.cards.slice(cards).map((c) => c.title)).toEqual(['Routine missed: Check PRs']);
  });

  it('any change to a routine takes back its wake still waiting', () => {
    const r = rig();
    const made = set(r);
    if (!made.ok) throw new Error('create');
    clock += HOUR;
    expect(r.store.tick()).toEqual([made.routine.id]);
    expect(r.queued.map((w) => w.state)).toEqual(['queued']);
    const changed = set(r, A, { routineId: made.routine.id, prompt: 'Remind me once.', schedule: { kind: 'once', at: clock + 2 * HOUR } });
    expect(changed).toMatchObject({ ok: true, routine: { state: 'active', nextDueAt: clock + 2 * HOUR } });
    expect(r.queued.map((w) => w.state)).toEqual(['dropped']);
  });

  it('a done routine is dropped seven days after it ended while the app stays open', () => {
    const r = rig();
    r.store.start();
    const made = set(r, A, { schedule: { kind: 'once', at: at(13, 9) } });
    if (!made.ok) throw new Error('create');
    clock = at(13, 9);
    r.timers.at(-1)?.fn();
    expect(r.store.get(made.routine.id)?.state).toBe('done');
    // With only a done routine left the timer still runs, and prunes it.
    const eventsBefore = r.events.length;
    clock += 6 * 24 * HOUR;
    r.timers.at(-1)?.fn();
    expect(r.store.list(A)).toHaveLength(1);
    clock += 24 * HOUR + MIN;
    r.timers.at(-1)?.fn();
    expect(r.store.list(A)).toEqual([]);
    expect(r.events.slice(eventsBefore)).toEqual([{ type: 'routines-changed', botId: A }]);
    r.store.dispose();
  });

  it('a stored routine without the new fields loads unchanged; a malformed quietHours drops the row', async () => {
    const r = rig();
    const made = set(r);
    if (!made.ok) throw new Error('create');
    await r.store.flush();
    const raw = JSON.parse(fs.readFileSync(routinesPath(dir), 'utf8')) as { version: number; routines: Array<Record<string, unknown>> };
    expect(raw.routines[0]).not.toHaveProperty('quietHours');
    raw.routines.push({ ...raw.routines[0], id: 'r-badquiet0001', quietHours: { start: 'late', end: '07:00' } });
    fs.writeFileSync(routinesPath(dir), JSON.stringify(raw));
    const again = r.make();
    again.load();
    expect(again.list()).toEqual([made.routine]);
  });
});
