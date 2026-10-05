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

/**
 * The card in plain words. The proposal file starts with frontmatter (name,
 * description, kind) and markers that are for Moa, not the operator: they are
 * left out. A precedent (main writes it from the operator's own answer) reads
 * as one sentence, its question and answer; any other proposal shows its body.
 */
export function plainMemory(card: Pick<MoaMemoryCardData, 'kind' | 'fullText'>):
  | { kind: 'precedent'; question: string; answer: string }
  | { kind: 'text'; text: string } {
  let body = card.fullText.replace(/\r\n/g, '\n');
  const front = /^---\n[\s\S]*?\n---\n?/.exec(body);
  if (front) body = body.slice(front[0].length);
  body = body.split('\n').filter((line) => !/^\s*<!--.*-->\s*$/.test(line)).join('\n').trim();
  if (card.kind === 'precedent') {
    // Whole fields, every line: Save keeps them, so the operator sees them all.
    const m = /(?:^|\n)Question:[ \t]*([\s\S]*?)\nAnswer:[ \t]*([\s\S]*?)(?:\nAnswered:[^\n]*)?(?:\nSource task:[^\n]*)?\s*$/.exec(body);
    const question = m?.[1]?.trim();
    const answer = m?.[2]?.trim();
    if (question && answer) return { kind: 'precedent', question, answer };
  }
  return { kind: 'text', text: body };
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

  const plain = plainMemory(card);
  const shownText = plain.kind === 'text' ? plain.text : '';
  const preview = plain.kind === 'text' ? previewOf(shownText) : { text: '', complete: true };
  const mustOpen = !preview.complete && !expanded;
  const title = t(card.kind === 'precedent' ? 'moa.memoryCard.precedentTitle' : card.kind === 'skill' ? 'moa.memoryCard.skillTitle' : 'moa.memoryCard.noteTitle')
    + (card.replaces ? ` ${t('moa.memoryCard.replaces')}` : '');
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
      className="flex flex-col rounded-md px-4 py-3 space-y-2.5 border border-dashed border-[color-mix(in_srgb,var(--text-main)_30%,transparent)] bg-[color-mix(in_srgb,var(--text-main)_20%,transparent)]"
    >
      {/* Yellow marks the state (the dot); amber text on this 20% wash read
          2.2:1 in light themes, so the words take the text colour. */}
      <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[var(--text-main)]" {...tokenAttrs('textMain', 'text')}>
        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[var(--accent-yellow)]" />
        {t('moa.memoryCard.eyebrow')}
      </div>
      <div className="text-[13px] font-semibold text-[var(--text-main)] leading-relaxed" {...tokenAttrs('textMain', 'text')}>
        {title}
      </div>
      {plain.kind === 'precedent' ? (
        <>
          {/* The operator's own answer and Moa's question: text, never markup. */}
          <p data-moa-memory-rule className="m-0 text-[13px] text-[var(--text-main)] leading-relaxed break-words whitespace-pre-wrap" {...tokenAttrs('textMain', 'text')}>
            {t('moa.memoryCard.precedentRule', { question: plain.question, answer: plain.answer })}
          </p>
          <p className="m-0 text-[12px] text-[color-mix(in_srgb,var(--text-main)_75%,transparent)] leading-relaxed">
            {t('moa.memoryCard.precedentNote')}
          </p>
        </>
      ) : (
        <>
          <div className="text-[12px] text-[color-mix(in_srgb,var(--text-main)_75%,transparent)] leading-relaxed">
            {card.description}
          </div>
          {/* What Save keeps, as plain text: data, never markup. */}
          <pre
            id={fullId}
            data-moa-memory-text={expanded ? 'full' : 'preview'}
            tabIndex={expanded ? 0 : undefined}
            className={`m-0 rounded-md border border-[var(--line)] bg-[var(--bg-base)] px-2.5 py-2 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words text-[var(--text-main)] shrink-0`}
            {...tokenAttrs('textMain', 'text')}
          >
            {expanded ? shownText : preview.text}
            {!expanded && !preview.complete ? '\n…' : ''}
          </pre>
        </>
      )}
      {!preview.complete && (
        <button
          type="button"
          data-moa-memory-toggle
          aria-expanded={expanded}
          aria-controls={fullId}
          onClick={() => setExpanded((v) => !v)}
          className={`${BUTTON} self-start shrink-0 text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] hover:text-[var(--text-main)]`}
        >
          {expanded ? t('moa.memoryCard.hideFull') : t('moa.memoryCard.showFull', { chars: shownText.length })}
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
          <span className="text-[12px] text-[color-mix(in_srgb,var(--text-main)_75%,transparent)]">
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
