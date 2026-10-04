// "Remember this?": Moa's one pending memory card (moaMemory.ts in main).
//
// It is Moa's, not the viewed workspace's, so it shows wherever the deck is
// open. Save writes exactly the text in the full-text view, so a text longer
// than the preview has to be opened before Save is offered. Only Save and
// Discard exist here: no free-text answer. Re-read whenever main says Moa
// moved (a card went up, was answered, or the next one replaced it).
//
// Same needs-you grammar as the decision card (content-20% fill, dashed
// content-30% border, the amber eyebrow as its one state mark).

import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { MoaMemoryCard as MoaMemoryCardData } from '../../../shared/moa';

export interface MoaMemoryCardApi {
  memoryCard: () => Promise<{ card: MoaMemoryCardData | null }>;
  memoryResolve: (args: { id: string; answer: 'save' | 'discard'; fullTextShown: boolean }) => Promise<{ ok: boolean; code?: string }>;
  onChanged: (cb: () => void) => () => void;
}

/** What the collapsed card shows of the full text. */
export const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 480;

export function previewOf(fullText: string): { text: string; complete: boolean } {
  const lines = fullText.trimEnd().split('\n');
  let text = lines.slice(0, PREVIEW_LINES).join('\n');
  if (text.length > PREVIEW_CHARS) text = text.slice(0, PREVIEW_CHARS);
  return { text, complete: text === fullText.trimEnd() };
}

const BUTTON = `h-[26px] px-2 rounded-md text-[12px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`;

export function MoaMemoryCard({
  api: apiProp,
  onPendingChange,
  className,
  t,
}: {
  api?: MoaMemoryCardApi;
  /** Classes for a wrapper drawn only while a card is up (layout spacing). */
  className?: string;
  /** Told whether a card is on screen (the collapsed rail's header badge). */
  onPendingChange?: (pending: boolean) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): React.ReactElement | null {
  const api =
    apiProp ??
    (window.electronAPI as unknown as { deck?: { moa?: Partial<MoaMemoryCardApi> } } | undefined)?.deck?.moa;
  const ready = !!api?.memoryCard && !!api.memoryResolve && !!api.onChanged;
  const [card, setCard] = useState<MoaMemoryCardData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const shownId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ready) return;
    const mine = ++seq.current;
    try {
      const r = await api!.memoryCard!();
      if (mine !== seq.current) return;
      const id = r.card?.id ?? null;
      if (shownId.current !== id) {
        // A different card: start it collapsed, with no stale error.
        shownId.current = id;
        setExpanded(false);
        setFailed(false);
      }
      setCard(r.card);
    } catch {
      /* main gone: keep what is shown */
    }
  }, [api, ready]);

  useEffect(() => {
    void refresh();
    if (!ready) return;
    return api!.onChanged!(() => void refresh());
  }, [api, ready, refresh]);

  const pending = card !== null;
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  if (!card) return null;

  const preview = previewOf(card.fullText);
  const mustOpen = !preview.complete && !expanded;
  const answer = async (choice: 'save' | 'discard'): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setFailed(false);
    try {
      const r = await api!.memoryResolve!({ id: card.id, answer: choice, fullTextShown: preview.complete || expanded });
      if (r.ok || r.code === 'not_pending') setCard(null);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
      void refresh();
    }
  };

  const fullId = `moa-memory-full-${card.id}`;
  const body = (
    <div
      data-moa-memory-card={card.id}
      className="flex flex-col min-h-0 max-h-full rounded-md px-4 py-3 space-y-2.5 border border-dashed border-[color-mix(in_srgb,var(--text-main)_30%,transparent)] bg-[color-mix(in_srgb,var(--text-main)_20%,transparent)]"
    >
      <div className="text-[11px] font-mono uppercase tracking-wider text-[var(--accent-yellow)]" {...tokenAttrs('warning', 'text')}>
        {t('moa.memoryCard.eyebrow')}
      </div>
      <div className="text-[13px] font-semibold text-[var(--text-main)] leading-relaxed" {...tokenAttrs('textMain', 'text')}>
        {card.question}
      </div>
      <div className="text-[12px] text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] leading-relaxed">
        {card.description}
      </div>
      {/* The text Save writes, as plain text: data, never markup. */}
      <pre
        id={fullId}
        data-moa-memory-text={expanded ? 'full' : 'preview'}
        tabIndex={expanded ? 0 : undefined}
        className={`m-0 rounded-md border border-[var(--line)] bg-[var(--bg-base)] px-2.5 py-2 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words text-[var(--text-main)] ${expanded ? 'min-h-[6em] max-h-[50vh] flex-1 overflow-auto' : 'shrink-0 max-h-[9.5em] overflow-hidden'}`}
        {...tokenAttrs('textMain', 'text')}
      >
        {expanded ? card.fullText.trimEnd() : preview.text}
        {!expanded && !preview.complete ? '\n…' : ''}
      </pre>
      {!preview.complete && (
        <button
          type="button"
          data-moa-memory-toggle
          aria-expanded={expanded}
          aria-controls={fullId}
          onClick={() => setExpanded((v) => !v)}
          className={`${BUTTON} self-start shrink-0 text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] hover:text-[var(--text-main)]`}
        >
          {expanded ? t('moa.memoryCard.hideFull') : t('moa.memoryCard.showFull', { chars: card.fullText.length })}
        </button>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-moa-memory-save
          disabled={submitting || mustOpen}
          onClick={() => void answer('save')}
          className={`${BUTTON} font-medium bg-[var(--primary-fill)] text-[var(--primary-ink)] hover:bg-[color-mix(in_srgb,var(--primary-fill)_90%,transparent)]`}
        >
          {t('moa.memoryCard.save')}
        </button>
        <button
          type="button"
          data-moa-memory-discard
          disabled={submitting}
          onClick={() => void answer('discard')}
          className={`${BUTTON} text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] bg-[var(--selection)] hover:bg-[var(--selection-hover)] hover:text-[var(--text-main)]`}
        >
          {t('moa.memoryCard.discard')}
        </button>
        {mustOpen && (
          <span className="text-[11px] text-[color-mix(in_srgb,var(--text-main)_60%,transparent)]">
            {t('moa.memoryCard.readToSave')}
          </span>
        )}
      </div>
      {failed && (
        <p role="alert" className="m-0 text-[11px] text-[var(--accent-red)]" {...tokenAttrs('danger', 'text')}>
          {t('moa.memoryCard.failed')}
        </p>
      )}
    </div>
  );
  return className ? <div className={className}>{body}</div> : body;
}
