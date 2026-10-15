// ─── Typed handoffs — bot ↔ bot ↔ human messages with chain limits ─────────
//
// A handoff is one typed message between parties. The router
// (main/factory/handoffRouter.ts) decides the addressee from the deployment,
// stamps attribution, counts depth and hops, and refuses over the limits;
// every refusal becomes a `handoff.refused` fact and a room card. Delivery to
// a bot is a wake-queue item, never a terminal paste. `ask_person` lands as a
// question card (a WorkspaceDecision in the thread) and on the phone.

import type { FactRef } from './facts';
import type { ThreadId } from './room';

export type Party =
  | { kind: 'bot'; workspaceId: string; botId: string }
  | { kind: 'human' }                        // the owner (desktop or phone)
  | { kind: 'system' };

/** `message`: a free bot-to-bot message to one named bot (toBotId) in
 *  any workspace — a room mention travels as one, too. It wakes its
 *  addressee and expects no `result`. */
export type HandoffKind = 'dispatch' | 'result' | 'ask_person' | 'answer' | 'refusal' | 'message';

export type HandoffStatus = 'queued' | 'delivered' | 'answered' | 'refused' | 'expired';

export type HandoffRefusalCode = 'max_depth' | 'max_per_run' | 'no_addressee' | 'surface' | 'budget' | 'duplicate_result';

export interface Handoff {
  version: 1;
  /** 'h-' + ulid */
  id: string;
  /** The outer-loop run (Moa plan item or trigger instance) this hop belongs to. */
  runId: string;
  threadId: ThreadId;
  /** 0 = human/Moa origin; +1 per bot→bot hop. */
  depth: number;
  hopsInRun: number;
  from: Party;
  to: Party;
  kind: HandoffKind;
  /** handoff id */
  replyTo?: string;
  /** Decided by the router, not the model. */
  attribution: { originator: Party; chain: string[] };
  /** Where the answer lands (deployment decides). */
  landing: 'room' | 'room+phone' | 'wake';
  payload: { title: string; body: string; refs?: FactRef; options?: string[] };
  status: HandoffStatus;
  refusal?: { code: HandoffRefusalCode; detail: string };
  /** The sender's idempotency key: a second send with the same key returns
   *  this handoff instead of sending another. */
  clientHandoffId?: string;
  /** ask_person: asked in the bot's first (`intro`) wake — its greeting
   *  question, which closes once the bot has a job. Main-written. */
  intro?: true;
  /** ask_person: the owner card the asking turn was answering
   *  (RunningWake.ownerCardId); the question card replies to it when it is
   *  raised in that card's thread. Main-written. */
  ownerCardId?: string;
  /** ask_person: the handoff the asking bot was working on (a dispatch it
   *  had not answered yet). The answer's wake answers that hop: a result sent
   *  from it, with no replyTo, is that hop's result. Main-written. */
  forHop?: string;
  /** dispatch: the bots that take the work after the addressee, in order
   *  (a relay). Named by a coordinator only; see HandoffSendParams.next. */
  next?: string[];
  /** A dispatch wmux sent on for a relay: it carries the previous bot's
   *  result to the next bot, in the coordinator's name. Main-written. */
  relay?: true;
  /** A relay's result the relay could not pass on: why, as the coordinator
   *  reads it in the wake that brings it the result. Main-written. */
  relayStopped?: string;
  /** The coordinator's wake for a stopped relay is on disk. Main-written. */
  relayStopTold?: true;
  /** dispatch: the router opened its thread (a coordinator's parentless
   *  dispatch said in General, in its own 1:1, or in a group chat).
   *  Main-written. */
  opensThread?: true;
  /** dispatch that opened its thread: the coordinator's 1:1 thread
   *  (`dm:<botId>`) or the group chat's thread (`group:<id>`) it was said
   *  in; absent: General. The card pointing at the thread, and the owner's
   *  request it answers, are in that one. Main-written. */
  openedIn?: ThreadId;
  /** result / refusal: the card pointing at its thread (in General, or the
   *  1:1 or group it was opened from) is written. Main-written. */
  pointed?: true;
  createdAt: number;
  updatedAt: number;
}

/** Chain caps, sized for a group room: five bots answering one owner
 *  message and talking to each other (about twenty bot messages per owner
 *  message at most in the reference conversation). The first hops of an
 *  owner's run — bots woken by the owner's message speaking to other bots —
 *  never meet MAX_PER_RUN; they count toward it for the hops after them. */
export const HANDOFF_LIMITS = { MAX_DEPTH: 6, MAX_PER_RUN: 32, ASK_PERSON_TTL_MS: 7 * 24 * 3600_000, MAX_RELAY: 4 } as const;

export const HANDOFF_RPC = { send: 'handoff.send', answer: 'handoff.answer', list: 'handoff.list' } as const;

/** `ask_person` has its own RPC: it raises a question card, not a bot wake. */
export const ASK_PERSON_RPC = 'ask.person' as const;

/** `handoff.send` — a bot sends a dispatch / result / refusal / message. The
 *  sender is the caller's binding; the addressee is decided by the router:
 *  `toBotId` names one bot in any workspace (messaging is every bot's);
 *  else dispatch → `toWorkspaceId`'s enabled lead (its coordinator, else its
 *  `lead`-role bot), result / refusal → the
 *  `replyTo` handoff's sender (at most one per `replyTo`). `message` needs
 *  `toBotId`. Without a threadId the handoff stays in the parent's thread,
 *  else the running wake's. */
export interface HandoffSendParams {
  kind: 'dispatch' | 'result' | 'refusal' | 'message';
  /** The one bot to wake (an existing, enabled bot; never the sender). */
  toBotId?: string;
  toWorkspaceId?: string;
  replyTo?: string;
  threadId?: ThreadId;
  title: string;
  body: string;
  refs?: FactRef;
  /** Idempotency key; default `wake:<wakeId>:h<n>` from the running wake. */
  clientHandoffId?: string;
  /** dispatch, coordinator only: the bots (ids, at most
   *  HANDOFF_LIMITS.MAX_RELAY, each an enabled bot of the sender's
   *  workspace, none twice, never the sender or the addressee) that take
   *  the work after the addressee, in order. The router walks the relay:
   *  each bot's `result` goes to the coordinator's thread as a card and on
   *  to the next bot as a dispatch wmux sends in the coordinator's name; the
   *  coordinator is woken once, with the last result (or when the relay
   *  stops: a refusal, a bot no longer enabled, a limit). */
  next?: string[];
}

/** `ask.person` — a bot asks the owner; lands as a question card in the
 *  thread (+ phone). The answer comes back as an `answer` handoff (a wake). */
export interface AskPersonParams {
  threadId?: ThreadId;
  title: string;
  body: string;
  options?: string[];
  refs?: FactRef;
  /** Idempotency key; default `wake:<wakeId>:h<n>` from the running wake. */
  clientHandoffId?: string;
}

/** `handoff.answer` — operator only: answer an ask_person handoff. */
export interface HandoffAnswerParams { handoffId: string; answer: string; }

/** `handoff.list` — operator only: handoffs of one workspace. */
export interface HandoffListParams { workspaceId?: string; status?: HandoffStatus[]; limit?: number; }
