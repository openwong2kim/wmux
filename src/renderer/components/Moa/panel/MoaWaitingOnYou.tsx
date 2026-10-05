// "Waiting on you": every workspace's pending decision, answerable in place,
// with Moa's own "Remember this?" card (MoaMemoryCard) as the first row.
// A decision is the one thing on screen waiting on the operator, so each row
// wears the needs-you grammar (content-20% fill, dashed content-30% border,
// the yellow eyebrow as its one state mark). Answers go to the decision's own
// workspace, not to Moa's.
import { useEffect, useRef, useState } from 'react';
import type { MoaPendingDecision } from '../../../../shared/moa';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import { FOCUS_RING } from '../../focusRing';
import { MoaMemoryCard, type MoaMemoryCardApi } from '../MoaMemoryCard';
import { MoaHandoffCard, type HandoffResolve } from './MoaHandoffCard';

export type ResolveDecision = (args: { workspaceId: string; id: string; resolution: string; dismiss?: boolean }) => Promise<{ ok: boolean; code?: string }>;

/** Main's refusal for a decision that is no longer pending: it was answered
 *  elsewhere (the phone, another window) a moment before this click. */
export function answeredElsewhere(r: { ok: boolean; code?: string }): boolean {
  return !r.ok && r.code === 'not_pending';
}

export const NEEDS_YOU_ROW =
  'rounded-[10px] px-3 py-2.5 border border-dashed border-[color-mix(in_srgb,var(--text-main)_30%,transparent)] bg-[color-mix(in_srgb,var(--text-main)_20%,transparent)]';

