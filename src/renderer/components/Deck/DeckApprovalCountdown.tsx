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
//
// Renditions (DESIGN.md attention grammar: one event, at most TWO). The dialog
// is one. This badge is the second — UNLESS the Fleet cockpit's Approvals tab
// is open, which draws its own per-row countdown and is then the surface that
// owns the prompt. In that state the badge steps aside rather than making the
// same deadline the third thing on screen counting the same seconds down.

import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { selectInboxOwnsApprovals } from '../../stores/selectors/approvalInbox';
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
  /** Who raised the request, and where it would run. Either side matching the
   *  deck's workspace makes the prompt this header's business. */
  senderWorkspaceId?: string;
  receiverWorkspaceId?: string;
}

/**
 * The pending prompts THIS deck should count down. The approval queue is
 * app-wide, so without this the header of workspace A reports the deadline of a
 * prompt raised by (and answerable in) workspace B — a countdown the operator
 * cannot act on here, attached to a brain it does not describe.
 *
 * With no workspace to scope to, nothing is filtered: an unscoped caller wants
 * the whole queue, which is what it got before this existed.
 */
export function approvalsForWorkspace(
  records: readonly ApprovalDeadlineRecord[],
  workspaceId: string | undefined,
): readonly ApprovalDeadlineRecord[] {
  if (!workspaceId) return records;
  return records.filter(
    (r) => r.receiverWorkspaceId === workspaceId || r.senderWorkspaceId === workspaceId,
  );
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
  workspaceId,
  now: nowProp,
  inboxOwnsApprovals: inboxOwnsApprovalsProp,
}: {
  t?: (key: string) => string;
  /** Test seam — defaults to the store's pending execute approvals. */
  records?: readonly ApprovalDeadlineRecord[];
  /** The deck's workspace. Scopes the queue to prompts this header describes;
   *  omitted ⇒ the whole queue (see approvalsForWorkspace). */
  workspaceId?: string;
  /** Test seam for the tick clock. */
  now?: () => number;
  /** Test seam — defaults to the store's Fleet cockpit state. */
  inboxOwnsApprovals?: boolean;
}): React.ReactElement | null {
  const t = tProp ?? (() => '');
  const pending = useStore((s) => s.pendingExecuteApprovals);
  const order = useStore((s) => s.pendingExecuteApprovalOrder);
  const fleetViewVisible = useStore((s) => s.fleetViewVisible);
  const fleetActiveTab = useStore((s) => s.fleetActiveTab);
  const inboxOwns =
    inboxOwnsApprovalsProp ?? selectInboxOwnsApprovals({ fleetViewVisible, fleetActiveTab });
  const resolved =
    records ?? order.map((id) => pending[id]).filter((r): r is NonNullable<typeof r> => !!r);
  const deadlineAt = soonestApprovalDeadline(approvalsForWorkspace(resolved, workspaceId));
  const clock = nowProp ?? Date.now;
  const [now, setNow] = useState(() => clock());

  // One 1 s tick, and only while a deadline exists AND has not passed — the
  // deck re-renders on every streamed token as it is, and a timer that keeps
  // running past the deadline would add a second render loop to a surface that
  // has nothing left to say.
  useEffect(() => {
    // No deadline, or the inbox owns the prompt and this badge renders nothing
    // — either way there is nothing for a 1 s timer to update. The effect
    // re-runs (and re-reads the clock) the moment either changes back.
    if (deadlineAt === null || inboxOwns) return;
    setNow(clock());
    if (clock() >= deadlineAt) return;
    const timer = setInterval(() => {
      const tick = clock();
      setNow(tick);
      if (tick >= deadlineAt) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
    // `clock` is deliberately NOT a dependency: it is a test seam, stable in
    // the app, and re-running on it would restart the interval on every render
    // of a parent that inlines the prop.
  }, [deadlineAt, inboxOwns]);

  if (deadlineAt === null) return null;
  // The inbox is on screen with its own countdown per row — two renditions
  // already (the dialog is suppressed for the same reason, AppLayout).
  if (inboxOwns) return null;
  const remainingMs = deadlineAt - now;
  // The deadline passed: the auto-reject has fired (or is firing) and the
  // record is on its way out of the queue. "Auto-reject in 0s" parked forever
  // is the badge outliving the thing it describes.
  if (remainingMs <= 0) return null;
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
