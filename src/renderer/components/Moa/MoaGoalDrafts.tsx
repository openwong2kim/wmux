// Learning-loop goal drafts (moaGoalLearning.ts): a failure seen twice
// becomes a proposed regression-test goal. Approve turns it into a goal (the
// operator's approval); Dismiss drops it for good. Used by the goal strip and
// Settings › Moa.
import { useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';

export function MoaGoalDrafts({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const drafts = useStore((s) => s.moa?.learning?.drafts ?? []);
  const refreshMoa = useStore((s) => s.refreshMoa);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (drafts.length === 0) return null;
  const answer = async (id: string, a: 'approve' | 'dismiss') => {
    setBusy(id);
    setFailed(null);
    try {
      const r = await window.electronAPI.deck?.moa?.answerDraft(id, a);
      if (!r?.ok) setFailed(r?.code ?? 'error');
    } catch {
      setFailed('error');
    } finally {
      setBusy(null);
      await refreshMoa();
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="moa-goal-drafts">
      {drafts.map((d) => (
        <div key={d.id} data-testid="moa-goal-draft" data-draft-id={d.id} className="text-[11px] leading-snug">
          <div className="font-semibold text-[var(--text-main)]">{t('moa.drafts.title', { n: d.seen })}</div>
          <div className={compact ? 'truncate' : ''} title={d.goal}>{d.goal}</div>
          {!compact && (
            <ol className="m-0 mt-0.5 pl-4">
              {d.doneCriteria.map((c) => <li key={c}>{c}</li>)}
            </ol>
          )}
          <div className="mt-1 flex gap-2">
            <button type="button" className="underline" disabled={busy !== null} onClick={() => { void answer(d.id, 'approve'); }} data-testid="moa-goal-draft-approve">
              {t('moa.drafts.approve')}
            </button>
            <button type="button" className="underline" disabled={busy !== null} onClick={() => { void answer(d.id, 'dismiss'); }} data-testid="moa-goal-draft-dismiss">
              {t('moa.drafts.dismiss')}
            </button>
          </div>
        </div>
      ))}
      {failed && <div role="alert" data-testid="moa-goal-draft-failed">{t('moa.drafts.failed', { code: failed })}</div>}
    </div>
  );
}
