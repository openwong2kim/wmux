// ─── Command Deck — decision gate card (M1) ──────────────────────────────────
//
// The human's side of the brain-raised decision gate. When the orchestrator
// calls deck_ask_decision it PAUSES its loop and persists a pending decision
// (deckDecisionStore); this card surfaces that decision in the deck thread —
// including after an app restart or reboot, because it hydrates from the durable
// store on mount. Answering it (an option button or free text) resolves the
// decision, un-blocks the loop, and the brain resumes from where it paused.
//
// Self-contained (the DeckLoopPanel pattern): all IPC goes through the injected
// `api` / `onStream` props (defaulting to window.electronAPI.deck.*), so it
// unit-tests under jsdom with fakes and zero store wiring. Renders nothing when
// there is no PENDING decision (or the preload is absent).
//
// Amber leads the card (DESIGN.md: amber = alive + focus) — a pending decision
// is the one thing on screen actively waiting on the operator. The action
// buttons stay neutral→blue like the rest of the deck to keep the amber budget.

import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { WorkspaceDecision } from '../../../main/deck/deckDecisionStore';

export interface DeckDecisionApi {
  get: (workspaceId: string) => Promise<{ decision: WorkspaceDecision | null }>;
  resolve: (args: { workspaceId: string; id: string; resolution: string }) => Promise<{
    ok: boolean;
    code?: string;
    decision?: WorkspaceDecision;
  }>;
}

/** The deck event stream — subscribed only to trigger a refetch when the brain
 *  raises/resolves a decision mid-session (event payload is not inspected). */
export type DeckDecisionStream = (
  cb: (env: { workspaceId: string; event: unknown }) => void,
) => () => void;

export function DeckDecisionCard({
  api,
  onStream,
  workspaceId,
  onPendingChange,
  t: tProp,
}: {
  api?: DeckDecisionApi;
  onStream?: DeckDecisionStream;
  /** The workspace this deck view is bound to — the decision is per-workspace. */
  workspaceId?: string;
  /** Told whether a PENDING decision is on screen. The dock's report rail is
   *  collapsed by default, so its header has to say a decision is waiting even
   *  though the card itself is hidden inside the rail body. */
  onPendingChange?: (pending: boolean) => void;
  t?: (key: string) => string;
}): React.ReactElement | null {
  const t = tProp ?? (() => '');
  const resolvedApi =
    api ??
    (window.electronAPI as unknown as { deck?: { decision?: DeckDecisionApi } } | undefined)?.deck
      ?.decision;
  const resolvedStream =
    onStream ??
    (window.electronAPI as unknown as { deck?: { onStream?: DeckDecisionStream } } | undefined)
      ?.deck?.onStream;

  const [decision, setDecision] = useState<WorkspaceDecision | null>(null);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Monotonic request id: ignore a slow get() whose response lands after the
  // workspace changed (or after a newer get), so a stale response can't overwrite
  // the active workspace's card (3-way review — workspace-switch race).
  const reqSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!resolvedApi || !workspaceId) return;
    const seq = ++reqSeq.current;
    try {
      const r = await resolvedApi.get(workspaceId);
      if (seq !== reqSeq.current) return; // superseded by a newer request / ws switch
      setDecision(r.decision);
    } catch {
      /* main gone — leave the stale view */
    }
  }, [resolvedApi, workspaceId]);

  // Clear the card IMMEDIATELY on a workspace switch so the previous workspace's
  // decision never lingers while the new fetch is in flight, and bump reqSeq so
  // any in-flight get for the old workspace is ignored when it resolves.
  useEffect(() => {
    reqSeq.current++;
    setDecision(null);
    setAnswer('');
    setSubmitting(false);
  }, [workspaceId]);

  // Hydrate on mount + whenever the deck rebinds to another workspace. This is
  // the reboot-survival surface: the pending decision is on disk, so a fresh app
  // run shows it here on first mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Refetch (debounced) on any brain activity for this workspace, so a decision
  // raised or resolved mid-session reflects promptly without polling.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!resolvedStream || !workspaceId) return;
    const off = resolvedStream((env) => {
      if (env.workspaceId !== workspaceId) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void refresh(), 200);
    });
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      off();
    };
  }, [resolvedStream, workspaceId, refresh]);

  // Mirror "a decision is pending" out to the surrounding surface (the rail
  // header badge). An effect, not a render-time call, so the parent's state
  // update never happens during this component's render.
  const pending = !!resolvedApi && decision?.status === 'pending';
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  if (!resolvedApi) return null;
  // Only a PENDING decision blocks and needs the human; a resolved one is
  // transient (consumed by the resuming turn).
  if (!decision || decision.status !== 'pending') return null;

  const submit = async (resolution: string): Promise<void> => {
    const text = resolution.trim();
    if (!text || submitting || !workspaceId) return;
    setSubmitting(true);
    try {
      const r = await resolvedApi.resolve({ workspaceId, id: decision.id, resolution: text });
      if (r.ok) {
        setDecision(null); // optimistic — the resuming turn clears it server-side
        setAnswer('');
      }
    } catch {
      /* leave the card up so the human can retry */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-deck-decision
      className="rounded-[7px] px-4 py-3 space-y-2.5 border-l-2 border-[var(--accent-amber)] bg-[rgba(var(--bg-surface-rgb),0.55)]"
      {...tokenAttrs('bgSurface', 'bg')}
    >
      <div className="text-[11px] font-mono uppercase tracking-wider text-[var(--accent-amber)]">
        {t('deck.decisionEyebrow') || 'Decision needed'}
      </div>
      <div
        className="text-[13px] font-semibold text-[var(--text-main)] leading-relaxed"
        {...tokenAttrs('textMain', 'text')}
      >
        {decision.question}
      </div>
      {decision.context && (
        <div
          className="text-[11px] font-mono text-[var(--text-sub)] leading-relaxed"
          {...tokenAttrs('textSub', 'text')}
        >
          {decision.context}
        </div>
      )}
      {decision.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {decision.options.map((opt) => (
            <button
              key={opt}
              type="button"
              data-decision-option
              disabled={submitting}
              onClick={() => void submit(opt)}
              className={`px-2.5 py-1 rounded-[4px] text-[12px] font-semibold text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.8)] hover:text-[var(--accent-blue)] transition-colors disabled:opacity-40 ${FOCUS_RING}`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          data-decision-answer
          aria-label={t('deck.decisionAnswerLabel') || 'Your answer to the orchestrator decision'}
          value={answer}
          disabled={submitting}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit(answer);
          }}
          placeholder={t('deck.decisionPlaceholder') || 'Type your answer…'}
          className="flex-1 min-w-0 px-2 py-1 rounded-[4px] text-[12px] bg-[rgba(var(--bg-surface-rgb),0.8)] text-[var(--text-main)] outline-none"
          {...tokenAttrs('textMain', 'text')}
        />
        <button
          type="button"
          data-decision-resolve
          disabled={submitting || !answer.trim()}
          onClick={() => void submit(answer)}
          className={`px-2.5 py-1 rounded-[4px] text-[12px] font-semibold text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.8)] hover:text-[var(--accent-blue)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`}
        >
          {t('deck.decisionResolve') || 'Resolve'}
        </button>
      </div>
    </div>
  );
}
