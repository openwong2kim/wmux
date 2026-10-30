// ─── My Hermes — what a bot on the owner's own Hermes is sent ──────────────
//
// The input boundary of an own-mode bot, checked by BotRuntime on every turn
// (never once at spawn). The owner's Hermes runs with the owner's tool set
// and approvals, so only the owner's own words reach it:
// - only an attended, untainted wake: the owner's own message in the bot's
//   1:1 chat (wakeTaint.ts runningWakeAttended), or a slot of a routine the
//   owner wrote for this bot (routine.ownerSet: `author: 'owner'`, this
//   bot's, in its 1:1) over a clean wake and conversation
//   (wakeTaint.ts ownerRoutineWakeClean, and no signed-in data). Handoffs,
//   mentions, facts, the bot's own routines and the Run button carry no
//   owner words and are refused;
// - only the bot's 1:1 chat, and only while no other bot and no guest has
//   ever written there;
// - the prompt is the owner's message alone: no room history, no system
//   prompt (AcpBrainAdapter own mode), and a leading `/` is escaped so the
//   owner's words are never a Hermes slash command (only wmux's own `/tools`
//   probe sends one).

import type { WakeItem } from '../../shared/wake';
import { dmThreadId, isGuestSourcedCard, type RoomCard } from '../../shared/room';
import type { WakeRoutineSummary } from './wakePrompt';

/** A routine as a My Hermes wake checks it: the one lookup its verdict and
 *  its prompt are both built from (BotRuntime.ts). */
export type OwnHermesRoutine = Pick<WakeRoutineSummary, 'prompt' | 'author' | 'botId' | 'workspaceId' | 'threadId'>;

/** The stable code of a refusal the owner is told of (the `refusal` arg of
 *  the `wake.refused` room notice), so the reader's language words it. */
export type OwnHermesRefusalCode =
  | 'routineBotWritten' | 'routineOutsideDm' | 'routineCleanUnknown' | 'routineTainted' | 'roomDirtyPaused'
  | 'notOwnerMessage' | 'outsideDm' | 'notAttended' | 'roomUnreadable' | 'roomDirty';

/** Why an own-mode bot's wake is not sent to Hermes. `pause`: the reason
 *  stays until the owner acts, so the routine is paused (and the note posted
 *  once). `note`: the owner is told in the room. `code`: the note's stable
 *  code (null when no note is posted); `why` stays its English. */
export interface OwnHermesRefusal {
  why: string;
  pause: boolean;
  note: boolean;
  code: OwnHermesRefusalCode | null;
}

const room = (input: { roomClean: boolean | null }): { why: string; code: 'roomUnreadable' | 'roomDirty' } | null => {
  if (input.roomClean === null) return { why: 'wmux could not read this chat to check who wrote in it, so this was not sent to My Hermes.', code: 'roomUnreadable' };
  if (input.roomClean !== true) return { why: 'Another bot or a guest has written in this chat, so wmux no longer sends it to My Hermes.', code: 'roomDirty' };
  return null;
};

/** Why an own-mode bot's wake is not sent to Hermes, or null. `attended`:
 *  the owner's message is attended and clean (a `human` wake);
 *  `routineClean`: the wake and the conversation are clean with no
 *  signed-in data (a `routine` wake), null when that cannot be told now;
 *  `routine`: the routine as looked up for this wake (null: gone). What may
 *  pass by itself (a chat that could not be read, a check that could not be
 *  made) refuses this run only; what stays until the owner acts pauses the
 *  routine. Pure. */
export function ownHermesWakeRefusal(input: {
  item: WakeItem;
  botId: string;
  attended: boolean;
  routineClean: boolean | null;
  roomClean: boolean | null;
  routine: OwnHermesRoutine | null;
}): OwnHermesRefusal | null {
  const r = input.item.reason;
  const dm = dmThreadId(input.botId);
  if (r.kind === 'routine') {
    const rt = input.routine;
    // Gone, or not this bot's (a queue item naming another bot's routine):
    // nothing of the owner's to pause or tell.
    if (!rt) return { why: 'its routine is gone, so this was not sent to My Hermes.', pause: false, note: false, code: null };
    if (rt.botId !== input.botId || rt.workspaceId !== input.item.workspaceId) return { why: 'the routine is not this bot\'s, so this was not sent to My Hermes.', pause: false, note: false, code: null };
    if (rt.author !== 'owner') return { why: 'My Hermes runs only routines you set for it yourself; a bot wrote this one, so it is paused.', pause: true, note: true, code: 'routineBotWritten' };
    if (rt.threadId !== dm || input.item.threadId !== dm) return { why: 'My Hermes runs routines only in its 1:1 chat, so this one is paused.', pause: true, note: true, code: 'routineOutsideDm' };
    if (input.routineClean === null) return { why: 'wmux could not check that this conversation is clean, so this run of the routine was not sent to My Hermes.', pause: false, note: true, code: 'routineCleanUnknown' };
    if (!input.routineClean) return { why: 'This conversation has taken in outside text, so wmux paused this routine; start a new conversation with My Hermes, then resume it.', pause: true, note: true, code: 'routineTainted' };
    const dirty = room(input);
    if (!dirty) return null;
    // A chat that could not be read may be readable next time.
    return input.roomClean === null ? { ...dirty, pause: false, note: true } : { why: `${dirty.why} The routine is paused.`, pause: true, note: true, code: 'roomDirtyPaused' };
  }
  if (r.kind !== 'human') return { why: 'My Hermes answers only your own messages in its 1:1 chat, so this was not sent to it.', pause: false, note: true, code: 'notOwnerMessage' };
  if (input.item.threadId !== dm || r.room === true || r.roomWide === true || r.lead === true) {
    return { why: 'My Hermes talks with you one to one, so a message outside its 1:1 chat was not sent to it.', pause: false, note: true, code: 'outsideDm' };
  }
  if (!input.attended) return { why: 'wmux could not confirm this message is yours alone, so it was not sent to My Hermes.', pause: false, note: true, code: 'notAttended' };
  const dirty = room(input);
  return dirty ? { ...dirty, pause: false, note: true } : null;
}

/** The owner's message as Hermes is sent it: a leading `/` escaped. Pure. */
export function ownHermesPrompt(text: string): string {
  return text.replace(/^(\s*)\//, '$1\\/');
}

/** Whether the bot's 1:1 chat holds only the owner's, the bot's own and
 *  wmux's cards (no other bot's, no guest's, ever). Null when the room
 *  cannot be read. */
export function ownHermesRoomClean(
  writer: { find(workspaceId: string, match: (c: RoomCard) => boolean, opts?: { guests?: boolean }): RoomCard | null } | null,
  workspaceId: string,
  botId: string,
): boolean | null {
  if (!writer) return null;
  const thread = dmThreadId(botId);
  try {
    const other = writer.find(
      workspaceId,
      (c) => c.threadId === thread && (isGuestSourcedCard(c) || (c.actor.kind === 'bot' && c.actor.botId !== botId)),
      { guests: true },
    );
    return other === null;
  } catch {
    return null;
  }
}
