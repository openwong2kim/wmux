// ─── A bot's limits today, and the one that stops it (pure) ───────────────
//
// A bot has four separate limits: turns (per hour when set, per day), worker
// time per day, workers running at once, and the factory's shared slots, plus
// its wake queue's cap. The profile's Today block shows each with what is
// used of it, and one line on top naming the FIRST thing that keeps the bot
// from new work now, in this order: paused by the owner, stopped after
// errors, at the provider's usage limit, out of turns, out of worker time,
// its workers at its cap, the factory full, its queue full. Above the limits
// stand the account its brain runs on and that account's 5-hour and weekly
// usage (when main holds a reading); below them the engine's API-equivalent
// cost estimate (when one was reported). The renderer only words what this
// returns.

import type { BotProfile, BotStatus } from '../../../shared/bot';
import { WAKE_LIMITS } from '../../../shared/wake';

export type BotBlocker =
  | { kind: 'paused' }
  | { kind: 'errors' }
  | { kind: 'usageLimit'; until: number }
  | { kind: 'turns'; until?: number }
  | { kind: 'workerTime'; until?: number }
  | { kind: 'workerCap'; running: number; max: number }
  | { kind: 'factoryWorkers'; running: number; max: number }
  | { kind: 'slots'; inUse: number; cap: number }
  | { kind: 'queue'; depth: number; cap: number };

/** One line of the Today block. Worker time is in minutes. */
export type BotTodayLine =
  | { id: 'account'; name: string | null; reached: false }
  | { id: 'quotaSession' | 'quotaWeekly'; pct: number; resetsAt?: number; reached: boolean }
  | { id: 'turnsHour' | 'turnsDay'; used: number; left: number; reached: boolean }
  | { id: 'workerTime'; usedMin: number; maxMin: number; reached: boolean }
  | { id: 'workers'; running: number; waiting: number; max: number; reached: boolean }
  | { id: 'queue'; depth: number; cap: number; reached: boolean }
  | { id: 'cost'; dayUsd: number; totalUsd: number; reached: false };

export interface BotBudgetView {
  /** Null: nothing keeps it from new work (or it is off, which its status says). */
  blocker: BotBlocker | null;
  lines: BotTodayLine[];
}

const minutes = (hours: number): number => Math.max(0, Math.floor(hours * 60));

/** The Today block of a bot from its profile and status. A status from an
 *  older build (no `usage`) derives what it can from budgetLeft and leaves
 *  out the workers line. */