export function MoaWaitingOnYou({
  decisions,
  onResolve,
  memoryApi,
  handoffResolve,
  conversationTaskId,
  onOpenConversation,
  t,
}: {
  decisions: readonly MoaPendingDecision[];
  /** The fan-out task (WorkTask id) a workspace runs, when it is one. */
  conversationTaskId?: (workspaceId: string) => string | undefined;
  /** Show that task's conversation in Fleet. */
  onOpenConversation?: (taskId: string) => void;
  onResolve: ResolveDecision;
  /** Injected in tests; the card defaults to the preload. */
  memoryApi?: MoaMemoryCardApi;
  /** Answers a hand-off card; defaults to the preload. */
  handoffResolve?: HandoffResolve;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): React.ReactElement | null {
  // The memory card fetches its own card (and re-reads on DECK_MOA_CHANGED),
  // so it stays mounted; it says here whether one is up.
  const [memoryPending, setMemoryPending] = useState(false);
  // Answered rows leave at once; main's change signal confirms it moments later.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // After an answer removes a row, focus goes to the row that took its place
  // (or the heading) instead of dropping to the page.
  const refocusAt = useRef<number | null>(null);
  const visible = decisions.filter((d) => !answered.has(d.decision.id));

  useEffect(() => {
    // Forget ids main no longer reports, so a re-raised id shows again.
    setAnswered((prev) => {
      const live = new Set(decisions.map((d) => d.decision.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [decisions]);

  useEffect(() => {
    const at = refocusAt.current;
    if (at === null) return;
    refocusAt.current = null;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-moa-decision]');
    const target = rows && rows.length > 0 ? rows[Math.min(at, rows.length - 1)].querySelector<HTMLElement>('button, input') : null;
    (target ?? headingRef.current)?.focus();
  });

  // Nothing waiting: no heading, no "0" (no dead gauges). The section stays
  // mounted (hidden) only so the memory card can learn of a new card.
  const total = visible.length + (memoryPending ? 1 : 0);

  const resolve = async (d: MoaPendingDecision, resolution: string, dismiss = false): Promise<boolean> => {
    const text = resolution.trim();
    if (!text && !dismiss) return false;
    try {
      const r = await onResolve({ workspaceId: d.workspaceId, id: d.decision.id, resolution: text, ...(dismiss ? { dismiss: true } : {}) });
      // Already answered elsewhere: the row is stale, not failed, so it leaves
      // like an answered one and shows no error.
      if (!r.ok && !answeredElsewhere(r)) return false;
    } catch {
      return false;
    }
    markAnswered(d);
    return true;
  };

  // A row leaves: focus moves to its neighbour, or to the panel's top region.
  const markAnswered = (d: MoaPendingDecision) => {
    if (total === 1) {
      // The last one: the section goes away, so focus moves to the panel's
      // top region (it is focusable for exactly this) rather than the page.
      listRef.current?.closest<HTMLElement>('[data-moa-panel-top]')?.focus();
    } else {
      refocusAt.current = visible.findIndex((v) => v.decision.id === d.decision.id);
    }
    setAnswered((prev) => new Set(prev).add(d.decision.id));
  };

  return (
    <section data-moa-waiting aria-labelledby="moa-waiting-title" className={total === 0 ? 'hidden' : 'px-3 pt-2 pb-1 flex flex-col gap-1.5'}>
      <h3
        id="moa-waiting-title"
        ref={headingRef}
        tabIndex={-1}
        className="m-0 text-[13px] font-medium text-[var(--text-main)] outline-none"
      >
        {t('moa.panel.waitingTitle')}{' '}
        <span className="tabular-nums text-[var(--accent-yellow)]">{total}</span>
      </h3>
      <ul ref={listRef} className="m-0 p-0 list-none flex flex-col gap-1.5">
        <li data-moa-memory-row className={memoryPending ? 'flex flex-col min-h-0' : 'hidden'}>
          <MoaMemoryCard api={memoryApi} onPendingChange={setMemoryPending} t={t} />
        </li>
        {visible.map((d) => d.handoff ? (
          <MoaHandoffCard
            key={d.decision.id}
            item={d}
            handoff={d.handoff}
            resolve={handoffResolve}
            onDone={() => markAnswered(d)}
            t={t}
          />
        ) : (
          <DecisionRow
            key={d.decision.id}
            item={d}
            onAnswer={(text) => resolve(d, text)}
            onDismiss={d.dismissible ? () => resolve(d, '', true) : undefined}
            conversationTaskId={onOpenConversation ? conversationTaskId?.(d.workspaceId) : undefined}
            onOpenConversation={onOpenConversation}
            t={t}
          />
        ))}
      </ul>
    </section>
  );
}

function DecisionRow({
  item,
  onAnswer,
  onDismiss,
  conversationTaskId,
  onOpenConversation,
  t,
}: {
  item: MoaPendingDecision;
  onAnswer: (text: string) => Promise<boolean>;
  /** "Not needed": close the card without choosing; absent when not allowed. */
  onDismiss?: () => Promise<boolean>;
  conversationTaskId?: string;
  onOpenConversation?: (taskId: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): React.ReactElement {
  const { decision } = item;
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState(false);
  const answer = async (text: string, dismiss = false) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = dismiss && onDismiss ? await onDismiss() : await onAnswer(text);
    // A successful answer unmounts this row; only a failure is still here.
    if (!ok) {
      setBusy(false);
      setFailed(true);
    }
  };
  const questionId = `moa-decision-${decision.id}`;
  return (
    <li data-moa-decision={decision.id} data-workspace-id={item.workspaceId} className={NEEDS_YOU_ROW}>
      <div className="text-[11px] text-[var(--accent-yellow)] truncate">
        {item.workspaceName || t('moa.panel.unknownWorkspace')}
      </div>
      <p id={questionId} className="m-0 mt-0.5 text-[13px] font-medium leading-snug text-[var(--text-main)] break-words">
        {decision.question}
      </p>
      {decision.context && (
        <p className="m-0 mt-0.5 text-[11px] leading-snug text-[var(--text-sub)] break-words">{decision.context}</p>
      )}
      {decision.options.length > 0 ? (
        // Stacked, full width: an answer of any length wraps inside its own
        // button at any dock width, never clipped by its neighbour.
        <div role="group" aria-labelledby={questionId} className="flex flex-col gap-1.5 mt-2">
          {decision.options.map((opt) => (
            <Button key={opt} variant="secondary" size="sm" disabled={busy} data-moa-decision-option onClick={() => void answer(opt)}
              className="w-full !h-auto !justify-start !whitespace-normal !py-1.5 text-left break-words">
              {opt}
            </Button>
          ))}
        </div>
      ) : (
        <form
          className="flex items-center gap-1.5 mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            void answer(draft);
          }}
        >
          <Input
            data-moa-decision-input
            aria-labelledby={questionId}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('moa.panel.answerPlaceholder')}
            className="flex-1 min-w-0 h-[26px] text-[12px]"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={busy || !draft.trim()} data-moa-decision-send>
            {t('moa.panel.answerSend')}
          </Button>
        </form>
      )}
      {onDismiss && (
        <Button variant="ghost" size="sm" disabled={busy} data-moa-decision-dismiss onClick={() => void answer('', true)}
          className="mt-1.5">
          {t('moa.panel.dismiss')}
        </Button>
      )}
      {conversationTaskId && (
        <button
          type="button"
          onClick={() => onOpenConversation?.(conversationTaskId)}
          className={`mt-1.5 text-[11px] text-[var(--accent)] hover:underline underline-offset-2 ${FOCUS_RING}`}
          data-moa-decision-conversation
        >
          {t('moa.panel.openConversation')}
        </button>
      )}
      {failed && (
        <p role="alert" className="m-0 mt-1.5 text-[11px] text-[var(--accent-red)]">{t('moa.panel.answerFailed')}</p>
      )}
    </li>
  );
}
