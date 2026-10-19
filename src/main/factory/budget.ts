// ─── Bot budgets — sliding windows over a bot's own usage ──────────────────
//
// A bot's budget (shared/bot.ts BotBudget) caps turns per day (and per hour
// when the bot has an hourly cap: absent, or a stored 0, is none), workers
// running at once and worker-hours per day. Usage is recorded here as
// timestamps (a turn start, a worker's start and end) and persisted with the
// bot (botStore, `bots.json` `usage`); every check reads the windows that end
// now, so a refusal clears by itself as the window slides. All functions are
// pure over the usage record they are given.
//
// A refusal is never retried in a loop: the runtime parks the bot, emits a
// `bot.budget_exhausted` hook, and keeps the wake queued until the window
// allows a turn again (`nextTurnAllowedAt`), a profile edit raises the cap,
// or the owner resumes the bot.

import type { BotBudget } from '../../shared/bot';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export interface BotWorkerUsage {
  taskId: string;
  startedAt: number;
  /** Absent while the worker runs. */
  endedAt?: number;
}

export interface BotUsage {
  /** Turn start times inside the last day. */
  turns: number[];
  /** Workers that ran inside the last day, plus every one still running. */
  workers: BotWorkerUsage[];
  /** The engine's cost estimate (USD at API prices) of each turn inside the
   *  last day, and of every turn ever. Absent until a turn reports one. */
  cost?: { day: { at: number; usd: number }[]; total: number };
}

export type BudgetRefusalReason = 'turns_hour' | 'turns_day' | 'concurrent_workers' | 'worker_hours_day';

export type BudgetCheck = { ok: true } | { ok: false; reason: BudgetRefusalReason };

export function emptyUsage(): BotUsage {
  return { turns: [], workers: [] };
}

/** Drop what no window can see any more. Mutates and returns `usage`. */
export function pruneUsage(usage: BotUsage, now: number): BotUsage {
  usage.turns = usage.turns.filter((t) => t > now - DAY_MS && t <= now);
  usage.workers = usage.workers.filter((w) => w.endedAt === undefined || w.endedAt > now - DAY_MS);
  if (usage.cost) usage.cost.day = usage.cost.day.filter((c) => c.at > now - DAY_MS && c.at <= now);
  return usage;
}

/** Add one turn's cost estimate. Ignores a value that is not a finite,
 *  non-negative number. */
export function recordCost(usage: BotUsage, usd: number, now: number): void {
  if (!Number.isFinite(usd) || usd < 0) return;
  pruneUsage(usage, now);
  const cost = usage.cost ?? { day: [], total: 0 };
  cost.day.push({ at: now, usd });
  cost.total += usd;
  usage.cost = cost;
}

/** The cost estimate of the turns in the last day (USD). */
export function costUsdDay(usage: BotUsage, now: number): number {
  return (usage.cost?.day ?? []).filter((c) => c.at > now - DAY_MS && c.at <= now).reduce((sum, c) => sum + c.usd, 0);
}

function turnsSince(usage: BotUsage, since: number, now: number): number {
  return usage.turns.filter((t) => t > since && t <= now).length;
}

/** Worker time inside the last day, in hours (a running worker counts up to now). */
export function workerHoursDay(usage: BotUsage, now: number): number {
  const from = now - DAY_MS;
  let ms = 0;
  for (const w of usage.workers) {
    const start = Math.max(w.startedAt, from);
    const end = Math.min(w.endedAt ?? now, now);
    if (end > start) ms += end - start;
  }
  return ms / HOUR_MS;
}

export function runningWorkers(usage: BotUsage): number {
  return usage.workers.filter((w) => w.endedAt === undefined).length;
}

/** The bot's hourly turn cap, or null when it has none (absent, or a stored
 *  0, which the contract never writes). */
export function hourlyCap(budget: BotBudget): number | null {
  const cap = budget.maxTurnsPerHour;
  return typeof cap === 'number' && cap > 0 ? cap : null;
}

