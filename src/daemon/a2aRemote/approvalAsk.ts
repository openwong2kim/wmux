// The asking PC's side of remote approvals (`kind: 'approval'`,
// A2A_FEATURE_APPROVAL): what it checks before it sends an allow or deny for
// the prompt a worker on a task it sent shows, and how fast it sends them.
//
//   - The decision is checked against the offer the task's latest status
//     carries (`detail.approval`): the prompt id must be the one offered, and
//     `allow` only when the offer's `allowed` list has it. Anything else is
//     refused here, with nothing sent.
//   - At most A2A_APPROVALS_SENT_PER_WINDOW approvals go to one PC in any
//     A2A_APPROVALS_SENT_WINDOW_MS (rolling). The receiving PC refuses the
//     excess `rate-limited`, so past it this PC refuses with the time to wait
//     instead, with nothing sent.

import {
  A2A_APPROVALS_SENT_PER_WINDOW,
  A2A_APPROVALS_SENT_WINDOW_MS,
  A2A_REMOTE_APPROVAL_REASON_TEXT,
  type A2aRemoteApprovalDecision,
  type A2aRemoteApprovalOffer,
  type A2aRemoteStatusV1,
} from '../../shared/a2aRemote';

/** Approvals sent per receiving PC in a rolling window. */
export class ApprovalPacer {
  private readonly sent = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly max = A2A_APPROVALS_SENT_PER_WINDOW,
    private readonly windowMs = A2A_APPROVALS_SENT_WINDOW_MS,
  ) {}

  /** How long until one more may go to `hostId` (0: now). */
  waitMs(hostId: string): number {
    const times = this.prune(hostId);
    if (times.length < this.max) return 0;
    return Math.max(1, times[0] + this.windowMs - this.now());
  }

  /** One went to `hostId`. Called only for an approval that was queued. */
  note(hostId: string): void {
    const times = this.prune(hostId);
    times.push(this.now());
    this.sent.set(hostId, times);
  }

  private prune(hostId: string): number[] {
    const from = this.now() - this.windowMs;
    const times = (this.sent.get(hostId) ?? []).filter((t) => t > from);
    if (times.length > 0) this.sent.set(hostId, times);
    else this.sent.delete(hostId);
    return times;
  }
}

export type OfferCheck =
  | { ok: true; offer: A2aRemoteApprovalOffer }
  | { ok: false; error: 'not-offered' | 'deny-only'; message: string };

/**
 * Whether `decision` on `promptId` is one the task's latest status offers. The
 * status is the one this PC keeps for the task (A2aRemoteDelivery), as parsed
 * from the other PC: its `allowed` list already reads `['deny']` for a command
 * that was cut, redacted or not shown.
 */
export function checkApprovalOffer(
  status: A2aRemoteStatusV1 | undefined,
  promptId: string,
  decision: A2aRemoteApprovalDecision,
): OfferCheck {
  const offer = status?.detail?.approval;
  if (!offer) {
    return { ok: false, error: 'not-offered', message: 'the task\'s status offers no permission prompt now; read it again (a2a_task_query)' };
  }
  if (offer.promptId !== promptId) {
    return { ok: false, error: 'not-offered', message: `${A2A_REMOTE_APPROVAL_REASON_TEXT['not-offered']} (it offers ${offer.promptId} now)` };
  }
  if (!offer.allowed.includes(decision)) {
    return { ok: false, error: 'deny-only', message: `${A2A_REMOTE_APPROVAL_REASON_TEXT['deny-only']}; nothing was sent` };
  }
  return { ok: true, offer };
}
