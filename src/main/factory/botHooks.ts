// ─── Bot runtime hooks — what the runtime tells the fact log ───────────────
//
// The bot runtime (BotRuntime, the wake queue, budget accounting) reports the
// events the factory records as facts through this one listener seam: a budget
// refusal, a fan-out waiting for a worker slot, a bot parked on errors, a turn that was running when the app quit,
// an owner's message held while its bot is out of turns.
// The fact log module subscribes (`onBotHook`) and turns each into a fact; the
// runtime never imports the fact log. A listener that throws is logged and
// never breaks the emitter.

import type { ThreadId } from '../../shared/room';

export type BotHookEvent =
  | {
      type: 'bot.budget_exhausted';
      botId: string;
      workspaceId: string;
      /** Which window refused (a full worker slot is `bot.workers_full`). */
      reason: 'turns_hour' | 'turns_day' | 'worker_hours_day';
      wakeId?: string;
      /** When the window allows a turn again (a turn refusal only; absent:
       *  not by itself, or not known). */
      until?: number;
      /** When the bot was parked for it (a turn refusal: one report per
       *  park). Absent: no park (a worker start refused). */
      parkedAt?: number;
      at: number;
    }
  /** A bot's fan-out found every worker slot in use: its own
   *  (`scope` bot: maxConcurrentWorkers) or the factory's (`scope` factory:
   *  WAKE_LIMITS.GLOBAL_CONCURRENT_WORKERS). Not a budget limit: a slot
   *  frees when a running worker ends. */
  | { type: 'bot.workers_full'; botId: string; workspaceId: string; scope: 'bot' | 'factory'; running: number; limit: number; at: number }
  /** `until`: the turn hit the provider's usage limit; the bot is parked
   *  until then and picks up by itself. */
  | { type: 'bot.error'; botId: string; workspaceId: string; message: string; wakeId?: string; until?: number; at: number }
  | {
      /** A wake carrying the owner's words waits, queued, while its bot is
       *  out of turns (reported on every pass; the room shows it once). */
      type: 'wake.held';
      botId: string;
      workspaceId: string;
      wakeId: string;
      /** The wake's thread; absent = `general`. */
      threadId?: ThreadId;
      /** When the budget allows a turn again; null = not by itself. */
      until: number | null;
      at: number;
    }
  | {
      type: 'wake.interrupted';
      botId: string;
      workspaceId: string;
      wakeId: string;
      /** The wake's thread (WakeItem.threadId); absent = `general`. */
      threadId?: ThreadId;
      at: number;
    };

export type BotHookListener = (ev: BotHookEvent) => void;

const listeners = new Set<BotHookListener>();

/** Subscribe; returns the unsubscribe. */
export function onBotHook(listener: BotHookListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitBotHook(ev: BotHookEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(ev);
    } catch (err) {
      console.warn(`[factory] bot hook listener failed: ${String(err)}`);
    }
  }
}

/** Test-only. */
export function __resetBotHooksForTesting(): void {
  listeners.clear();
}