export function botBudgetView(bot: Pick<BotProfile, 'enabled' | 'parked' | 'budget'>, status: BotStatus | null): BotBudgetView {
  if (!status) return { blocker: bot.enabled ? parkBlocker(bot) : null, lines: [] };
  const budget = bot.budget;
  const left = status.budgetLeft;
  const usage = status.usage;
  const lines: BotTodayLine[] = [];

  const quota = status.quota;
  if (quota && (quota.session || quota.weekly)) {
    lines.push({ id: 'account', name: quota.accountName, reached: false });
    if (quota.session) lines.push({ id: 'quotaSession', pct: quota.session.pct, ...(quota.session.resetsAt !== undefined ? { resetsAt: quota.session.resetsAt } : {}), reached: quota.session.pct >= 100 });
    if (quota.weekly) lines.push({ id: 'quotaWeekly', pct: quota.weekly.pct, ...(quota.weekly.resetsAt !== undefined ? { resetsAt: quota.weekly.resetsAt } : {}), reached: quota.weekly.pct >= 100 });
  }
  const hourCap = typeof budget.maxTurnsPerHour === 'number' && budget.maxTurnsPerHour > 0 ? budget.maxTurnsPerHour : null;
  if (hourCap !== null && left.turnsHour !== null) {
    lines.push({ id: 'turnsHour', used: usage?.turnsHour ?? Math.max(0, hourCap - left.turnsHour), left: left.turnsHour, reached: left.turnsHour <= 0 });
  }
  lines.push({ id: 'turnsDay', used: usage?.turnsDay ?? Math.max(0, budget.maxTurnsPerDay - left.turnsDay), left: left.turnsDay, reached: left.turnsDay <= 0 });
  const usedHours = usage?.workerHoursDay ?? Math.max(0, budget.maxWorkerHoursPerDay - left.workerHoursDay);
  const workerTimeOut = usedHours >= budget.maxWorkerHoursPerDay;
  lines.push({ id: 'workerTime', usedMin: minutes(usedHours), maxMin: minutes(budget.maxWorkerHoursPerDay), reached: workerTimeOut });
  // A worker waiting for a slot counts against the cap, as the fan-out counts it.
  const running = usage?.workersRunning;
  const waiting = usage?.workersWaiting ?? 0;
  const held = running === undefined ? undefined : running + waiting;
  if (running !== undefined && held !== undefined) {
    lines.push({ id: 'workers', running, waiting, max: budget.maxConcurrentWorkers, reached: held >= budget.maxConcurrentWorkers });
  }
  const queueCap = WAKE_LIMITS.PER_BOT_QUEUE_CAP;
  if (status.queueDepth > 0) {
    lines.push({ id: 'queue', depth: status.queueDepth, cap: queueCap, reached: status.queueDepth >= queueCap });
  }
  if (usage?.costUsdTotal !== undefined) {
    lines.push({ id: 'cost', dayUsd: usage.costUsdDay ?? 0, totalUsd: usage.costUsdTotal, reached: false });
  }

  return { blocker: bot.enabled ? firstBlocker(bot, status, { workerTimeOut, held, queueCap }) : null, lines };
}

/** What a park alone says (the status may not be reported yet). */
function parkBlocker(bot: Pick<BotProfile, 'parked'>): BotBlocker | null {
  const parked = bot.parked;
  if (parked?.reason === 'human') return { kind: 'paused' };
  if (parked?.reason === 'error') return parked.until !== undefined ? { kind: 'usageLimit', until: parked.until } : { kind: 'errors' };
  if (parked?.reason === 'budget') return { kind: 'turns' };
  return null;
}

function firstBlocker(
  bot: Pick<BotProfile, 'parked' | 'budget'>,
  status: BotStatus,
  seen: { workerTimeOut: boolean; held: number | undefined; queueCap: number },
): BotBlocker | null {
  const park = parkBlocker(bot);
  if (park && park.kind !== 'turns') return park;
  const parked = bot.parked;
  const left = status.budgetLeft;
  const hourOut = left.turnsHour !== null && left.turnsHour <= 0;
  if (parked?.reason === 'budget' || hourOut || left.turnsDay <= 0) {
    const until = status.usage?.nextTurnAt;
    return { kind: 'turns', ...(until !== undefined ? { until } : {}) };
  }
  if (seen.workerTimeOut) {
    const until = status.usage?.workerTimeAt;
    return { kind: 'workerTime', ...(until !== undefined ? { until } : {}) };
  }
  if (seen.held !== undefined && seen.held >= bot.budget.maxConcurrentWorkers) {
    return { kind: 'workerCap', running: seen.held, max: bot.budget.maxConcurrentWorkers };
  }
  const factory = status.usage?.factoryWorkers;
  if (factory !== undefined && factory >= WAKE_LIMITS.GLOBAL_CONCURRENT_WORKERS) {
    return { kind: 'factoryWorkers', running: factory, max: WAKE_LIMITS.GLOBAL_CONCURRENT_WORKERS };
  }
  const slots = status.usage?.slots;
  if (slots && slots.inUse >= slots.cap) return { kind: 'slots', inUse: slots.inUse, cap: slots.cap };
  if (status.queueDepth >= seen.queueCap) return { kind: 'queue', depth: status.queueDepth, cap: seen.queueCap };
  return null;
}