/** Turns the bot started inside the last day (the profile's "used today"). */
export function turnsUsedDay(usage: BotUsage, now: number): number {
  return turnsSince(usage, now - DAY_MS, now);
}

/** Turns the bot started inside the last hour. */
export function turnsUsedHour(usage: BotUsage, now: number): number {
  return turnsSince(usage, now - HOUR_MS, now);
}

/** The earliest time the bot's worker time in the last day drops below its
 *  cap again, counting its running workers as if they stopped now (a worker
 *  still running pushes the real time later): `now` when it is below the cap
 *  now, Infinity when the cap is 0. */
export function workerTimeAllowedAt(budget: BotBudget, usage: BotUsage, now: number): number {
  const max = budget.maxWorkerHoursPerDay;
  if (workerHoursDay(usage, now) < max) return now;
  if (max <= 0) return Infinity;
  // Worker time in the window ending at t, no worker time after now: it only
  // falls as t moves on, so a binary search finds the first t below the cap.
  const used = (t: number): number => {
    let ms = 0;
    for (const w of usage.workers) {
      const start = Math.max(w.startedAt, t - DAY_MS);
      const end = Math.min(w.endedAt ?? now, now);
      if (end > start) ms += end - start;
    }
    return ms / HOUR_MS;
  };
  let lo = now;
  let hi = now + DAY_MS;
  while (hi - lo > 1_000) {
    const mid = Math.floor((lo + hi) / 2);
    if (used(mid) < max) hi = mid;
    else lo = mid;
  }
  return hi;
}

export interface BudgetLeft {
  /** null: no hourly cap. */
  turnsHour: number | null;
  turnsDay: number;
  workerHoursDay: number;
}

export function budgetLeft(budget: BotBudget, usage: BotUsage, now: number): BudgetLeft {
  const perHour = hourlyCap(budget);
  return {
    turnsHour: perHour === null ? null : Math.max(0, perHour - turnsSince(usage, now - HOUR_MS, now)),
    turnsDay: Math.max(0, budget.maxTurnsPerDay - turnsSince(usage, now - DAY_MS, now)),
    workerHoursDay: Math.max(0, budget.maxWorkerHoursPerDay - workerHoursDay(usage, now)),
  };
}

/** May the bot start one more turn now? */
export function checkTurn(budget: BotBudget, usage: BotUsage, now: number): BudgetCheck {
  const perHour = hourlyCap(budget);
  if (perHour !== null && turnsSince(usage, now - HOUR_MS, now) >= perHour) return { ok: false, reason: 'turns_hour' };
  if (turnsSince(usage, now - DAY_MS, now) >= budget.maxTurnsPerDay) return { ok: false, reason: 'turns_day' };
  return { ok: true };
}

/** May the bot start `count` more workers now? `running` is the number of its
 *  workers still running (the caller's authoritative count, e.g. open ledger
 *  rows); usage supplies the worker-hours. */
export function checkWorkers(budget: BotBudget, usage: BotUsage, running: number, count: number, now: number): BudgetCheck {
  if (running + count > budget.maxConcurrentWorkers) return { ok: false, reason: 'concurrent_workers' };
  if (workerHoursDay(usage, now) >= budget.maxWorkerHoursPerDay) return { ok: false, reason: 'worker_hours_day' };
  return { ok: true };
}

/** The earliest time `checkTurn` allows a turn again if no other turn starts
 *  meanwhile: `now` when it allows one now, Infinity when a cap is 0. */
