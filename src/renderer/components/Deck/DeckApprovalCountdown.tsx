// ─── Command Deck — the approval auto-reject countdown badge ────────────────
//
// An approval prompt raised by the orchestrator's own delegation auto-DENIES on
// a deadline. In the deck's pty layout the dialog can be behind the TUI and the
// operator's whole view of the brain is this header row, so a silent expiry
// reads as "the brain just stopped for no reason". The badge says how long is
// left, in the one place that is always on screen.
//
// The contract field is `deadlineAt` — epoch ms, stamped when the dialog is
// actually displayed (a prompt still queued behind another one has no deadline
// yet). Nothing renders when no pending record carries one: a surface that
// invents a countdown it cannot substantiate is worse than no badge.
//
// Read-only. Answering still happens in the dialog / the approval inbox; this
// is an indicator, never a control — a header button that resolves an approval
// the operator cannot read on the same screen is exactly the affordance the
// approval design forbids.

import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { tokenAttrs } from '../../themes';

/** Below this the badge switches to the attention rendition. */
export const APPROVAL_URGENT_MS = 10_000;

/** The slice of a pending approval record the badge needs. */
export interface ApprovalDeadlineRecord {
  /** Epoch ms of the auto-reject, stamped when the dialog is displayed. */
  deadlineAt?: number;
  /**
   * The execute/fan-out/task queue's name for the same instant, already on the
   * wire (0 while the prompt is queued behind another). Read as the deadline
   * for those records until the daemon's approval records carry `deadlineAt`
   * to this surface themselves.
   */
  expiresAt?: number;
}

/** The soonest auto-reject among the pending records, or null when none has a
 *  deadline yet. Never returns a queued prompt's placeholder zero. */
export function soonestApprovalDeadline(
  records: readonly ApprovalDeadlineRecord[],
): number | null {
  let soonest: number | null = null;
  for (const r of records) {
    const at = typeof r.deadlineAt === 'number' && r.deadlineAt > 0
      ? r.deadlineAt
      : typeof r.expiresAt === 'number' && r.expiresAt > 0
        ? r.expiresAt
        : null;
    if (at !== null && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

export function DeckApprovalCountdown({
  t: tProp,
  records,
  now: nowProp,
}: {
  t?: (key: string) => string;
  /** Test seam — defaults to the store's pending execute approvals. */
  records?: readonly ApprovalDeadlineRecord[];
  /** Test seam for the tick clock. */
  now?: () => number;
}): React.ReactElement | null {
  const t = tProp ?? (() => '');
  const pending = useStore((s) => s.pendingExecuteApprovals);
  const order = useStore((s) => s.pendingExecuteApprovalOrder);
  const resolved =
    records ?? order.map((id) => pending[id]).filter((r): r is NonNullable<typeof r> => !!r);
  const deadlineAt = soonestApprovalDeadline(resolved);
  const clock = nowProp ?? Date.now;
  const [now, setNow] = useState(() => clock());

  // One 1 s tick, and only while a deadline exists — the deck re-renders on
  // every streamed token as it is, and a permanent timer here would add a
  // second render loop to a surface that is idle most of the time.
  useEffect(() => {
    if (deadlineAt === null) return;
    setNow(clock());
    const timer = setInterval(() => setNow(clock()), 1_000);
    return () => clearInterval(timer);
    // `clock` is deliberately NOT a dependency: it is a test seam, stable in
    // the app, and re-running on it would restart the interval on every render
    // of a parent that inlines the prop.
  }, [deadlineAt]);

  if (deadlineAt === null) return null;
  const remainingMs = Math.max(0, deadlineAt - now);
  const seconds = Math.ceil(remainingMs / 1000);
  const urgent = remainingMs <= APPROVAL_URGENT_MS;

  return (
    <span
      data-deck-approval-countdown
      data-urgent={urgent ? 'true' : undefined}
      // aria-live so a screen reader hears the deadline arrive; polite, since
      // the dialog itself is what actually demands the answer.
      aria-live="polite"
      className={`px-1.5 py-0.5 rounded-md text-[11px] font-mono ${
        urgent ? 'text-[var(--accent-red)]' : 'text-[var(--text-sub)]'
      }`}
      {...(urgent ? tokenAttrs('danger', 'text') : tokenAttrs('textSub', 'text'))}
    >
      {(t('deck.approvalCountdown') || 'Auto-reject in {seconds}s').replace(
        '{seconds}',
        String(seconds),
      )}
    </span>
  );
}

export default DeckApprovalCountdown;
