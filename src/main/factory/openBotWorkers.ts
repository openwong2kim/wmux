// ─── Open bot workers — what fills a bot's worker cap ──────────────────────
//
// The fan-out's budget check (fanout.rpc.ts) and the bot's status (the
// profile's Today block, BotRuntime.status) count a bot's running workers
// the same way: its bot holders (workerHolders.ts), which every other cap
// filters too. Until the worker lifecycle host installs the holder set: open
// bot tasks, minus verify tasks whose verdict is recorded, plus the bot
// fan-outs booked and not started yet.

import { getTaskLedger } from '../deck/taskLedgerHost';
import { getFactLog, type FactLog } from './factLog';
import { getVerdictedTasks } from './verdictedTasks';
import { rowHoldsAgentSlot } from './agentSlots';
import { holderCounts, liveHolders } from './workerHolders';
import { getFanOutGuards } from '../worktask/fanoutGuards';
import type { LedgerEntry } from '../../shared/ledger';
import type { Fact } from '../../shared/facts';

/** The verify tasks among `taskIds` whose verdict.recorded fact (naming the
 *  task as its evidence) is still in the fact log. Empty when the log is not
 *  running or cannot be scanned. The factory's verdicted-tasks file keeps
 *  them after the fact is gone (verdictedTasks.ts). */
export function verdictedTaskIds(taskIds: readonly string[], log: unknown = getFactLog()): Set<string> {
  const out = new Set<string>();
  if (taskIds.length === 0 || !log || typeof (log as Partial<FactLog>).readWhere !== 'function') return out;
  const want = new Set(taskIds);
  // One fact per task is enough: the scan stops once every task is found.
  const firstVerdict = (f: Fact): boolean => {
    const id = f.ref?.taskId;
    if (f.kind !== 'verdict.recorded' || !id || !want.has(id) || out.has(id)) return false;
    out.add(id);
    return true;
  };
  try {
    (log as FactLog).readWhere(0, firstVerdict, want.size);
  } catch {
    out.clear(); // counted as open
  }
  return out;
}

/**
 * Open fan-out tasks started by `botId`, and by any bot. A verify task that
 * reported done (review_requested) and whose verdict is recorded has
 * finished its work — the verdict was the reason it ran — so it no longer
 * holds a worker slot. Pure over its inputs.
 */
export function countOpenBotWorkers(
  rows: ReadonlyArray<Pick<LedgerEntry, 'id' | 'status' | 'dispatch'>>,
  botId: string,
  verdicted: (taskIds: readonly string[]) => Set<string>,
): { bot: number; factory: number } {
  const botRows = rows.filter((e) => e.dispatch?.origin?.kind === 'bot');
  const done = verdicted(botRows.filter((e) => e.status === 'review_requested' && e.dispatch?.preset === 'verify').map((e) => e.id));
  let bot = 0;
  let factory = 0;
  for (const e of botRows) {
    if (done.has(e.id)) continue;
    factory++;
    if (e.dispatch?.origin?.botId === botId) bot++;
  }
  return { bot, factory };
}

/** Open workers of `botId`, and of every bot, as the fan-out's cap counts
 *  them: fan-outs still being started included (`botStarting`: the bot's). */
export function openBotWorkers(botId: string): { bot: number; factory: number; botStarting?: number } {
  const holders = liveHolders();
  if (holders) {
    const c = holderCounts(holders.holders, botId);
    return { bot: c.bot, factory: c.workers, botStarting: c.botStarting };
  }
  const rows = getTaskLedger().list({ openOnly: true }).filter((r) => rowHoldsAgentSlot(r));
  const open = countOpenBotWorkers(rows, botId, (ids) => {
    const kept = getVerdictedTasks();
    const found = verdictedTaskIds(ids.filter((id) => !kept?.has(id)));
    for (const id of ids) if (kept?.has(id)) found.add(id);
    return found;
  });
  // The bot fan-outs booked and not through their start (FanOutGuards).
  const booked = getFanOutGuards().reservedTasks().filter((u) => u.botId);
  const bookedBot = booked.filter((u) => u.botId === botId).length;
  return { bot: open.bot + bookedBot, factory: open.factory + booked.length, botStarting: bookedBot };
}
