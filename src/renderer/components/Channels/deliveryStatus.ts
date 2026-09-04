// ─── C-2: what actually happened to the message you posted ───────────────
//
// The channel view used to read the SENDER's own row out of `recipientSnapshot`
// — a row that is not there, because the sender is not one of its own message's
// recipients. So the only status that ever rendered came from the optimistic
// local row's `deliveryStatus: 'pending'`, which nothing overwrites until the
// authoritative row lands: the eternal "… sending".
//
// The honest answer is an aggregate over the OTHER recipients, plus the one
// outcome the snapshot cannot express — the wake worker giving up after its
// nudge budget (`channel.nudgeExhausted`), which means a human has to look.

import type { ChannelMessage } from '../../../shared/channels';

/**
 * The five things a sender's own message can be. Four map to the delivery
 * substrate; `unconfirmed` is an aged `pending` — the post is out but no
 * recipient outcome ever came back, which is a different thing from "still on
 * its way" and must stop reading as a spinner.
 */
export type DeliveryLabelState =
  | 'pending'
  | 'delivered'
  | 'target_gone'
  | 'nudge_exhausted'
  | 'unconfirmed';

/**
 * How long a `pending` may claim to be in flight. Delivery is a local PTY write
 * that resolves in one poll cycle (~1 s); half a minute without an outcome is
 * not slowness, it is silence.
 */
export const DELIVERY_UNCONFIRMED_AFTER_MS = 30_000;

/**
 * Per-message delivery state for the VIEWER'S OWN post. Returns `undefined` when
 * there is nothing honest to say: someone else's message, or a message whose
 * frozen recipient set contains nobody but the sender.
 *
 * Precedence is worst-news-first, because that is the news that needs a human:
 * an exhausted nudge episode outranks a `delivered` write (the bytes landed in
 * a pane that never acted on them), and any `delivered` outranks a dead target
 * (the message did reach someone).
 */
export function ownMessageDeliveryState(args: {
  message: ChannelMessage;
  viewerMemberId: string | null;
  /** Epoch ms — injected so the aging rule is testable. */
  now: number;
  /**
   * memberId → epoch ms of that member's last exhausted nudge episode in THIS
   * channel. A TIMESTAMP, not a membership set: an episode says "as of `at`,
   * this member had not answered", which is a claim about the messages that
   * were already posted when it fired. A set marked every row the sender ever
   * wrote in the channel — including ones posted MINUTES LATER, whose delivery
   * the worker never even attempted — as "no answer".
   */
  exhaustedAtByMember?: Readonly<Record<string, number>>;
}): DeliveryLabelState | undefined {
  const { message, viewerMemberId, now } = args;
  if (!viewerMemberId) return undefined;
  if (message.memberId !== viewerMemberId) return undefined;

  const aged = (state: 'pending'): DeliveryLabelState =>
    now - message.postedAt > DELIVERY_UNCONFIRMED_AFTER_MS ? 'unconfirmed' : state;

  const snapshot = (message.recipientSnapshot ?? []).filter(
    (row) => row.memberId !== viewerMemberId,
  );
  if (snapshot.length === 0) {
    // No frozen recipient set at all (optimistic row, or a pre-U2 message):
    // fall back to the message-level status, aged. A snapshot that exists but
    // holds only the sender means the post reached nobody by design — there is
    // no delivery to report, so say nothing rather than invent an outcome.
    if (message.recipientSnapshot) return undefined;
    return message.deliveryStatus === 'pending' ? aged('pending') : message.deliveryStatus;
  }

  // Only a message that was ALREADY POSTED when the episode ran out of budget
  // can be the one nobody answered. The flag's other exit is the store's
  // (`markChannelNudgeExhausted` is cleared when the member posts or its read
  // cursor advances), so a member that came back does not read "no answer"
  // forever.
  const exhaustedAt = args.exhaustedAtByMember;
  if (
    exhaustedAt &&
    snapshot.some((row) => {
      const at = exhaustedAt[row.memberId];
      return typeof at === 'number' && message.postedAt <= at;
    })
  ) {
    return 'nudge_exhausted';
  }
  if (snapshot.some((row) => row.status === 'delivered')) return 'delivered';
  if (snapshot.every((row) => row.status === 'target_gone')) return 'target_gone';
  return aged('pending');
}

/**
 * True when at least one of the viewer's own rows is still `pending` on its own
 * merits — the only state the passage of time can change (into `unconfirmed`).
 *
 * The transcript's aging clock is gated on this: a settled channel used to
 * repaint every 10 s to re-derive labels that could not move.
 */
export function needsDeliveryAgingClock(args: {
  messages: readonly ChannelMessage[];
  viewerMemberId: string | null;
  exhaustedAtByMember?: Readonly<Record<string, number>>;
}): boolean {
  const { messages, viewerMemberId } = args;
  if (!viewerMemberId) return false;
  return messages.some(
    (message) =>
      ownMessageDeliveryState({
        message,
        viewerMemberId,
        // The message's own postedAt — asks "is this row pending BEFORE aging?"
        now: message.postedAt,
        ...(args.exhaustedAtByMember ? { exhaustedAtByMember: args.exhaustedAtByMember } : {}),
      }) === 'pending',
  );
}

/** i18n key per state. Kept next to the states so a new state cannot ship
 *  without a string (the old renderer hard-coded English inline). */
export const DELIVERY_LABEL_KEY: Record<DeliveryLabelState, string> = {
  pending: 'channels.deliveryPending',
  delivered: 'channels.deliveryDelivered',
  target_gone: 'channels.deliveryTargetGone',
  nudge_exhausted: 'channels.deliveryNudgeExhausted',
  unconfirmed: 'channels.deliveryUnconfirmed',
};

/** English fallback per state, used when the locale has no string (identity
 *  translator in tests, or a partially translated locale). */
export const DELIVERY_LABEL_FALLBACK: Record<DeliveryLabelState, string> = {
  pending: '… sending',
  delivered: '✓ delivered',
  target_gone: '✗ target gone',
  nudge_exhausted: '! no answer — nudges exhausted',
  unconfirmed: '? delivery unconfirmed',
};