export function nextTurnAllowedAt(budget: BotBudget, usage: BotUsage, now: number): number {
  const turns = usage.turns.filter((t) => t <= now).sort((a, b) => a - b);
  // A window allows a turn once fewer than `max` of its turns are left in it:
  // when the (n - max + 1)-th newest one leaves.
  const freeAt = (span: number, max: number): number => {
    const inWindow = turns.filter((t) => t > now - span);
    if (inWindow.length < max) return now;
    if (max <= 0) return Infinity;
    return inWindow[inWindow.length - max] + span;
  };
  const perHour = hourlyCap(budget);
  return Math.max(perHour === null ? now : freeAt(HOUR_MS, perHour), freeAt(DAY_MS, budget.maxTurnsPerDay));
}

export function recordTurn(usage: BotUsage, now: number): void {
  pruneUsage(usage, now);
  usage.turns.push(now);
}

/** Give back the turn recorded at `at` (a turn that never reached the model:
 *  the network failed). Returns false when none was recorded then. */
export function unrecordTurn(usage: BotUsage, at: number): boolean {
  const i = usage.turns.lastIndexOf(at);
  if (i < 0) return false;
  usage.turns.splice(i, 1);
  return true;
}

/** A task's worker starts once: a second start of the same task records
 *  nothing. `resumed`: the task's stopped worker runs again, a new interval
 *  (unless one is still open). */
export function recordWorkerStart(usage: BotUsage, taskId: string, now: number, opts: { resumed?: boolean } = {}): void {
  pruneUsage(usage, now);
  const mine = usage.workers.filter((w) => w.taskId === taskId);
  if (opts.resumed ? mine.some((w) => w.endedAt === undefined) : mine.length > 0) return;
  usage.workers.push({ taskId, startedAt: now });
}

/** Returns false when the worker was not running. An end that comes before
 *  any start of the task is kept as an empty interval, so a start recorded
 *  after it does not open one that never ends. */
export function recordWorkerEnd(usage: BotUsage, taskId: string, now: number): boolean {
  const w = usage.workers.find((x) => x.taskId === taskId && x.endedAt === undefined);
  if (!w) {
    if (!usage.workers.some((x) => x.taskId === taskId)) usage.workers.push({ taskId, startedAt: now, endedAt: now });
    return false;
  }
  w.endedAt = Math.max(now, w.startedAt);
  return true;
}

const TASK_ID_MAX = 200;
const USAGE_TURNS_MAX = 2_000;
const USAGE_WORKERS_MAX = 500;

/** Validate a usage record read from disk; malformed entries are dropped. */
export function sanitizeUsage(raw: unknown): BotUsage {
  const out = emptyUsage();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.turns)) {
    out.turns = r.turns.filter((t): t is number => Number.isSafeInteger(t) && (t as number) > 0).slice(-USAGE_TURNS_MAX);
  }
  if (Array.isArray(r.workers)) {
    for (const w of r.workers.slice(-USAGE_WORKERS_MAX)) {
      if (!w || typeof w !== 'object') continue;
      const x = w as Record<string, unknown>;
      if (typeof x.taskId !== 'string' || x.taskId.length === 0 || x.taskId.length > TASK_ID_MAX) continue;
      if (!Number.isSafeInteger(x.startedAt)) continue;
      if (x.endedAt !== undefined && !Number.isSafeInteger(x.endedAt)) continue;
      out.workers.push({
        taskId: x.taskId,
        startedAt: x.startedAt as number,
        ...(x.endedAt !== undefined ? { endedAt: x.endedAt as number } : {}),
      });
    }
  }
  const cost = r.cost as Record<string, unknown> | null | undefined;
  if (cost && typeof cost === 'object' && !Array.isArray(cost) && isUsd(cost.total)) {
    const day: { at: number; usd: number }[] = [];
    for (const c of Array.isArray(cost.day) ? cost.day.slice(-USAGE_TURNS_MAX) : []) {
      const x = c as Record<string, unknown> | null;
      if (x && typeof x === 'object' && Number.isSafeInteger(x.at) && (x.at as number) > 0 && isUsd(x.usd)) day.push({ at: x.at as number, usd: x.usd as number });
    }
    out.cost = { day, total: cost.total as number };
  }
  return out;
}

function isUsd(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}
