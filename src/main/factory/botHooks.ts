// ─── Bot runtime hooks — what the runtime tells the fact log ───────────────
//
// The bot runtime (BotRuntime, the wake queue, budget accounting) reports the
// events the factory records as facts through this one listener seam: a budget
// refusal, a bot parked on errors, a turn that was running when the app quit,
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
      /** Which window refused. */
      reason: 'turns_hour' | 'turns_day' | 'concurrent_workers' | 'worker_hours_day' | 'factory_workers';
      wakeId?: string;
      /** When the window allows a turn again (a turn refusal only; absent:
       *  not by itself, or not known). */
      until?: number;
      at: number;
    }
  | { type: 'bot.error'; botId: string; workspaceId: string; message: string; wakeId?: string; at: number }
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
