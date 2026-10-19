// The Fleet approvals tab's Plan cards: Claude's ExitPlanMode dialogs, with
// the plan itself and the plan form's actions exactly as the daemon read them
// off the dialog (shared/planApproval.ts). An answer goes through the daemon's
// own checks; a dialog the daemon could not bind carries no actions, and its
// card only points at the pane. Agent text is rendered as text, never markup.
import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import { renderBrainMarkdown } from '../shared/BrainMarkdown';
import Button from '../ui/Button';
import Input from '../ui/Input';
import type { PlanApprovalAction, PlanApprovalAnswerResult, PlanApprovalView } from '../../../shared/planApproval';

/** Most characters the feedback field takes (the daemon's own answer-text limit). */
const FEEDBACK_MAX = 2000;

type T = ReturnType<typeof useT>;

/** The sentence a refused answer shows. Nothing was typed in any of these cases. */
export function planRefusalText(result: Extract<PlanApprovalAnswerResult, { ok: false }>, t: T): string {
  switch (result.reason) {
    case 'prompt-changed':
    case 'prompt-gone':
    case 'already-answered':
    case 'already-resolved':
    case 'expired':
    case 'not-found':
      return t('fleet.plan.refusedChanged');
    case 'answer-too-soon':
      return t('fleet.plan.refusedTooSoon');
    case 'invalid-text':
      return t('fleet.plan.refusedText');
    case 'answer-in-terminal':
      return t('fleet.plan.inTerminal');
    default:
      return t('fleet.plan.refused', { reason: result.reason });
  }
}

/** The one primary action: the first action that takes no text. */
export function primaryPlanAction(actions: readonly PlanApprovalAction[]): PlanApprovalAction | undefined {
  return actions.find((a) => !a.needsText);
}

function PlanCard({ plan }: { plan: PlanApprovalView }) {
  const t = useT();
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const primary = primaryPlanAction(plan.actions);
  const textAction = plan.actions.find((a) => a.needsText);

  const send = (action: PlanApprovalAction): void => {
    const api = window.electronAPI?.planApprovals;
    if (!api || !plan.formFingerprint || busy) return;
    setBusy(true);
    setNote(null);
    const text = action.needsText && feedback.trim() !== '' ? feedback : undefined;
    void api.answer({ id: plan.id, formFingerprint: plan.formFingerprint, action: action.id, ...(text !== undefined ? { text } : {}) })
      .then((result) => {
        if (result.ok) {
          setFeedback('');
          setNote(t('fleet.plan.sent'));
        } else {
          setNote(planRefusalText(result, t));
        }
      })
      .catch(() => setNote(t('fleet.plan.refused', { reason: 'unavailable' })))
      .finally(() => setBusy(false));
  };

  const jump = (): void => {
    focusNotificationTarget(() => useStore.getState(), { ptyId: plan.sessionId, workspaceId: plan.workspaceId ?? null });
    useStore.getState().setFleetViewVisible(false);
  };

  const canAnswer = plan.actions.length > 0 && !plan.answered && !plan.stopped && !!plan.formFingerprint;
  return (
    <div
      data-plan-card
      data-plan-session={plan.sessionId}
      tabIndex={-1}
      className="flex flex-col gap-2 px-3 py-2.5"
      style={{
        // A request that waits on you (DESIGN.md colour grammar): the
        // attention hairline over the fill one step below selection.
        backgroundColor: 'var(--selection-subtle)',
        border: '1px solid var(--attention-hairline)',
        borderRadius: 10,
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span aria-hidden="true" className="shrink-0 rounded-full" style={{ width: 6, height: 6, backgroundColor: 'var(--attention)' }} />
        <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-main)' }}>
          {t('fleet.plan.title')}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={jump}
          title={t('fleet.request.jump')}
          aria-label={t('fleet.request.jump')}
          className="px-2 py-1 text-xs rounded-md transition-colors hover:bg-[var(--hover-fill)]"
          style={{ color: 'var(--text-main)', minWidth: 24, minHeight: 24 }}
        >
          →
        </button>
      </div>

      {plan.plan !== undefined ? (
        <div
          data-plan-text
          tabIndex={0}
          aria-label={t('fleet.plan.title')}
          className="text-[13px] break-words"
          style={{ color: 'var(--text-sub)', maxHeight: 320, overflowY: 'auto' }}
        >
          {renderBrainMarkdown(plan.plan)}
        </div>
      ) : plan.summary ? (
        <p data-plan-text className="text-[13px] break-words" style={{ color: 'var(--text-sub)' }}>{plan.summary}</p>
      ) : null}
      {plan.planTruncated && (
        <p className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>{t('fleet.plan.truncated')}</p>
      )}

      {canAnswer ? (
        <div className="flex flex-wrap items-center gap-2">
          {textAction && (
            <>
              <Input
                value={feedback}
                onChange={(e) => setFeedback(e.currentTarget.value)}
                onKeyDown={(e) => {
                  // Enter sends the feedback; it must not reach the Fleet list's row keys.
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.stopPropagation();
                    send(textAction);
                  }
                }}
                maxLength={FEEDBACK_MAX}
                disabled={busy}
                placeholder={t('fleet.plan.feedbackPlaceholder')}
                aria-label={t('fleet.plan.feedbackLabel')}
                className="flex-1 min-w-[160px] text-xs"
              />
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => send(textAction)} data-plan-action={textAction.id}>
                {textAction.label}
              </Button>
            </>
          )}
          {plan.actions.filter((a) => !a.needsText).map((a) => (
            <Button
              key={a.id}
              variant={a === primary ? 'primary' : 'secondary'}
              size="sm"
              disabled={busy}
              onClick={() => send(a)}
              data-plan-action={a.id}
            >
              {a.label}
            </Button>
          ))}
        </div>
      ) : (
        <p data-plan-unavailable className="text-xs" style={{ color: 'var(--text-subtle)' }}>
          {plan.stopped ? t('fleet.plan.stopped') : plan.answered ? t('fleet.plan.sent') : t('fleet.plan.inTerminal')}
        </p>
      )}
      {note && canAnswer && (
        <p role="status" className="text-xs" style={{ color: 'var(--text-sub)' }}>{note}</p>
      )}
    </div>
  );
}

export default function PlanApprovalList({ plans }: { plans: readonly PlanApprovalView[] }) {
  if (plans.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 mb-2" data-plan-approvals>
      {plans.map((plan) => <PlanCard key={plan.id} plan={plan} />)}
    </div>
  );
}
