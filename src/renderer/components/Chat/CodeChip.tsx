// Collapsed code block (plan PR-7, PRD §4.2).
//
// The wire event carries only {n, lang, lines, path} — the body is NEVER
// shipped (eng-review A3: a 256KB tail re-encoded with bodies overflows main's
// 1MB control buffer and drops unrelated daemon events). So the chip is the
// default rendition and the body is fetched on expand through `onFetchBody`.
// Collapsed-by-default is the G1 contract: a fresh Chat View shows zero code.

import React, { useCallback, useState } from 'react';
import type { CodeBlockRef } from '../../../shared/transcript/turnEvents';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';

export interface CodeChipProps {
  /** Parent event id — the fetch handle together with `block.n`. */
  eventId: string;
  block: CodeBlockRef;
  /** Resolves the block body on expand. Absent → the chip does not expand. */
  onFetchBody?: (eventId: string, n: number) => Promise<string>;
}

type Phase = 'collapsed' | 'loading' | 'ready' | 'error';

export function CodeChip({ eventId, block, onFetchBody }: CodeChipProps): React.ReactElement {
  const t = useT();
  const [phase, setPhase] = useState<Phase>('collapsed');
  const [body, setBody] = useState<string>('');

  const load = useCallback(async () => {
    if (!onFetchBody) return;
    setPhase('loading');
    try {
      const text = await onFetchBody(eventId, block.n);
      setBody(text);
      setPhase('ready');
    } catch {
      // The body lives in a file the daemon re-reads on demand; a failure is
      // ordinary (rotated transcript, daemon restart) and must stay recoverable.
      setPhase('error');
    }
  }, [onFetchBody, eventId, block.n]);

  const onToggle = useCallback(() => {
    if (phase === 'ready') {
      setPhase('collapsed');
      return;
    }
    if (phase === 'loading') return;
    void load();
  }, [phase, load]);

  const one = block.lines === 1;
  const label = block.path
    ? one
      ? t('chat.codeChipPathOne', { path: block.path })
      : t('chat.codeChipPath', { lines: block.lines, path: block.path })
    : one
      ? t('chat.codeChipOne')
      : t('chat.codeChip', { lines: block.lines });

  return (
    <span className="inline-flex flex-col align-top max-w-full" data-chat-code-chip={block.n}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!onFetchBody}
        aria-expanded={phase === 'ready'}
        title={block.lang ?? undefined}
        className={`self-start inline-flex items-baseline gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--accent-blue)] disabled:hover:text-[var(--text-muted)] transition-colors ${FOCUS_RING}`}
      >
        <span aria-hidden="true">⟨</span>
        <span>{label}</span>
        <span aria-hidden="true">⟩</span>
      </button>
      {phase === 'loading' && (
        <span className="text-[11px] font-mono text-[var(--text-muted)] pl-1.5" role="status">
          {t('chat.codeLoading')}
        </span>
      )}
      {phase === 'error' && (
        <span className="inline-flex items-baseline gap-2 pl-1.5">
          <span className="text-[11px] font-mono text-[var(--accent-red)]" role="alert">
            {t('chat.codeError')}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className={`text-[11px] font-mono text-[var(--accent-blue)] ${FOCUS_RING}`}
          >
            {t('chat.retry')}
          </button>
        </span>
      )}
      {phase === 'ready' && (
        <pre
          data-chat-code-body={block.n}
          className="mt-1 max-h-[320px] overflow-auto rounded-[6px] px-2 py-1.5 text-[11px] font-mono leading-relaxed text-[var(--text-sub)] whitespace-pre"
          style={{
            background: 'color-mix(in srgb, var(--bg-base) 92%, #000)',
            boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.22)',
          }}
        >
          {body}
        </pre>
      )}
    </span>
  );
}

export default CodeChip;
