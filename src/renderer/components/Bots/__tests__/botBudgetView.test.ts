// The profile's Today block: each limit with what is used of it, and the
// first thing that keeps the bot from new work, in the owner's order.
import { describe, expect, it } from 'vitest';
import { botBudgetView } from '../botBudgetView';
import { DEFAULT_BOT_BUDGETS, type BotProfile, type BotStatus } from '../../../../shared/bot';
import { WAKE_LIMITS } from '../../../../shared/wake';

const budget = DEFAULT_BOT_BUDGETS.verifier; // 200 turns/day, 1 worker, 6 worker-hours

function bot(over: Partial<BotProfile> = {}): Pick<BotProfile, 'enabled' | 'parked' | 'budget'> {
  return { enabled: true, budget, ...over };
}

function status(over: Partial<BotStatus> = {}, usage: Partial<NonNullable<BotStatus['usage']>> = {}): BotStatus {
  return {
    botId: 'bot-0000000a', presence: 'idle', queueDepth: 0,
    budgetLeft: { turnsHour: null, turnsDay: 150, workerHoursDay: 4 },
    usage: { turnsHour: null, turnsDay: 50, workerHoursDay: 2, workersRunning: 0, factoryWorkers: 0, slots: { inUse: 1, cap: 5 }, ...usage },
    ...over,
  };
}

describe('botBudgetView', () => {
  it('lists turns, worker time and running workers; the queue only when not empty; no blocker when all is free', () => {
    const v = botBudgetView(bot(), status());
    expect(v.blocker).toBeNull();
    expect(v.lines).toEqual([
      { id: 'turnsDay', used: 50, left: 150, reached: false },
      { id: 'workerTime', usedMin: 120, maxMin: 360, reached: false },
      { id: 'workers', running: 0, waiting: 0, max: 1, reached: false },
    ]);
    const queued = botBudgetView(bot(), status({ queueDepth: 3 }));
    expect(queued.lines.at(-1)).toEqual({ id: 'queue', depth: 3, cap: WAKE_LIMITS.PER_BOT_QUEUE_CAP, reached: false });
  });

  it('shows the hour line only with an hourly cap', () => {
    const v = botBudgetView(bot({ budget: { ...budget, maxTurnsPerHour: 10 } }), status({ budgetLeft: { turnsHour: 0, turnsDay: 150, workerHoursDay: 4 } }, { turnsHour: 10 }));
    expect(v.lines[0]).toEqual({ id: 'turnsHour', used: 10, left: 0, reached: true });
    expect(v.blocker).toEqual({ kind: 'turns' });
  });

  it('the reviewer case: turns left but no worker time and a full queue reads "out of worker time"', () => {
    const v = botBudgetView(bot(), status(
      { queueDepth: 50, budgetLeft: { turnsHour: null, turnsDay: 26, workerHoursDay: 0 } },
      { turnsDay: 174, workerHoursDay: 6.2, workerTimeAt: 9_000 },
    ));
    expect(v.blocker).toEqual({ kind: 'workerTime', until: 9_000 });
    expect(v.lines.find((l) => l.id === 'workerTime')).toEqual({ id: 'workerTime', usedMin: 372, maxMin: 360, reached: true });
    expect(v.lines.find((l) => l.id === 'turnsDay')?.reached).toBe(false);
    expect(v.lines.find((l) => l.id === 'queue')?.reached).toBe(true);
  });

  it('names each blocker, the first in the owner\'s order winning', () => {
    const all = status(
      { queueDepth: 50, budgetLeft: { turnsHour: null, turnsDay: 0, workerHoursDay: 0 } },
      { workerHoursDay: 6, nextTurnAt: 5_000, workersRunning: 1, factoryWorkers: 3, slots: { inUse: 5, cap: 5 } },
    );
    expect(botBudgetView(bot({ parked: { reason: 'human', at: 1 } }), all).blocker).toEqual({ kind: 'paused' });
    expect(botBudgetView(bot({ parked: { reason: 'error', at: 1 } }), all).blocker).toEqual({ kind: 'errors' });
    expect(botBudgetView(bot({ parked: { reason: 'error', at: 1, until: 7_000 } }), all).blocker).toEqual({ kind: 'usageLimit', until: 7_000 });
    expect(botBudgetView(bot(), all).blocker).toEqual({ kind: 'turns', until: 5_000 });
    const turnsLeft = { ...all, budgetLeft: { ...all.budgetLeft, turnsDay: 10 } };
    expect(botBudgetView(bot(), turnsLeft).blocker).toEqual({ kind: 'workerTime' });
    const timeLeft = { ...turnsLeft, usage: { ...turnsLeft.usage!, workerHoursDay: 1 } };
    expect(botBudgetView(bot(), timeLeft).blocker).toEqual({ kind: 'workerCap', running: 1, max: 1 });
    // A worker waiting for an agent slot fills the cap as the fan-out counts it.
    const waiting = { ...timeLeft, usage: { ...timeLeft.usage!, workersRunning: 0, workersWaiting: 1 } };
    expect(botBudgetView(bot(), waiting).blocker).toEqual({ kind: 'workerCap', running: 1, max: 1 });
    expect(botBudgetView(bot(), waiting).lines.find((l) => l.id === 'workers')).toEqual({ id: 'workers', running: 0, waiting: 1, max: 1, reached: true });
    const capFree = { ...timeLeft, usage: { ...timeLeft.usage!, workersRunning: 0 } };
    expect(botBudgetView(bot(), capFree).blocker).toEqual({ kind: 'factoryWorkers', running: 3, max: WAKE_LIMITS.GLOBAL_CONCURRENT_WORKERS });
    const factoryFree = { ...capFree, usage: { ...capFree.usage!, factoryWorkers: 0 } };
    expect(botBudgetView(bot(), factoryFree).blocker).toEqual({ kind: 'slots', inUse: 5, cap: 5 });
    const slotsFree = { ...factoryFree, usage: { ...factoryFree.usage!, slots: { inUse: 2, cap: 5 } } };
    expect(botBudgetView(bot(), slotsFree).blocker).toEqual({ kind: 'queue', depth: 50, cap: WAKE_LIMITS.PER_BOT_QUEUE_CAP });
  });

  it('a budget park reads out of turns even with turns left; an off bot has no blocker', () => {
    expect(botBudgetView(bot({ parked: { reason: 'budget', at: 1 } }), status()).blocker).toEqual({ kind: 'turns' });
    expect(botBudgetView(bot({ enabled: false, parked: { reason: 'human', at: 1 } }), status()).blocker).toBeNull();
  });

  it('a status without usage (an older build) derives the lines and leaves out running workers', () => {
    const v = botBudgetView(bot(), { ...status(), usage: undefined });
    expect(v.lines.map((l) => l.id)).toEqual(['turnsDay', 'workerTime']);
    expect(v.lines[0]).toMatchObject({ used: 50, left: 150 });
    expect(botBudgetView(bot(), null)).toEqual({ blocker: null, lines: [] });
    // No status yet: a park still says why.
    expect(botBudgetView(bot({ parked: { reason: 'error', at: 1 } }), null)).toEqual({ blocker: { kind: 'errors' }, lines: [] });
  });
});
