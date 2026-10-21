// ─── Wake queue — one queued turn for one bot ──────────────────────────────
//
// Persisted at `getWmuxDir()/factory/wake-queue.json` (main-owned). One
// running turn per bot; a human item while the bot is busy is queued, not
// refused. Facts that match one trigger within the batch window coalesce into
// one item. An item that was `running` when the app quit becomes
// `interrupted` on restore and is never replayed by itself.

import type { BotTrigger } from './bot';
import type { ThreadId } from './room';

export type WakeReason =
  | { kind: 'facts'; factIds: string[]; trigger: BotTrigger }
  | { kind: 'handoff'; handoffId: string }
  /** `runId`: the run every wake of one owner message shares, so the
   *  handoffs its addressees send count against one chain (handoff.ts
   *  HANDOFF_LIMITS). `room`: the message went to every bot of the room.
   *  `lead`: the message went to the room, which has a coordinator, so it
   *  alone got it (humanMessage.ts). `roomWide`: the message named no bot
   *  and this bot got it only as one of every bot of a room without a
   *  coordinator, so its closing text is not posted (BotRuntime.ts): it
   *  speaks with room_post or not at all. `roomAnswerer`, on such a wake:
   *  the room's oldest bot, which answers a greeting or a question to
   *  everyone when no other bot's job covers it. */
  | { kind: 'human'; text: string; source: 'desktop' | 'phone'; clientMessageId?: string; runId?: string; room?: true; lead?: true; roomWide?: true; roomAnswerer?: string }
  | { kind: 'schedule'; scheduleId: string }
  | { kind: 'manual'; by: 'human' }
  /** One firing of the bot's own routine (shared/botRoutine.ts). `dueAt`
   *  is the slot it fired for (a missed slot fires once, at its latest). */
  | { kind: 'routine'; routineId: string; dueAt: number }
  /** Another bot's room card named this bot in `mentions`
   *  (RoomPostParams). Main routes it as a handoff `to:{kind:'bot', botId}`
   *  so the chain's runId / depth / per-run caps apply; `handoffId` is that
   *  handoff, `cardId` the mentioning card, `fromBotId` its author. */
  | { kind: 'mention'; cardId: string; handoffId: string; fromBotId: string }
  /** The first wake of a bot the owner just added: greet and ask what
   *  to do, with choices (ask_person options). Enqueued once, by main. */
  | { kind: 'intro' }
  /** A worker slot freed for a fan-out the bot started while every slot was
   *  in use (main/factory/heldFanouts.ts): `args` are the fanout_start
   *  arguments it sent (absent when they were too long to keep), for the bot
   *  to start it again from this turn. `tainted`: the wake that asked for it
   *  carried outside text. `handoffId`: the handoff that wake delivered, so
   *  the tasks still answer it. `fingerprint`: of the arguments (a retry
   *  that started them retires this wake too). `guest`: the asking wake's
   *  guest provenance (wakeTaint.ts); absent reads as unknown unless clean. */
  | { kind: 'held_fanout'; heldId: string; heldAt: number; titles: string[]; args?: HeldFanoutArgs; fingerprint?: string; tainted: boolean; guest?: boolean; handoffId?: string }
  /** An outside agent's message named this bot (shared/guestBots.ts):
   *  `cardId` is its `guest` card, `text` what it said (redacted). Always
   *  tainted (wakeTaint.ts): nothing this wake starts merges without the
   *  owner. */
  | { kind: 'guest'; guestId: string; guestName: string; cardId: string; text: string };

/** A held fan-out's fanout_start arguments, as the bot's tool takes them. */
export interface HeldFanoutArgs {
  titles: string[];
  prompt?: string;
  task_prompts?: string[];
  preset?: string;
  files?: string[][];
  checkout?: { sha: string; fetch_ref?: string };
  secret_names?: string[];
  connectors?: string[];
  thread_id?: string;
}

/** A reason's dedupe key: enqueueing a reason whose key matches a kept,
 *  not-dropped item of the same bot returns that item instead. Null = never
 *  deduped (facts coalesce by trigger instead; manual and schedule wakes may
 *  repeat). Pure. */
export function wakeReasonDedupeKey(r: WakeReason): string | null {
  switch (r.kind) {
    case 'handoff': return `handoff:${r.handoffId}`;
    case 'human': return r.clientMessageId ? `human:${r.clientMessageId}` : null;
    case 'routine': return `routine:${r.routineId}:${r.dueAt}`;
    case 'mention': return `mention:${r.cardId}`;
    case 'intro': return 'intro';
    case 'held_fanout': return `held_fanout:${r.heldId}`;
    case 'guest': return `guest:${r.cardId}`;
    default: return null;
  }
}

export type WakeState = 'queued' | 'running' | 'done' | 'dropped' | 'parked' | 'interrupted';

export interface WakeItem {
  id: string;
  botId: string;
  workspaceId: string;
  reason: WakeReason;
  /** The room thread the wake is about (a fact's PR/issue/task thread, the
   *  handoff's thread, the thread a human message was posted in). Absent:
   *  none known. Batched facts merge only within one thread. */
  threadId?: ThreadId;
  /** 0 human, 1 handoff/verdict/merge, 2 batched facts */
  priority: 0 | 1 | 2;
  enqueuedAt: number;
  notBefore?: number;
  /** max 2; then a 'bot.error' fact and the item is parked with the bot */
  attempts: number;
  state: WakeState;
  /** `cross_workspace`: the wake named a workspace other than its bot's. */
  dropped?: { code: 'budget' | 'duplicate' | 'bot_disabled' | 'expired' | 'queue_full' | 'cross_workspace' };
}

export const WAKE_LIMITS = {
  GLOBAL_CONCURRENT_BOTS: 3,
  /** factory-wide, below FANOUT_LIVE_TASK_CAP (8) */
  GLOBAL_CONCURRENT_WORKERS: 3,
  PER_BOT_QUEUE_CAP: 50,
  BATCH_WINDOW_MS: 20_000,
  MAX_ATTEMPTS: 2,
  /** never expires */
  HUMAN_TTL_MS: 0,
  FACT_TTL_MS: 24 * 3600_000,
} as const;

/** Idempotency key of the `ordinal`-th fan-out a bot starts inside one wake,
 *  so a retried turn cannot start the same workers twice. */
export function botFanoutIdempotencyKey(wakeId: string, ordinal: number): string {
  return `wake:${wakeId}:${ordinal}`;
}
