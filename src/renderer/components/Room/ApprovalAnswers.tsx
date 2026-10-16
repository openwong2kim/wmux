// ─── The owner's answers to a bot's approval request ───────────────────────
//
// Under an `approval` card (the room dock and a Bots conversation alike),
// from the request main holds (approvalsStore.ts), never from the card's
// text: while it waits, Deny, Always allow (not for a release or a push to a
// default branch) and Approve — the one primary, with one muted line under
// them when a rule made from it could not merge by itself here (what it still
// needs); once a merge is approved,
// the seconds left with Undo; then what happened (merged, or why not, in
// main's words and never its code — a new head needs a new request). "Started from outside text" says the bot's wake
// carried an issue's or a PR's words. Every answer goes to main
// (BOT_APPROVAL_IPC.decide), which decides whether it counts.
import { useEffect, useState } from 'react';
import type { ApprovalRuleNeed } from '../../../shared/botApproval';
import type { RoomCard as RoomCardData } from '../../../shared/room';
import Button from '../ui/Button';
import { FOCUS_RING } from '../focusRing';
import { approvalPhase, approvalsApi, refreshApprovals, useApprovals, type ApprovalsApi } from './approvalsStore';

type T = (key: string, vars?: Record<string, string | number>) => string;

const RULE_NEEDS: readonly ApprovalRuleNeed[] = ['verifier', 'noChecks', 'author'];

export function ApprovalAnswers({ card, t, api, readOnly = false, now }: {
  card: RoomCardData;
  t: T;
  /** Tests: the approvals bridge. */
  api?: ApprovalsApi | null;
  /** The bots are paused: the state shows, nothing is answered. */
  readOnly?: boolean;
  now?: number;
}): React.ReactElement | null {
  const { byId } = useApprovals();
  const id = card.refs?.approvalId;
  const req = id ? byId.get(id) : undefined;
  const [tick, setTick] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = now ?? tick;
  const phase = approvalPhase(req, at);
  // The Undo countdown ticks once a second while it shows.
  useEffect(() => {
    if (phase.phase !== 'undo' || now !== undefined) return undefined;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase.phase, now]);
  if (!id) return null;
  const bridge = api === undefined ? approvalsApi() : api;
  const decide = async (decision: 'approve' | 'deny' | 'undo' | 'always') => {
    if (!bridge || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await bridge.decide({ requestId: id, decision });
      if (!r.ok) setError(r.message);
      await refreshApprovals();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const canAnswer = !!bridge && !readOnly;
  // What an "always allow" rule from this request would still lack here.
  const needs = (req?.ruleNeeds ?? []).filter((n) => RULE_NEEDS.includes(n));
  return (
    <div data-approval-answers={id} data-approval-phase={phase.phase} className="mt-1.5 flex flex-col gap-1">
      {req?.tainted && (
        <p data-approval-outside className="text-[11px] text-[var(--text-muted)]">{t('room.approval.outside')}</p>
      )}
      {phase.phase === 'pending' && req?.ruleSkipped && (req.ruleSkippedCondition || req.ruleSkippedText?.trim()) && (
        <p data-approval-rule-skipped className="text-[11px] text-[var(--text-muted)]">
          {t('room.approval.ruleSkipped', {
            reason: req.ruleSkippedCondition
              ? t(`room.approval.ruleCondition.${req.ruleSkippedCondition}`, { sha: (req.headSha ?? '').slice(0, 7) })
              : (req.ruleSkippedText ?? '').trim(),
          })}
        </p>
      )}
      {phase.phase === 'pending' && canAnswer && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="secondary" data-testid="approval-deny" disabled={busy} onClick={() => void decide('deny')}>{t('room.approval.deny')}</Button>
          {phase.canAlways && (
            <Button size="sm" variant="secondary" data-testid="approval-always" disabled={busy} title={t('room.approval.alwaysTitle')} onClick={() => void decide('always')}>
              {t('room.approval.always')}
            </Button>
          )}
          <Button size="sm" variant="primary" data-testid="approval-approve" disabled={busy} onClick={() => void decide('approve')}>{t('room.approval.approve')}</Button>
        </div>
      )}
      {phase.phase === 'pending' && canAnswer && phase.canAlways && !req?.ruleSkipped && needs.length > 0 && (
        <p data-approval-rule-needs className="text-[11px] text-[var(--text-muted)]">
          {t('room.approval.ruleNeeds', { needs: needs.map((n) => t(`room.approval.ruleNeed.${n}`)).join(t('room.approval.ruleNeedsJoin')) })}
        </p>
      )}
      {phase.phase === 'undo' && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-sub)]">
          <span data-approval-countdown className="tabular-nums">{t('room.approval.mergingIn', { seconds: phase.secondsLeft })}</span>
          {canAnswer && <Button size="sm" variant="secondary" data-testid="approval-undo" disabled={busy} onClick={() => void decide('undo')}>{t('room.approval.undo')}</Button>}
        </div>
      )}
      {phase.phase === 'merging' && <p className="text-[12px] text-[var(--text-sub)]">{t('room.approval.merging')}</p>}
      {phase.phase === 'approved' && (
        <p className="text-[12px] text-[var(--text-sub)]">{t(phase.byRule ? 'room.approval.approvedByRule' : 'room.approval.approved')}{phase.recordedOnly ? ` · ${t('room.approval.recordedOnly')}` : ''}</p>
      )}
      {phase.phase === 'executed' && (
        <p className="text-[12px] text-[var(--accent-green)]">{t(phase.byRule ? 'room.approval.mergedByRule' : 'room.approval.merged')}</p>
      )}
      {phase.phase === 'refused' && (
        <p data-approval-refused className="text-[12px] text-[var(--accent-red)]">
          {phase.headMoved ? t('room.approval.headMoved') : phase.text ? t('room.approval.refused', { reason: phase.text }) : t('room.approval.notMerged')}
        </p>
      )}
      {phase.phase === 'denied' && <p className="text-[12px] text-[var(--text-muted)]">{t('room.approval.denied')}</p>}
      {phase.phase === 'expired' && <p className="text-[12px] text-[var(--text-muted)]">{t('room.approval.expired')}</p>}
      {error && <p role="alert" className="text-[11px] text-[var(--accent-red)]">{error}</p>}
    </div>
  );
}

/** The composer's "Approve N pending" chip: approves, through main, the
 *  pending requests the conversation shows in this thread. */
export function ApprovePendingChip({ ids, t, api }: { ids: readonly string[]; t: T; api?: ApprovalsApi | null }): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  const bridge = api === undefined ? approvalsApi() : api;
  if (!bridge || ids.length === 0) return null;
  const approveAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (const requestId of ids) await bridge.decide({ requestId, decision: 'approve' });
      await refreshApprovals();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      data-testid="approve-pending-chip"
      data-approve-ids={ids.join(' ')}
      disabled={busy}
      onClick={() => void approveAll()}
      className={`h-[26px] self-start px-2.5 rounded-[var(--chip-radius)] bg-[var(--selection)] text-[12px] text-[var(--text-main)] hover:bg-[var(--selection-hover)] disabled:opacity-60 ${FOCUS_RING}`}
    >
      {ids.length === 1 ? t('room.approval.chipOne') : t('room.approval.chip', { count: ids.length })}
    </button>
  );
}
